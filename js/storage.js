// localStorage ラッパー。キーはすべて "pp." プレフィックス。

const K = {
  favorites: 'pp.favorites',
  apiKey: 'pp.apiKey',
  proxyUrl: 'pp.proxyUrl',
  ai: 'pp.ai.',      // + episodeKey
  pos: 'pp.pos.',    // + episodeKey
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
  return idx < 0; // true = 登録した
}

// ---- API キー ----
export function getApiKey() {
  return localStorage.getItem(K.apiKey) || '';
}

export function setApiKey(key) {
  localStorage.setItem(K.apiKey, key.trim());
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
}

// ---- AI 生成結果（要約・クイズ） ----
export function getAiResult(episodeKey) {
  return getJSON(K.ai + episodeKey, null);
}

export function setAiResult(episodeKey, result) {
  return setJSON(K.ai + episodeKey, result);
}

// ---- 再生位置 ----
export function getPosition(episodeKey) {
  const v = Number(localStorage.getItem(K.pos + episodeKey));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

export function setPosition(episodeKey, seconds) {
  try {
    localStorage.setItem(K.pos + episodeKey, String(Math.floor(seconds)));
  } catch { /* 容量超過時は無視 */ }
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
