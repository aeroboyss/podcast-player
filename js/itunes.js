// iTunes Search / Lookup API。
// どちらも CORS 対応のためブラウザから直接呼べる（プロキシはフォールバックのみ）。

import { fetchTextViaProxy } from './net.js';

async function fetchJson(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch {
    // 直接失敗時のみプロキシ経由
    return JSON.parse(await fetchTextViaProxy(url));
  }
}

export async function searchPodcasts(term) {
  const url =
    'https://itunes.apple.com/search?media=podcast&entity=podcast&limit=25&country=JP&term=' +
    encodeURIComponent(term);
  const data = await fetchJson(url);
  return (data.results || [])
    .filter((r) => r.feedUrl)
    .map((r) => ({
      id: String(r.collectionId),
      title: r.collectionName || '',
      author: r.artistName || '',
      feedUrl: r.feedUrl,
      artwork: r.artworkUrl600 || r.artworkUrl100 || '',
    }));
}

function extToMime(ext) {
  if (!ext || ext === 'mp3') return 'audio/mpeg';
  if (ext === 'm4a') return 'audio/mp4';
  return 'audio/' + ext;
}

// エピソード一覧（最新200件まで）。transcript 情報は含まれない点に注意。
export async function lookupEpisodes(collectionId) {
  const url =
    `https://itunes.apple.com/lookup?id=${encodeURIComponent(collectionId)}` +
    '&entity=podcastEpisode&limit=200';
  const data = await fetchJson(url);
  const results = data.results || [];
  return results
    .filter((r) => r.kind === 'podcast-episode' && r.episodeUrl)
    .map((r) => ({
      guid: r.episodeGuid || String(r.trackId),
      title: r.trackName || '',
      pubDate: r.releaseDate || '',
      durationSec: r.trackTimeMillis ? Math.round(r.trackTimeMillis / 1000) : 0,
      description: (r.description || r.shortDescription || '').trim(),
      enclosureUrl: r.episodeUrl,
      enclosureType: extToMime(r.episodeFileExtension),
      transcripts: [],
    }));
}
