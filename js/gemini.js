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
    keyPoints: {
      type: 'ARRAY',
      description: '重要ポイントの箇条書き（4〜7個、日本語）。各項目は1〜2文で簡潔に。',
      items: { type: 'STRING' },
    },
    keyQuestions: {
      type: 'ARRAY',
      description: 'このエピソードに対して立てるべき本質的な問いと、その答え（ちょうど3個）',
      minItems: 3,
      maxItems: 3,
      items: {
        type: 'OBJECT',
        properties: {
          question: { type: 'STRING', description: 'エピソードに対して立てるべき問い（日本語）' },
          answer: { type: 'STRING', description: 'その問いへの答え。エピソードの内容に基づき日本語で。' },
        },
        required: ['question', 'answer'],
      },
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
  required: ['keyPoints', 'keyQuestions', 'quiz'],
};

function buildInstruction(show, episode) {
  return [
    `ポッドキャスト番組「${show.title}」のエピソード「${episode.title}」の内容を分析してください。`,
    '',
    '次の3つを日本語で作成してください（エピソードが日本語以外でも出力は日本語）：',
    '',
    '1. 重要ポイントの箇条書き（4〜7個）。各項目は1〜2文で簡潔に、要点だけを示す。',
    '',
    '2. このエピソードに対して立てるべき本質的な「問い」を3つと、それぞれの答え。',
    '   - 単なる事実確認ではなく、エピソードの核心・示唆・背景にある論点を掘り下げる問いにする。',
    '   - 答えはエピソードの内容に基づいて具体的に示す。',
    '',
    '3. 4択クイズを5問。それぞれ選択肢4つ・正解1つ・解説付き。',
    '   - 単なるエピソードの内容確認（日付・数字・固有名詞の暗記）にはしないこと。',
    '   - エピソードの核心的な主張の理解を問う問題や、話全体を通した構造・論理展開・',
    '     結論に至る筋道を問う問題にすること。',
    '   - 誤答の選択肢も、文脈に沿ったもっともらしいものにすること。',
    '   - 解説では、なぜその答えが正しいのかを本質に触れて説明すること。',
  ].join('\n');
}

// Google API のエラーレスポンスから原因が分かるメッセージを組み立てる
async function describeGoogleError(res, prefix) {
  const body = await res.text().catch(() => '');
  let msg = `${prefix} (HTTP ${res.status})`;
  try {
    const err = JSON.parse(body).error;
    msg += `\n${err.status || ''}: ${err.message || ''}`;
  } catch {
    if (body) msg += '\n' + body.slice(0, 200);
  }
  return msg;
}

// 設定画面の「キーをテスト」用。安価な models 一覧でキーの有効性を確認する
export async function testApiKey(apiKey) {
  try {
    const res = await fetch(`${API_BASE}/v1beta/models?pageSize=1`, {
      headers: { 'x-goog-api-key': apiKey },
    });
    if (!res.ok) return { ok: false, message: await describeGoogleError(res, 'キーが拒否されました') };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: '接続エラー: ' + e.message };
  }
}

// ---- エピソードについての AI チャット ----

// チャット用コンテキストを取得（文字起こしがあればそれを使用）
export async function fetchChatContext(episode, onStatus) {
  const transcript = pickTranscript(episode.transcripts || []);
  if (transcript) {
    onStatus?.('文字起こしを取得中…');
    try {
      const text = await fetchTranscriptText(transcript);
      if (text.length > 200) {
        return { source: 'transcript', text: text.slice(0, MAX_TRANSCRIPT_CHARS) };
      }
    } catch (e) {
      console.warn('チャット用文字起こしの取得に失敗:', e);
    }
  }
  return { source: 'meta', text: '' };
}

// エピソード内容をコンテキストに、会話履歴つきで質問に答える
export async function chatAboutEpisode({ apiKey, show, episode, context, aiResult, history }) {
  const ctx = [`番組名: ${show.title}`, `エピソード: ${episode.title}`];
  if (episode.description) ctx.push(`エピソード概要:\n${episode.description}`);
  if (context?.text) {
    ctx.push(`文字起こし（全文または冒頭部分）:\n${context.text}`);
  } else if (aiResult) {
    const parts = [];
    if (aiResult.keyPoints?.length) parts.push('重要ポイント:\n' + aiResult.keyPoints.join('\n'));
    if (aiResult.keyQuestions?.length) {
      parts.push('問いと答え:\n' + aiResult.keyQuestions.map((q) => `Q: ${q.question}\nA: ${q.answer}`).join('\n'));
    }
    if (parts.length) ctx.push('AI 分析結果（事前生成）:\n' + parts.join('\n\n'));
  }

  const systemText =
    'あなたはポッドキャストエピソードの内容について質問に答えるアシスタントです。' +
    '以下のエピソード情報に基づいて、日本語で簡潔かつ具体的に答えてください。' +
    '情報に含まれない内容を聞かれたら、推測であることを明示するか「エピソード内では触れられていません」と答えてください。\n\n' +
    ctx.join('\n\n');

  const res = await fetch(`${API_BASE}/v1beta/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemText }] },
      contents: history.slice(-20).map((m) => ({ role: m.role, parts: [{ text: m.text }] })),
      generationConfig: { temperature: 0.6 },
    }),
  });
  if (!res.ok) throw new Error(await describeGoogleError(res, 'Gemini API エラー'));
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
  if (!text) throw new Error('AI から回答を取得できませんでした。再試行してください。');
  return text.trim();
}

async function callGenerate(apiKey, parts) {
  const res = await fetch(
    `${API_BASE}/v1beta/models/${MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
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
    throw new Error(await describeGoogleError(res, 'Gemini API エラー'));
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('');
  if (!text) {
    throw new Error('Gemini から結果を取得できませんでした: ' + JSON.stringify(data).slice(0, 300));
  }
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.keyPoints) || !Array.isArray(parsed.quiz) || parsed.quiz.length === 0) {
    throw new Error('生成結果の形式が不正でした。再試行してください。');
  }
  return parsed;
}

// ---- Files API（resumable upload） ----

async function uploadAudioFile(apiKey, blob, mimeType, onStatus) {
  const startRes = await fetch(`${API_BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(blob.size),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: 'podcast-episode' } }),
  });
  if (!startRes.ok) throw new Error(await describeGoogleError(startRes, 'アップロード開始に失敗'));
  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('アップロード URL を取得できませんでした');

  onStatus?.('音声をアップロード中…');
  const upRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
    },
    body: blob,
  });
  if (!upRes.ok) throw new Error(await describeGoogleError(upRes, 'アップロードに失敗'));
  let file = (await upRes.json()).file;

  // 処理完了 (ACTIVE) まで待つ
  const deadline = Date.now() + 5 * 60 * 1000;
  while (file.state === 'PROCESSING') {
    if (Date.now() > deadline) throw new Error('音声の処理がタイムアウトしました');
    onStatus?.('Gemini 側で音声を処理中…');
    await new Promise((r) => setTimeout(r, 4000));
    const poll = await fetch(`${API_BASE}/v1beta/${file.name}`, {
      headers: { 'x-goog-api-key': apiKey },
    });
    if (!poll.ok) throw new Error(await describeGoogleError(poll, 'ファイル状態の確認に失敗'));
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
