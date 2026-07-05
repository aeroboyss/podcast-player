// Gemini API による要約＋4択クイズ生成。
// transcript があればテキストで、なければ音声を Files API にアップロードして生成する。

import { fetchBlobViaProxy } from './net.js';
import { pickTranscript, fetchTranscriptText } from './rss.js';

const API_BASE = 'https://generativelanguage.googleapis.com';
const MODEL = 'gemini-2.5-flash';
const MAX_TRANSCRIPT_CHARS = 200000;
const MAX_INLINE_AUDIO_BYTES = 15 * 1024 * 1024; // inline_data フォールバックの上限

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: {
      type: 'STRING',
      description: 'エピソード全体の要約。日本語で400〜600字。段落で構成する。',
    },
    keyPoints: {
      type: 'ARRAY',
      description: '重要ポイントの箇条書き（3〜6個、日本語）',
      items: { type: 'STRING' },
    },
    quiz: {
      type: 'ARRAY',
      minItems: 5,
      maxItems: 5,
      items: {
        type: 'OBJECT',
        properties: {
          question: { type: 'STRING', description: '設問（日本語）' },
          choices: {
            type: 'ARRAY',
            minItems: 4,
            maxItems: 4,
            items: { type: 'STRING' },
          },
          answerIndex: { type: 'INTEGER', description: '正解の選択肢の添字 (0-3)' },
          explanation: { type: 'STRING', description: '正解の解説（日本語）' },
        },
        required: ['question', 'choices', 'answerIndex', 'explanation'],
      },
    },
  },
  required: ['summary', 'keyPoints', 'quiz'],
};

function buildInstruction(show, episode) {
  return [
    `ポッドキャスト番組「${show.title}」のエピソード「${episode.title}」の内容を分析してください。`,
    '',
    '次の2つを日本語で作成してください（エピソードが日本語以外でも出力は日本語）：',
    '1. 内容の要約（400〜600字）と重要ポイントの箇条書き（3〜6個）',
    '2. 内容の理解度を確認する4択問題を5問。それぞれ選択肢4つ・正解1つ・解説付き。',
    '   - 誤答の選択肢もエピソードの文脈に沿ったもっともらしいものにすること',
    '   - 具体的な事実・主張・数字・結論など、聞いた人の理解を測れる問題にすること',
  ].join('\n');
}

async function callGenerate(apiKey, parts) {
  const res = await fetch(
    `${API_BASE}/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0.4,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    }
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = `Gemini API エラー (HTTP ${res.status})`;
    try {
      msg += ': ' + JSON.parse(body).error.message;
    } catch { /* 本文がJSONでなければステータスのみ */ }
    throw new Error(msg);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
  if (!text) {
    throw new Error('Gemini から結果を取得できませんでした: ' + JSON.stringify(data).slice(0, 300));
  }
  const parsed = JSON.parse(text);
  if (!parsed.summary || !Array.isArray(parsed.quiz) || parsed.quiz.length === 0) {
    throw new Error('生成結果の形式が不正でした。再試行してください。');
  }
  return parsed;
}

// ---- Files API（resumable upload） ----

async function uploadAudioFile(apiKey, blob, mimeType, onStatus) {
  const startRes = await fetch(`${API_BASE}/upload/v1beta/files?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(blob.size),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: 'podcast-episode' } }),
  });
  if (!startRes.ok) throw new Error(`アップロード開始に失敗 (HTTP ${startRes.status})`);
  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('アップロード URL を取得できませんでした');

  onStatus?.('音声をアップロード中…');
  const upRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
    },
    body: blob,
  });
  if (!upRes.ok) throw new Error(`アップロードに失敗 (HTTP ${upRes.status})`);
  let file = (await upRes.json()).file;

  // 処理完了 (ACTIVE) まで待つ
  const deadline = Date.now() + 5 * 60 * 1000;
  while (file.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new Error('音声の処理がタイムアウトしました');
    onStatus?.('Gemini 側で音声を処理中…');
    await new Promise((r) => setTimeout(r, 4000));
    const poll = await fetch(`${API_BASE}/v1beta/${file.name}?key=${encodeURIComponent(apiKey)}`);
    if (!poll.ok) throw new Error(`ファイル状態の確認に失敗 (HTTP ${poll.status})`);
    file = await poll.json();
  }
  if (file.state !== 'ACTIVE') {
    throw new Error(`音声ファイルを処理できませんでした (state: ${file.state})`);
  }
  return file;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function normalizeAudioMime(type) {
  const t = (type || '').split(';')[0].trim().toLowerCase();
  if (t.startsWith('audio/')) {
    // Gemini が受け付ける表記に寄せる
    if (t === 'audio/mp3' || t === 'audio/mpeg3') return 'audio/mpeg';
    return t;
  }
  return 'audio/mpeg';
}

// ---- エントリポイント ----

export async function generateStudyAid({ apiKey, show, episode, onStatus }) {
  const instruction = buildInstruction(show, episode);

  // 1) transcript があればテキスト経路
  const transcript = pickTranscript(episode.transcripts || []);
  if (transcript) {
    onStatus?.('文字起こしを取得中…');
    try {
      let text = await fetchTranscriptText(transcript);
      if (text.length > 200) {
        if (text.length > MAX_TRANSCRIPT_CHARS) text = text.slice(0, MAX_TRANSCRIPT_CHARS);
        onStatus?.('要約とクイズを生成中…');
        const result = await callGenerate(apiKey, [
          { text: instruction + '\n\n--- 文字起こし ---\n' + text },
        ]);
        return { ...result, source: 'transcript', generatedAt: Date.now() };
      }
      // 短すぎる transcript は信用せず音声経路へ
    } catch (e) {
      console.warn('transcript 経路に失敗、音声経路へフォールバック:', e);
    }
  }

  // 2) 音声経路
  onStatus?.('エピソード音声をダウンロード中…');
  const { blob, contentType } = await fetchBlobViaProxy(episode.enclosureUrl, {
    onProgress: (loaded, total) => {
      const mb = (loaded / 1024 / 1024).toFixed(1);
      onStatus?.(
        total
          ? `エピソード音声をダウンロード中… ${Math.round((loaded / total) * 100)}% (${mb}MB)`
          : `エピソード音声をダウンロード中… ${mb}MB`
      );
    },
  });
  const mimeType = normalizeAudioMime(contentType || episode.enclosureType);

  let audioPart;
  try {
    const file = await uploadAudioFile(apiKey, blob, mimeType, onStatus);
    audioPart = { file_data: { file_uri: file.uri, mime_type: mimeType } };
  } catch (e) {
    // Files API が使えない場合、小さいファイルなら inline で送る
    if (blob.size <= MAX_INLINE_AUDIO_BYTES) {
      onStatus?.('音声を変換中…');
      audioPart = { inline_data: { mime_type: mimeType, data: await blobToBase64(blob) } };
    } else {
      throw e;
    }
  }

  onStatus?.('要約とクイズを生成中…（音声の長さにより数分かかることがあります）');
  const result = await callGenerate(apiKey, [audioPart, { text: instruction }]);
  return { ...result, source: 'audio', generatedAt: Date.now() };
}
