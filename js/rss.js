// RSS フィードの取得とパース（Podcasting 2.0 transcript タグ対応）

import { fetchTextViaProxy } from './net.js';

const MAX_EPISODES = 200;

// 名前空間を無視して localName で子孫要素を探す
function findAll(el, localName) {
  return [...el.getElementsByTagName('*')].filter((n) => n.localName === localName);
}
function findFirst(el, localName) {
  return findAll(el, localName)[0] || null;
}
function textOf(el, localName) {
  return findFirst(el, localName)?.textContent?.trim() || '';
}

function parseDuration(raw) {
  if (!raw) return 0;
  const parts = raw.trim().split(':').map(Number);
  if (parts.some(Number.isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0];
}

// HTML 混じりの説明文をプレーンテキスト化（改行はある程度保持）
export function stripHtml(html) {
  if (!html) return '';
  const withBreaks = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n');
  const doc = new DOMParser().parseFromString(withBreaks, 'text/html');
  return (doc.body.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

function parseItem(item) {
  const enclosure = findFirst(item, 'enclosure');
  const descHtml =
    textOf(item, 'encoded') || textOf(item, 'description') || textOf(item, 'summary');
  const transcripts = findAll(item, 'transcript')
    .map((t) => ({
      url: t.getAttribute('url') || '',
      type: (t.getAttribute('type') || '').toLowerCase(),
    }))
    .filter((t) => t.url);
  return {
    guid: textOf(item, 'guid'),
    title: textOf(item, 'title'),
    pubDate: textOf(item, 'pubDate'),
    durationSec: parseDuration(textOf(item, 'duration')),
    description: stripHtml(descHtml),
    enclosureUrl: enclosure?.getAttribute('url') || '',
    enclosureType: enclosure?.getAttribute('type') || 'audio/mpeg',
    transcripts,
  };
}

export function parseFeed(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('フィードの XML を解析できませんでした');
  }
  const channel = doc.querySelector('channel');
  if (!channel) throw new Error('RSS チャンネルが見つかりませんでした');

  const imageEl = findFirst(channel, 'image');
  const artwork =
    imageEl?.getAttribute?.('href') ||
    (imageEl ? textOf(imageEl, 'url') : '') ||
    '';

  const items = [...channel.getElementsByTagName('item')]
    .slice(0, MAX_EPISODES)
    .map(parseItem)
    .filter((ep) => ep.enclosureUrl);

  return {
    title: textOf(channel, 'title'),
    author: textOf(channel, 'author'),
    description: stripHtml(
      findFirst(channel, 'description')?.textContent ||
      findFirst(channel, 'summary')?.textContent || ''
    ),
    artwork,
    episodes: items,
  };
}

export async function fetchFeed(feedUrl) {
  const xml = await fetchTextViaProxy(feedUrl, { timeoutMs: 15000 });
  return parseFeed(xml);
}

// ---- transcript の取得・テキスト化 ----

// 扱いやすい形式を優先して選ぶ
export function pickTranscript(transcripts) {
  const order = ['vtt', 'srt', 'text/plain', 'json', 'html'];
  const sorted = [...transcripts].sort((a, b) => {
    const rank = (t) => {
      const i = order.findIndex((o) => t.type.includes(o));
      return i === -1 ? order.length : i;
    };
    return rank(a) - rank(b);
  });
  return sorted[0] || null;
}

export async function fetchTranscriptText(transcript) {
  const raw = await fetchTextViaProxy(transcript.url);
  const type = transcript.type;

  if (type.includes('json')) {
    try {
      const data = JSON.parse(raw);
      const segments = data.segments || data;
      if (Array.isArray(segments)) {
        return segments.map((s) => s.body || s.text || '').join(' ').trim();
      }
    } catch { /* JSON でなければ下のテキスト処理へ */ }
  }

  if (type.includes('vtt') || raw.trimStart().startsWith('WEBVTT')) {
    return raw
      .split('\n')
      .filter((line) => {
        const l = line.trim();
        return l && !l.startsWith('WEBVTT') && !l.includes('-->') &&
               !/^\d+$/.test(l) && !l.startsWith('NOTE');
      })
      .join('\n');
  }

  if (type.includes('srt') || /^\d+\s*\n[\d:,]+ --> /m.test(raw)) {
    return raw
      .split('\n')
      .filter((line) => {
        const l = line.trim();
        return l && !l.includes('-->') && !/^\d+$/.test(l);
      })
      .join('\n');
  }

  if (type.includes('html')) return stripHtml(raw);
  return raw.trim();
}
