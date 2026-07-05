// localStorage ラッパー。キーはすべて "pp." プレフィックス。

const K = {
  favorites: 'pp.favorites',
  apiKey: 'pp.apiKey',
  proxyUrl: 'pp.proxyUrl',
  ghToken: 'pp.ghToken',
  gistId: 'pp.gistId',
  favAt: 'pp.favAt',   // お気に入り最終更新時刻（同期のLWW判定用）
  setAt: 'pp.setAt',   // 設定最終更新時刻
  lastSync: 'pp.lastSync',
  nowPlaying: 'pp.nowPlaying',
  ai: 'pp.ai.',      // + episodeKey
  pos: 'pp.pos.',    // + episodeKey
  rate: 'pp.rate.',  // + showId（番組ごとの再生速度）
  skip: 'pp.skip.',  // + showId（番組ごとの冒頭/終わりスキップ秒数）
  autoai: 'pp.autoai.', // + showId（再生開始時にAI分析を自動生成するか）
  feed: 'pp.feed.',  // + showId
};

function getJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function setJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('localStorage write failed:', e);
    return false;
  }
}

// ---- お気に入り ----
export function getFavorites() {
  return getJSON(K.favorites, []);
}

export function isFavorite(id) {
  return getFavorites().some((f) => f.id === id);
}

export function toggleFavorite(show) {
  const favs = getFavorites();
  const idx = favs.findIndex((f) => f.id === show.id);
  if (idx >= 0) {
    favs.splice(idx, 1);
  } else {
    favs.push(show);
  }
  setJSON(K.favorites, favs);
  localStorage.setItem(K.favAt, String(Date.now()));
  return idx < 0; // true = 登録した
}

// ---- API キー ----
export function getApiKey() {
  return localStorage.getItem(K.apiKey) || '';
}

export function setApiKey(key) {
  localStorage.setItem(K.apiKey, key.trim());
  localStorage.setItem(K.setAt, String(Date.now()));
}

// ---- 自前 CORS プロキシ ----
// 値は「この後ろに encodeURIComponent した対象 URL を連結する」プレフィックス。
// 例: https://podcast-proxy.example.workers.dev/?url=
export function getProxyUrl() {
  return localStorage.getItem(K.proxyUrl) || '';
}

export function setProxyUrl(url) {
  const v = url.trim();
  if (v) localStorage.setItem(K.proxyUrl, v);
  else localStorage.removeItem(K.proxyUrl);
  localStorage.setItem(K.setAt, String(Date.now()));
}

// ---- 端末間同期（GitHub Gist）用 ----
export function getGhToken() {
  return localStorage.getItem(K.ghToken) || '';
}

export function setGhToken(token) {
  const v = token.trim();
  if (v) localStorage.setItem(K.ghToken, v);
  else localStorage.removeItem(K.ghToken);
}

export function getGistId() {
  return localStorage.getItem(K.gistId) || '';
}

export function setGistId(id) {
  localStorage.setItem(K.gistId, id);
}

export function getLastSync() {
  return Number(localStorage.getItem(K.lastSync)) || 0;
}

function collectPrefixed(prefix) {
  const out = {};
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(prefix)) {
      try {
        out[key.slice(prefix.length)] = JSON.parse(localStorage.getItem(key));
      } catch { /* 壊れたエントリは同期対象から除外 */ }
    }
  }
  return out;
}

// 同期用に全状態をエクスポート。
// Gemini API キーは同期しない（Gist はシークレットスキャンの対象になり得るため。
// 実際にキーが「漏えい」と判定され無効化された事例あり）。各端末で個別に設定する。
export function exportState() {
  return {
    favorites: { at: Number(localStorage.getItem(K.favAt)) || 0, items: getFavorites() },
    settings: {
      at: Number(localStorage.getItem(K.setAt)) || 0,
      proxyUrl: getProxyUrl(),
    },
    ai: collectPrefixed(K.ai),
    pos: collectPrefixed(K.pos),
    rate: collectPrefixed(K.rate),
    skip: collectPrefixed(K.skip),
    autoai: collectPrefixed(K.autoai),
  };
}

// マージ済み状態を localStorage に書き戻す（API キーはローカル管理のため触らない）
export function applyState(state) {
  setJSON(K.favorites, state.favorites.items);
  localStorage.setItem(K.favAt, String(state.favorites.at));
  if (state.settings.proxyUrl) localStorage.setItem(K.proxyUrl, state.settings.proxyUrl);
  else localStorage.removeItem(K.proxyUrl);
  localStorage.setItem(K.setAt, String(state.settings.at));
  for (const [key, value] of Object.entries(state.ai)) setJSON(K.ai + key, value);
  for (const [key, value] of Object.entries(state.pos)) setJSON(K.pos + key, value);
  for (const [key, value] of Object.entries(state.rate || {})) setJSON(K.rate + key, value);
  for (const [key, value] of Object.entries(state.skip || {})) setJSON(K.skip + key, value);
  for (const [key, value] of Object.entries(state.autoai || {})) setJSON(K.autoai + key, value);
  localStorage.setItem(K.lastSync, String(Date.now()));
}

