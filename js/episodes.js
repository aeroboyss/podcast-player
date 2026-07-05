// エピソード一覧の取得。
// 主経路: iTunes Lookup API（CORS 対応・安定）
// 補強:   RSS フィード（transcript タグと番組説明のため。プロキシ経由・ベストエフォート）

import { lookupEpisodes } from './itunes.js';
import { fetchFeed } from './rss.js';
import { getFeedCache, setFeedCache } from './storage.js';

function normTitle(t) {
  return (t || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// RSS の item を lookup のエピソードにマージ（transcript・長い説明・duration を補完）
function mergeFeedInto(episodes, feed) {
  const byGuid = new Map();
  const byUrl = new Map();
  const byTitle = new Map();
  for (const item of feed.episodes) {
    if (item.guid) byGuid.set(item.guid, item);
    if (item.enclosureUrl) byUrl.set(item.enclosureUrl, item);
    byTitle.set(normTitle(item.title), item);
  }
  for (const ep of episodes) {
    const item =
      byGuid.get(ep.guid) || byUrl.get(ep.enclosureUrl) || byTitle.get(normTitle(ep.title));
    if (!item) continue;
    if (item.transcripts.length) ep.transcripts = item.transcripts;
    if (item.description && item.description.length > ep.description.length) {
      ep.description = item.description;
    }
    if (!ep.durationSec && item.durationSec) ep.durationSec = item.durationSec;
  }
}

// 戻り値: { title, author, description, artwork, episodes }
// onEnriched: RSS 補強が後から完了したときに呼ばれる（再描画用）
export async function loadShowData(show, { onEnriched } = {}) {
  const cached = getFeedCache(show.id);
  if (cached) return cached;

  let data;
  let lookupError = null;
  try {
    const episodes = await lookupEpisodes(show.id);
    data = {
      title: show.title,
      author: show.author,
      description: '',
      artwork: show.artwork,
      episodes,
    };
  } catch (e) {
    lookupError = e;
  }

  if (data) {
    // RSS 補強はバックグラウンドで（失敗しても無視）
    fetchFeed(show.feedUrl)
      .then((feed) => {
        mergeFeedInto(data.episodes, feed);
        data.description = feed.description || data.description;
        data.title = feed.title || data.title;
        data.author = feed.author || data.author;
        setFeedCache(show.id, data);
        onEnriched?.(data);
      })
      .catch((e) => console.warn('RSS 補強に失敗（続行）:', e.message));
    setFeedCache(show.id, data);
    return data;
  }

  // lookup が失敗した場合のみ RSS を主経路として待つ
  try {
    const feed = await fetchFeed(show.feedUrl);
    data = {
      title: feed.title || show.title,
      author: feed.author || show.author,
      description: feed.description,
      artwork: feed.artwork || show.artwork,
      episodes: feed.episodes,
    };
    setFeedCache(show.id, data);
    return data;
  } catch (rssError) {
    throw new Error(
      'エピソード一覧を取得できませんでした。\n' +
      `iTunes: ${lookupError?.message}\nRSS: ${rssError.message}`
    );
  }
}
