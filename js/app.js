// 画面描画とイベント配線

import {
  getFavorites, isFavorite, toggleFavorite,
  getApiKey, setApiKey, getProxyUrl, setProxyUrl,
  getGhToken, setGhToken, getLastSync,
  getAiResult, setAiResult, episodeKey,
  getPosition, hasPlayed, getShowSkip, setShowSkip,
  getShowAutoAi, setShowAutoAi,
} from './storage.js';
import { syncNow, scheduleSync, onSyncApplied, initSync } from './sync.js';
import { searchPodcasts } from './itunes.js';
import { loadShowData } from './episodes.js';
import { generateStudyAid, testApiKey } from './gemini.js';
import { esc, linkifyTimestamps } from './format.js';
import { Player } from './player.js';

const player = new Player();

const $ = (id) => document.getElementById(id);

function fmtDate(pubDate) {
  const d = new Date(pubDate);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtDuration(sec) {
  if (!sec) return '';
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${m}分`;
}

// ---------- タブ切り替え ----------

const views = { home: $('view-home'), search: $('view-search'), settings: $('view-settings') };

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    // 番組詳細・エピソード詳細のオーバーレイを閉じてからビューを切り替える
    $('show-panel').classList.add('hidden');
    $('episode-panel').classList.add('hidden');
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    const name = tab.dataset.view;
    Object.entries(views).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
    if (name === 'home') renderFavorites();
    // 検索タブは入力欄にフォーカスしてキーボードを開く
    // （iOS はユーザー操作イベント内でのみ programmatic focus を許可する）
    if (name === 'search') $('search-input').focus();
  });
});

// パネルの戻るボタン
document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => $(btn.dataset.close).classList.add('hidden'));
});

// ---------- お気に入り ----------

function renderFavorites() {
  const favs = getFavorites();
  const list = $('favorites-list');
  $('favorites-empty').classList.toggle('hidden', favs.length > 0);
  list.innerHTML = favs
    .map(
      (f, i) => `
      <div class="show-row" data-index="${i}">
        <img src="${esc(f.artwork)}" alt="" loading="lazy">
        <div class="show-row-meta">
          <div class="show-row-title">${esc(f.title)}</div>
          ${f.author ? `<div class="show-row-author">${esc(f.author)}</div>` : ''}
        </div>
      </div>`
    )
    .join('');
  list.querySelectorAll('.show-row').forEach((row) => {
    row.addEventListener('click', () => openShow(favs[Number(row.dataset.index)]));
  });
}

// ---------- 検索 ----------

$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const term = $('search-input').value.trim();
  if (!term) return;
  const status = $('search-status');
  const results = $('search-results');
  results.innerHTML = '';
  status.classList.remove('hidden');
  status.innerHTML = '<span class="spinner"></span>検索中…';
  try {
    const shows = await searchPodcasts(term);
    status.classList.add('hidden');
    if (shows.length === 0) {
      status.classList.remove('hidden');
      status.textContent = '番組が見つかりませんでした。';
      return;
    }
    renderSearchResults(shows);
  } catch (err) {
    status.textContent = '検索に失敗しました。通信環境を確認して再試行してください。';
    console.error(err);
  }
});

function renderSearchResults(shows) {
  const results = $('search-results');
  results.innerHTML = shows
    .map(
      (s, i) => `
      <li class="result-item">
        <img src="${esc(s.artwork)}" alt="" loading="lazy" data-open="${i}">
        <div class="result-meta" data-open="${i}">
          <div class="result-title">${esc(s.title)}</div>
          <div class="result-author">${esc(s.author)}</div>
        </div>
        <button class="btn-fav ${isFavorite(s.id) ? 'registered' : ''}" data-fav="${i}">
          ${isFavorite(s.id) ? '登録済み' : '登録'}
        </button>
      </li>`
    )
    .join('');

  results.querySelectorAll('[data-open]').forEach((el) => {
    el.addEventListener('click', () => openShow(shows[Number(el.dataset.open)]));
  });
  results.querySelectorAll('[data-fav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const show = shows[Number(btn.dataset.fav)];
      const added = toggleFavorite(show);
      btn.classList.toggle('registered', added);
      btn.textContent = added ? '登録済み' : '登録';
      renderFavorites();
      scheduleSync();
    });
  });
}

// ---------- 番組詳細 ----------

let showPanelToken = 0; // 補強完了時の再描画が古い番組を上書きしないためのトークン

async function openShow(show) {
  const panel = $('show-panel');
  const body = $('show-panel-body');
  panel.classList.remove('hidden');
  panel.scrollTop = 0;
  body.innerHTML = `<div class="status-note"><span class="spinner"></span>エピソードを読み込み中…</div>`;

  const token = ++showPanelToken;
  let feed;
  try {
    feed = await loadShowData(show, {
      onEnriched: () => {
        // transcript バッジ等を反映するため、同じ番組を表示中なら再描画
        if (token === showPanelToken && !panel.classList.contains('hidden')) {
          openShow(show);
        }
      },
    });
  } catch (err) {
    body.innerHTML = `<div class="ai-error">${esc(err.message)}</div>`;
    return;
  }
  if (token !== showPanelToken) return;

  const desc = feed.description || '';
  body.innerHTML = `
    <div class="show-header">
      <img src="${esc(show.artwork || feed.artwork)}" alt="">
      <div>
        <h2>${esc(feed.title || show.title)}</h2>
        <div class="show-author">${esc(feed.author || show.author)}</div>
        <button class="btn-fav ${isFavorite(show.id) ? 'registered' : ''}" id="show-fav-btn" style="margin-top:8px">
          ${isFavorite(show.id) ? '登録済み' : '登録'}
        </button>
      </div>
    </div>
    ${desc ? `
      <div class="show-desc desc-clamp" id="show-desc">${esc(desc)}</div>
      <button class="desc-toggle" id="desc-toggle">すべて表示</button>` : ''}
    <details class="skip-settings">
      <summary class="skip-summary">
        <span>再生・表示の設定</span>
        <svg class="skip-chevron" viewBox="0 0 24 24"><path d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
      </summary>
      <div class="skip-body">
        <div class="skip-row">
          <span class="skip-label">冒頭をスキップ</span>
          <div class="stepper">
            <button class="stepper-btn" data-skip="intro" data-delta="-5" aria-label="5秒減らす">−</button>
            <span class="stepper-val" id="skip-intro-val"></span>
            <button class="stepper-btn" data-skip="intro" data-delta="5" aria-label="5秒増やす">＋</button>
          </div>
        </div>
        <div class="skip-row">
          <span class="skip-label">終わりの手前で終了</span>
          <div class="stepper">
            <button class="stepper-btn" data-skip="outro" data-delta="-5" aria-label="5秒減らす">−</button>
            <span class="stepper-val" id="skip-outro-val"></span>
            <button class="stepper-btn" data-skip="outro" data-delta="5" aria-label="5秒増やす">＋</button>
          </div>
        </div>
        <div class="skip-row">
          <span class="skip-label">再生開始時に AI 分析を自動生成</span>
          <button class="toggle" id="auto-ai-toggle" role="switch" aria-label="AI分析の自動生成"></button>
        </div>
        <div class="skip-row">
          <span class="skip-label">エピソードの並び順</span>
          <div class="seg-tabs seg-compact" id="sort-order">
            <button class="seg-tab active" data-sort="newest">新しい順</button>
            <button class="seg-tab" data-sort="oldest">古い順</button>
          </div>
        </div>
      </div>
    </details>
    <h3 class="section-heading" id="episode-list-heading">エピソード（${feed.episodes.length}件）</h3>
    <div class="seg-tabs" id="episode-tabs">
      <button class="seg-tab active" data-tab="all">All</button>
      <button class="seg-tab" data-tab="fresh">Fresh</button>
      <button class="seg-tab" data-tab="playing">Playing</button>
    </div>
    <input type="search" id="episode-search" class="episode-search"
           placeholder="タイトル・概要で絞り込み" autocomplete="off">
    <ul class="episode-list" id="episode-list"></ul>
  `;

  const epShow = { ...show, artwork: show.artwork || feed.artwork, title: feed.title || show.title };

  function renderEpisodeList(list) {
    $('episode-list-heading').textContent = `エピソード（${list.length}件）`;
    const ul = $('episode-list');
    ul.innerHTML = list.length
      ? list.map((ep, i) => {
          const key = episodeKey(show.id, ep);
          const pos = getPosition(key);
          return `
        <li class="episode-item" data-ep="${i}">
          <div class="episode-date">${esc(fmtDate(ep.pubDate))}</div>
          <div class="episode-title">${esc(ep.title)}</div>
          <div class="episode-sub">
            ${ep.durationSec ? `<span>${esc(fmtDuration(ep.durationSec))}</span>` : ''}
            ${pos > 0 ? `<span class="badge">途中 ${esc(fmtDuration(pos))}</span>` : ''}
            ${ep.transcripts.length ? '<span class="badge">文字起こしあり</span>' : ''}
            ${getAiResult(key) ? '<span class="badge">要約済み</span>' : ''}
          </div>
        </li>`;
        }).join('')
      : '<li class="empty-note">一致するエピソードがありません</li>';
    ul.querySelectorAll('.episode-item').forEach((item) => {
      item.addEventListener('click', () => openEpisode(epShow, list[Number(item.dataset.ep)]));
    });
  }

  // タブ（All / Fresh / Playing）・検索語・並び順の組み合わせで絞り込む
  // feed.episodes は新しい順。古い順はフィルタ後リストを反転して得る。
  let currentTab = 'all';
  let sortOrder = 'newest';
  function applyFilters() {
    let list = feed.episodes;
    if (currentTab === 'fresh') {
      list = list.filter((ep) => !hasPlayed(episodeKey(show.id, ep)));
    } else if (currentTab === 'playing') {
      list = list.filter((ep) => getPosition(episodeKey(show.id, ep)) > 0);
    }
    const q = $('episode-search').value.trim().toLowerCase();
    if (q) {
      list = list.filter((ep) => (ep.title + ' ' + ep.description).toLowerCase().includes(q));
    }
    if (sortOrder === 'oldest') {
      list = [...list].reverse(); // feed.episodes を破壊しないようコピーして反転
    }
    renderEpisodeList(list);
  }

  applyFilters();
  $('episode-search').addEventListener('input', applyFilters);
  $('episode-tabs').querySelectorAll('.seg-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => {
      currentTab = tabBtn.dataset.tab;
      $('episode-tabs').querySelectorAll('.seg-tab')
        .forEach((t) => t.classList.toggle('active', t === tabBtn));
      applyFilters();
    });
  });
  $('sort-order').querySelectorAll('.seg-tab').forEach((sortBtn) => {
    sortBtn.addEventListener('click', () => {
      sortOrder = sortBtn.dataset.sort;
      $('sort-order').querySelectorAll('.seg-tab')
        .forEach((t) => t.classList.toggle('active', t === sortBtn));
      applyFilters();
    });
  });

  $('show-fav-btn').addEventListener('click', (e) => {
    const added = toggleFavorite({ ...show, artwork: show.artwork || feed.artwork });
    e.target.classList.toggle('registered', added);
    e.target.textContent = added ? '登録済み' : '登録';
    renderFavorites();
    scheduleSync();
  });

  const toggle = $('desc-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const el = $('show-desc');
      const clamped = el.classList.toggle('desc-clamp');
      toggle.textContent = clamped ? 'すべて表示' : '閉じる';
    });
  }

  // 冒頭/終わりスキップの設定（5秒刻み）
  function renderSkipVals() {
    const s = getShowSkip(show.id);
    $('skip-intro-val').textContent = s.intro + '秒';
    $('skip-outro-val').textContent = s.outro + '秒';
  }
  renderSkipVals();
  body.querySelectorAll('.stepper-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const s = getShowSkip(show.id);
      const field = btn.dataset.skip;
      s[field] = Math.min(600, Math.max(0, s[field] + Number(btn.dataset.delta)));
      setShowSkip(show.id, s);
      renderSkipVals();
      scheduleSync();
    });
  });

  // AI自動生成のON/OFF（デフォルトOFF）
  const autoToggle = $('auto-ai-toggle');
  autoToggle.classList.toggle('on', getShowAutoAi(show.id));
  autoToggle.addEventListener('click', () => {
    const next = !getShowAutoAi(show.id);
    setShowAutoAi(show.id, next);
    autoToggle.classList.toggle('on', next);
    scheduleSync();
  });

}

// ---------- エピソード詳細 ----------

let shownEpisode = null; // エピソードパネルに表示中の {show, episode, key}

function openEpisode(show, episode) {
  shownEpisode = { show, episode, key: episodeKey(show.id, episode) };
  const panel = $('episode-panel');
  const body = $('episode-panel-body');
  panel.classList.remove('hidden');
  panel.scrollTop = 0;

  body.innerHTML = `
    <div class="ep-detail-show">${esc(show.title)}</div>
    <h2 class="ep-detail-title">${esc(episode.title)}</h2>
    <div class="ep-detail-date">
      ${esc(fmtDate(episode.pubDate))}
      ${episode.durationSec ? ' ・ ' + esc(fmtDuration(episode.durationSec)) : ''}
    </div>
    <button class="btn btn-primary btn-block" id="ep-play-btn">▶ このエピソードを再生</button>
    ${episode.description ? `
      <h3 class="section-heading">エピソード概要</h3>
      <div class="ep-desc">${linkifyTimestamps(esc(episode.description))}</div>` : ''}
    <div class="ai-section" id="ai-section"></div>
  `;

  $('ep-play-btn').addEventListener('click', () => player.playEpisode(show, episode));

  // 概要内のタイムスタンプタップでその位置へジャンプ
  body.querySelector('.ep-desc')?.addEventListener('click', (e) => {
    const link = e.target.closest('.ts-link');
    if (link) player.playEpisodeAt(show, episode, Number(link.dataset.sec));
  });

  renderAiSection(show, episode);
}

// ---------- AI 要約・クイズ ----------

const aiInFlight = new Map(); // episodeKey -> 進行中ステータス文言

// 表示中のエピソードが該当するなら AI セクションを描画し直す
function refreshAiSectionIfShown(key) {
  if (shownEpisode?.key === key && !$('episode-panel').classList.contains('hidden')) {
    renderAiSection(shownEpisode.show, shownEpisode.episode);
  }
}

function renderAiSection(show, episode) {
  const section = $('ai-section');
  const key = episodeKey(show.id, episode);
  const cached = getAiResult(key);

  if (cached) {
    renderAiResult(section, show, episode, cached);
    return;
  }

  // 生成中（手動・自動どちらでも）は進行状況を表示
  if (aiInFlight.has(key)) {
    section.innerHTML = `
      <h3>AI 分析とクイズ</h3>
      <div class="ai-status" id="ai-progress">
        <span class="spinner"></span>${esc(aiInFlight.get(key))}
      </div>
    `;
    return;
  }

  const hasTranscript = (episode.transcripts || []).length > 0;
  section.innerHTML = `
    <h3>AI 分析とクイズ</h3>
    <p class="ai-note">
      重要ポイント・立てるべき問い（3つ）・理解度クイズ（4択5問）を生成します。${hasTranscript
        ? 'この番組は文字起こしを提供しているため、テキストから生成します。'
        : '文字起こしがないため、エピソード音声を Gemini に渡して生成します。音声の長さによっては数分かかります。'}
    </p>
    <button class="btn btn-primary btn-block" id="ai-generate-btn">分析とクイズを生成</button>
    <div id="ai-status"></div>
  `;
  $('ai-generate-btn').addEventListener('click', () => runGenerate(show, episode));
}

// 生成の本体（手動・自動共通）。多重実行と生成済みをガードする
async function startGeneration(show, episode) {
  const apiKey = getApiKey();
  const key = episodeKey(show.id, episode);
  if (!apiKey || aiInFlight.has(key) || getAiResult(key)) return;

  aiInFlight.set(key, '生成を開始しています…');
  refreshAiSectionIfShown(key);
  try {
    const result = await generateStudyAid({
      apiKey, show, episode,
      onStatus: (msg) => {
        aiInFlight.set(key, msg);
        const progress = $('ai-progress');
        if (progress && shownEpisode?.key === key) {
          progress.innerHTML = `<span class="spinner"></span>${esc(msg)}`;
        }
      },
    });
    setAiResult(key, result);
    aiInFlight.delete(key);
    scheduleSync();
    refreshAiSectionIfShown(key);
  } catch (err) {
    console.error('AI生成に失敗:', err);
    aiInFlight.delete(key);
    refreshAiSectionIfShown(key); // ボタンUIに戻す
    const statusEl = $('ai-status');
    if (statusEl && shownEpisode?.key === key) {
      statusEl.innerHTML = `<div class="ai-error">生成に失敗しました。\n${esc(err.message)}</div>`;
    }
  }
}

// 生成ボタンから（キー未設定ならエラー表示）
function runGenerate(show, episode) {
  if (!getApiKey()) {
    $('ai-status').innerHTML =
      `<div class="ai-error">Gemini API キーが未設定です。「設定」タブでキーを保存してください。</div>`;
    return;
  }
  startGeneration(show, episode);
}

// 再生開始時の自動生成（番組ごとの設定が ON の場合のみ）
function maybeAutoGenerate(show, episode) {
  if (getShowAutoAi(show.id)) startGeneration(show, episode);
}

function renderAiResult(section, show, episode, result) {
  const date = new Date(result.generatedAt);
  section.innerHTML = `
    <h3>重要ポイント</h3>
    ${Array.isArray(result.keyPoints) && result.keyPoints.length ? `
      <ul class="ai-keypoints">
        ${result.keyPoints.map((p) => `<li>${esc(p)}</li>`).join('')}
      </ul>` : '<p class="ai-note">重要ポイントがありません</p>'}
    ${Array.isArray(result.keyQuestions) && result.keyQuestions.length ? `
      <h3 style="margin-top:18px">立てるべき問い</h3>
      <div class="ai-questions">
        ${result.keyQuestions.map((q, i) => `
          <div class="ai-qa">
            <div class="ai-qa-q">Q${i + 1}. ${esc(q.question)}</div>
            <div class="ai-qa-a">${esc(q.answer)}</div>
          </div>`).join('')}
      </div>` : ''}
    <h3 style="margin-top:18px">理解度クイズ</h3>
    <div id="quiz-container"></div>
    <div class="ai-meta">
      ${result.source === 'transcript' ? '文字起こし' : '音声'}から生成
      ・ ${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}
    </div>
    <button class="btn btn-sub btn-block" id="ai-regenerate-btn">再生成する</button>
  `;
  renderQuiz($('quiz-container'), result.quiz);
  $('ai-regenerate-btn').addEventListener('click', () => runGenerate(show, episode));
}

function renderQuiz(container, quiz) {
  let answered = 0;
  let correct = 0;

  container.innerHTML = quiz
    .map(
      (q, qi) => `
      <div class="quiz-q" data-q="${qi}">
        <div class="quiz-q-text">Q${qi + 1}. ${esc(q.question)}</div>
        <div class="quiz-choices">
          ${q.choices.map((c, ci) => `
            <button class="quiz-choice" data-q="${qi}" data-c="${ci}">
              ${esc(String.fromCharCode(65 + ci))}. ${esc(c)}
            </button>`).join('')}
        </div>
        <div class="quiz-explain hidden"></div>
      </div>`
    )
    .join('') + `<div class="quiz-score hidden" id="quiz-score"></div>`;

  container.querySelectorAll('.quiz-choice').forEach((btn) => {
    btn.addEventListener('click', () => {
      const qi = Number(btn.dataset.q);
      const ci = Number(btn.dataset.c);
      const q = quiz[qi];
      const qEl = container.querySelector(`.quiz-q[data-q="${qi}"]`);
      const buttons = qEl.querySelectorAll('.quiz-choice');
      if (buttons[0].disabled) return; // 回答済み

      buttons.forEach((b) => (b.disabled = true));
      buttons[q.answerIndex]?.classList.add('correct');
      if (ci !== q.answerIndex) {
        btn.classList.add('wrong');
      } else {
        correct++;
      }
      const explain = qEl.querySelector('.quiz-explain');
      explain.textContent = q.explanation || '';
      explain.classList.remove('hidden');

      answered++;
      if (answered === quiz.length) {
        const score = container.querySelector('#quiz-score');
        score.textContent = `結果: ${quiz.length}問中 ${correct}問正解！`;
        score.classList.remove('hidden');
      }
    });
  });
}

// ---------- 設定 ----------

$('api-key-input').value = getApiKey();
$('api-key-save').addEventListener('click', () => {
  setApiKey($('api-key-input').value);
  const status = $('api-key-status');
  status.textContent = '保存しました';
  setTimeout(() => (status.textContent = ''), 2000);
  scheduleSync();
});

$('api-key-test').addEventListener('click', async () => {
  const status = $('api-key-status');
  const key = $('api-key-input').value.trim() || getApiKey();
  if (!key) {
    status.textContent = 'キーが未入力です';
    return;
  }
  status.innerHTML = '<span class="spinner"></span>確認中…';
  const result = await testApiKey(key);
  status.textContent = result.ok ? '✓ キーは有効です' : '✗ ' + result.message.replace(/\n/g, ' ');
});

$('proxy-url-input').value = getProxyUrl();
$('proxy-url-save').addEventListener('click', () => {
  setProxyUrl($('proxy-url-input').value);
  const status = $('proxy-url-status');
  status.textContent = getProxyUrl() ? '保存しました' : '削除しました';
  setTimeout(() => (status.textContent = ''), 2000);
  scheduleSync();
});

// ---------- 同期 ----------

function renderSyncStatus(result) {
  const el = $('sync-status');
  if (result?.status === 'ok') {
    el.textContent = '同期しました（' + new Date(result.at).toLocaleTimeString() + '）';
  } else if (result?.status === 'error') {
    el.textContent = '同期エラー: ' + result.message;
  } else if (result?.status === 'no-token') {
    el.textContent = 'トークンが未設定です';
  } else if (getGhToken()) {
    const last = getLastSync();
    el.textContent = last ? '最終同期: ' + new Date(last).toLocaleString() : '';
  }
}

async function runSync() {
  $('sync-status').innerHTML = '<span class="spinner"></span>同期中…';
  renderSyncStatus(await syncNow());
}

$('gh-token-input').value = getGhToken();
$('gh-token-save').addEventListener('click', () => {
  setGhToken($('gh-token-input').value);
  if (getGhToken()) runSync();
  else $('sync-status').textContent = 'トークンを削除しました';
});
$('sync-now-btn').addEventListener('click', runSync);

onSyncApplied(() => {
  renderFavorites();
  $('api-key-input').value = getApiKey();
  $('proxy-url-input').value = getProxyUrl();
  renderSyncStatus({ status: 'ok', at: Date.now() });
});

// ---------- 初期表示 ----------

// プレイヤーバーのタイトルタップで画面遷移
player.onOpenEpisode = (show, episode) => openEpisode(show, episode);
player.onOpenShow = (show) => {
  $('episode-panel').classList.add('hidden'); // エピソード詳細が開いていたら閉じて一覧を出す
  openShow(show);
};
player.onPlayStarted = (show, episode) => maybeAutoGenerate(show, episode);

// ---------- 「戻る」操作（ボタン／左端エッジスワイプ共通） ----------

// 開いている最前面の画面を1階層閉じる。閉じるものがなければ false を返す。
function goBack() {
  if (!$('player-settings-overlay').classList.contains('hidden')) {
    $('player-settings-overlay').classList.add('hidden');
    return true;
  }
  if (!$('episode-panel').classList.contains('hidden')) {
    $('episode-panel').classList.add('hidden');
    return true;
  }
  if (!$('full-player').classList.contains('hidden')) {
    player.collapsePlayer();
    return true;
  }
  if (!$('show-panel').classList.contains('hidden')) {
    $('show-panel').classList.add('hidden');
    return true;
  }
  return false;
}

// 画面左端からの右スワイプで「戻る」を実行（iOS のスワイプバックに合わせる）
(function bindEdgeSwipeBack() {
  const EDGE = 28;      // 左端からこの範囲で始まったタッチのみ対象（px）
  const DIST = 70;      // 右方向にこの距離を超えたら発火（px）
  let startX = 0, startY = 0, tracking = false;

  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    tracking = t.clientX <= EDGE;
    startX = t.clientX;
    startY = t.clientY;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    // 横方向が主でかつ十分右へ動いたら戻る（縦スクロールとの誤検出を避ける）
    if (dx > DIST && Math.abs(dx) > Math.abs(dy) * 1.5) {
      tracking = false;
      goBack();
    }
  }, { passive: true });

  document.addEventListener('touchend', () => { tracking = false; }, { passive: true });
})();

// ---------- 初期表示 ----------

// localStorage の自動削除（iOS Safari の 7 日 ITP 等）を防ぐため永続化を要求。
// 「ホーム画面に追加」した状態だと許可されやすい。許可されなければ設定画面で注意を促す。
if (navigator.storage?.persist) {
  navigator.storage.persisted()
    .then((already) => already ? true : navigator.storage.persist())
    .then((granted) => {
      if (!granted) $('persist-note').classList.remove('hidden');
    })
    .catch(() => {});
}

renderFavorites();
renderSyncStatus();
initSync();
player.restore(); // 前回再生していたエピソードをプレイヤーバーに復元