// ---- AI 生成結果（要約・クイズ） ----
export function getAiResult(episodeKey) {
  return getJSON(K.ai + episodeKey, null);
}

export function setAiResult(episodeKey, result) {
  return setJSON(K.ai + episodeKey, result);
}

// ---- 再生位置 ----
// 値は { s: 秒, at: 更新時刻 }（同期時にキー単位で新しい方を採用するため）
export function getPosition(episodeKey) {
  const raw = localStorage.getItem(K.pos + episodeKey);
  if (!raw) return 0;
  try {
    const v = JSON.parse(raw);
    const s = typeof v === 'number' ? v : Number(v?.s);
    return Number.isFinite(s) && s > 0 ? s : 0;
  } catch {
    return 0;
  }
}

// 一度でも再生されたか（再生位置の記録が存在するか）
export function hasPlayed(episodeKey) {
  return localStorage.getItem(K.pos + episodeKey) !== null;
}

export function setPosition(episodeKey, seconds) {
  try {
    localStorage.setItem(
      K.pos + episodeKey,
      JSON.stringify({ s: Math.floor(seconds), at: Date.now() })
    );
  } catch { /* 容量超過時は無視 */ }
}

// ---- 番組ごとの再生速度 ----
// 値は { v: 倍率, at: 更新時刻 }（同期時にキー単位で新しい方を採用）
export const PLAYBACK_RATES = [1, 1.1, 1.2];

export function getShowRate(showId) {
  const raw = getJSON(K.rate + showId, null);
  const r = typeof raw === 'number' ? raw : Number(raw?.v);
  return PLAYBACK_RATES.includes(r) ? r : 1;
}

export function setShowRate(showId, rate) {
  setJSON(K.rate + showId, { v: rate, at: Date.now() });
}

// ---- 番組ごとの冒頭/終わりスキップ ----
// 値は { intro: 冒頭スキップ秒, outro: 終わり手前秒, at: 更新時刻 }
const MAX_SKIP_SEC = 600;

export function getShowSkip(showId) {
  const raw = getJSON(K.skip + showId, null);
  const clamp = (v) => Math.min(MAX_SKIP_SEC, Math.max(0, Math.round(Number(v) / 5) * 5 || 0));
  return { intro: clamp(raw?.intro), outro: clamp(raw?.outro) };
}

export function setShowSkip(showId, { intro, outro }) {
  setJSON(K.skip + showId, { intro, outro, at: Date.now() });
}

// ---- 番組ごとのAI自動生成設定（デフォルトOFF） ----
// 値は { on: boolean, at: 更新時刻 }
export function getShowAutoAi(showId) {
  return !!getJSON(K.autoai + showId, null)?.on;
}

export function setShowAutoAi(showId, on) {
  setJSON(K.autoai + showId, { on: !!on, at: Date.now() });
}

// ---- 再生中エピソード（リロード後の復元用） ----
export function getNowPlaying() {
  return getJSON(K.nowPlaying, null);
}

export function setNowPlaying(np) {
  if (np) setJSON(K.nowPlaying, np);
  else localStorage.removeItem(K.nowPlaying);
}

// ---- フィードキャッシュ（30分） ----
const FEED_TTL_MS = 30 * 60 * 1000;

export function getFeedCache(showId) {
  const c = getJSON(K.feed + showId, null);
  if (!c || Date.now() - c.at > FEED_TTL_MS) return null;
  return c.feed;
}

export function setFeedCache(showId, feed) {
  if (!setJSON(K.feed + showId, { at: Date.now(), feed })) {
    // 容量超過なら古いフィードキャッシュを全部消して再試行
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(K.feed)) localStorage.removeItem(key);
    }
    setJSON(K.feed + showId, { at: Date.now(), feed });
  }
}

// ---- エピソードの一意キー ----
export function episodeKey(showId, episode) {
  const raw = `${showId}::${episode.guid || episode.enclosureUrl || episode.title}`;
  // djb2 ハッシュで短いキーにする
  let h = 5381;
  for (let i = 0; i < raw.length; i++) {
    h = ((h << 5) + h + raw.charCodeAt(i)) >>> 0;
  }
  return h.toString(36) + '_' + raw.length.toString(36);
}
