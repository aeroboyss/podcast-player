// 端末間同期（GitHub 非公開 Gist をストレージとして使用）。
// GitHub API は CORS 対応のためブラウザから直接呼べる。
// マージ規則: お気に入り・設定はセクション単位で新しい方が勝ち（LWW）、
//             要約/クイズと再生位置はキー単位でマージして新しい方が勝ち。

import {
  getGhToken, getGistId, setGistId,
  exportState, applyState,
} from './storage.js';

const API = 'https://api.github.com';
const FILE = 'podcast-player-sync.json';
const DESC = 'podcast-player 同期データ（アプリが自動管理）';

let timer = null;
let syncing = false;
const listeners = [];

// 同期でローカル状態が更新されたときの UI 再描画用
export function onSyncApplied(fn) {
  listeners.push(fn);
}

async function gh(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${getGhToken()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    if (res.status === 401) throw new Error('GitHub トークンが無効です');
    if (res.status === 404) throw new Error('NOT_FOUND');
    throw new Error(`GitHub API エラー (HTTP ${res.status})`);
  }
  return res.json();
}

async function findOrCreateGist() {
  // 既存の同期用 Gist を探す（他端末が作成済みの場合）
  const gists = await gh('/gists?per_page=100');
  const found = gists.find((g) => g.files && g.files[FILE]);
  if (found) {
    setGistId(found.id);
    return found.id;
  }
  const created = await gh('/gists', {
    method: 'POST',
    body: {
      description: DESC,
      public: false,
      files: { [FILE]: { content: JSON.stringify(exportState()) } },
    },
  });
  setGistId(created.id);
  return created.id;
}

// リモートが新しければリモート、ローカルが新しければローカル。
// 同時刻（旧データで両方 at=0 のケース含む）は中身のある方を優先する。
function pickNewer(local, remote, isEmpty) {
  const la = local?.at || 0;
  const ra = remote?.at || 0;
  if (ra > la) return remote;
  if (la > ra) return local;
  return isEmpty(local) && !isEmpty(remote) ? remote : local;
}

function mergeStates(local, remote) {
  if (!remote) return local;
  const favorites = pickNewer(local.favorites, remote.favorites, (f) => !f?.items?.length);
  const settings = pickNewer(local.settings, remote.settings, (s) => !s?.proxyUrl);
  // 旧バージョンの Gist に残っている API キーは取り込まず、次回 push で消す
  if (settings.apiKey !== undefined) delete settings.apiKey;

  const ai = { ...(remote.ai || {}) };
  for (const [key, value] of Object.entries(local.ai)) {
    if (!ai[key] || (value?.generatedAt || 0) >= (ai[key]?.generatedAt || 0)) ai[key] = value;
  }

  const entryAt = (v) => (typeof v === 'number' ? 0 : v?.at || 0);
  const mergeByKey = (loc, rem) => {
    const out = { ...(rem || {}) };
    for (const [key, value] of Object.entries(loc || {})) {
      if (!(key in out) || entryAt(value) >= entryAt(out[key])) out[key] = value;
    }
    return out;
  };

  return {
    favorites,
    settings,
    ai,
    pos: mergeByKey(local.pos, remote.pos),
    rate: mergeByKey(local.rate, remote.rate),
    skip: mergeByKey(local.skip, remote.skip),
  };
}

export async function syncNow() {
  if (!getGhToken()) return { status: 'no-token' };
  if (syncing) return { status: 'busy' };
  syncing = true;
  try {
    let gistId = getGistId() || (await findOrCreateGist());

    let gist;
    try {
      gist = await gh(`/gists/${gistId}`);
    } catch (e) {
      if (e.message !== 'NOT_FOUND') throw e;
      // 保存していた Gist が消されていた場合は作り直す
      setGistId('');
      gistId = await findOrCreateGist();
      gist = await gh(`/gists/${gistId}`);
    }

    let remote = null;
    const file = gist.files?.[FILE];
    if (file) {
      const content = file.truncated
        ? await (await fetch(file.raw_url)).text()
        : file.content;
      try {
        remote = JSON.parse(content);
      } catch { /* 壊れていたらローカルで上書き */ }
    }

    const merged = mergeStates(exportState(), remote);
    applyState(merged);

    const body = JSON.stringify(merged);
    if (!remote || JSON.stringify(remote) !== body) {
      await gh(`/gists/${gistId}`, {
        method: 'PATCH',
        body: { files: { [FILE]: { content: body } } },
      });
    }

    listeners.forEach((fn) => fn());
    return { status: 'ok', at: Date.now() };
  } catch (e) {
    console.warn('同期に失敗:', e);
    return { status: 'error', message: e.message };
  } finally {
    syncing = false;
  }
}

// 変更後に呼ぶ。少し待ってまとめて同期する
export function scheduleSync(delayMs = 4000) {
  if (!getGhToken()) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(), delayMs);
}

// アプリ起動時・フォアグラウンド復帰時の自動同期
export function initSync() {
  if (getGhToken()) syncNow();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleSync(500);
  });
}
