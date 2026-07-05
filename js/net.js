// CORS プロキシ付き fetch。
// まず直接取得を試み、CORS 等で失敗したらプロキシへ順にフォールバックする。
// 設定画面で自前プロキシ（Cloudflare Workers 等）を登録すると最優先で使われる。

import { getProxyUrl } from './storage.js';

function proxies() {
  const list = [(u) => u]; // 直接
  const custom = getProxyUrl();
  if (custom) list.unshift((u) => custom + encodeURIComponent(u)); // 自前プロキシを最優先
  list.push(
    (u) => 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u),
    (u) => 'https://corsproxy.io/?url=' + encodeURIComponent(u),
  );
  return list;
}

async function tryFetch(url, init, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// テキスト（RSS XML・transcript など）を取得する
export async function fetchTextViaProxy(url, { timeoutMs = 20000 } = {}) {
  let lastErr;
  for (const wrap of proxies()) {
    try {
      const res = await tryFetch(wrap(url), {}, timeoutMs);
      const text = await res.text();
      if (text.trim()) return text;
      throw new Error('empty response');
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`取得に失敗しました: ${url}\n(${lastErr?.message || lastErr})`);
}

// バイナリ（音声）を進捗付きで取得する
export async function fetchBlobViaProxy(url, { onProgress, timeoutMs = 300000 } = {}) {
  let lastErr;
  for (const wrap of proxies()) {
    try {
      const res = await tryFetch(wrap(url), {}, timeoutMs);
      const total = Number(res.headers.get('content-length')) || 0;
      if (!res.body) {
        return { blob: await res.blob(), contentType: res.headers.get('content-type') };
      }
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.byteLength;
        onProgress?.(loaded, total);
      }
      if (loaded === 0) throw new Error('empty body');
      return {
        blob: new Blob(chunks, { type: res.headers.get('content-type') || 'application/octet-stream' }),
        contentType: res.headers.get('content-type'),
      };
    } catch (e) {
      lastErr = e;
    }
  }
  const hint = getProxyUrl()
    ? ''
    : '\n\nこの番組の音声ホストはブラウザからの直接取得を許可していない可能性があります。' +
      '「設定」タブで自前プロキシ（Cloudflare Workers・無料）を登録すると解決できます。' +
      '手順はリポジトリの README を参照してください。';
  throw new Error(`音声の取得に失敗しました\n(${lastErr?.message || lastErr})${hint}`);
}
