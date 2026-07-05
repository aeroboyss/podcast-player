// 画面描画とイベント配線

import {
  getFavorites, isFavorite, toggleFavorite,
  getApiKey, setApiKey, getProxyUrl, setProxyUrl,
  getGhToken, setGhToken, getLastSync,
  getAiResult, setAiResult, episodeKey,
} from './storage.js';
import { syncNow, scheduleSync, onSyncApplied, initSync } from './sync.js';
import { searchPodcasts } from './itunes.js';
import { loadShowData } from './episodes.js';
import { generateStudyAid } from './gemini.js';
import { Player } from './player.js';

const player = new Player();

const $ = (id) => document.getElementById(id);

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

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
      <div class="show-tile" data-index="${i}">
        <img src="${esc(f.artwork)}" alt="" loading="lazy">
        <div class="show-tile-title">${esc(f.title)}</div>
      </div>`
    )
    .join('');
  list.querySelectorAll('.show-tile').forEach((tile) => {
    tile.addEventListener('click', () => openShow(favs[Number(tile.dataset.index)]));
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
    <h3 class="section-heading">エピソード（${feed.episodes.length}件）</h3>
    <ul class="episode-list">
      ${feed.episodes.map((ep, i) => `
        <li class="episode-item" data-ep="${i}">
          <div class="episode-date">${esc(fmtDate(ep.pubDate))}</div>
          <div class="episode-title">${esc(ep.title)}</div>
          <div class="episode-sub">
            ${ep.durationSec ? `<span>${esc(fmtDuration(ep.durationSec))}</span>` : ''}
            ${ep.transcripts.length ? '<span class="badge">文字起こしあり</span>' : ''}
            ${getAiResult(episodeKey(show.id, ep)) ? '<span class="badge">要約済み</span>' : ''}
          </div>
        </li>`).join('')}
    </ul>
  `;

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

  body.querySelectorAll('.episode-item').forEach((item) => {
    item.addEventListener('click', () =>
      openEpisode({ ...show, artwork: show.artwork || feed.artwork, title: feed.title || show.title },
        feed.episodes[Number(item.dataset.ep)])
    );
  });
}

// ---------- エピソード詳細 ----------

function openEpisode(show, episode) {
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
      <div class="ep-desc">${esc(episode.description)}</div>` : ''}
    <div class="ai-section" id="ai-section"></div>
  `;

  $('ep-play-btn').addEventListener('click', () => player.playEpisode(show, episode));
  renderAiSection(show, episode);
}

// ---------- AI 要約・クイズ ----------

function renderAiSection(show, episode) {
  const section = $('ai-section');
  const key = episodeKey(show.id, episode);
  const cached = getAiResult(key);

  if (cached) {
    renderAiResult(section, show, episode, cached);
    return;
  }

  const hasTranscript = (episode.transcripts || []).length > 0;
  section.innerHTML = `
    <h3>AI 要約とクイズ</h3>
    <p class="ai-note">
      ${hasTranscript
        ? 'この番組は文字起こしを提供しています。テキストから要約と4択クイズ（5問）を生成します。'
        : '文字起こしが提供されていないため、エピソード音声を Gemini に渡して要約と4択クイズ（5問）を生成します。音声の長さによっては数分かかります。'}
    </p>
    <button class="btn btn-primary btn-block" id="ai-generate-btn">要約とクイズを生成</button>
    <div id="ai-status"></div>
  `;
  $('ai-generate-btn').addEventListener('click', () => runGenerate(show, episode));
}

async function runGenerate(show, episode) {
  const apiKey = getApiKey();
  const statusEl = $('ai-status');
  if (!apiKey) {
    statusEl.innerHTML = `<div class="ai-error">Gemini API キーが未設定です。「設定」タブでキーを保存してください。</div>`;
    return;
  }
  const btn = $('ai-generate-btn');
  if (btn) btn.disabled = true;

  try {
    const result = await generateStudyAid({
      apiKey, show, episode,
      onStatus: (msg) => {
        statusEl.innerHTML = `<div class="ai-status"><span class="spinner"></span>${esc(msg)}</div>`;
      },
    });
    const key = episodeKey(show.id, episode);
    setAiResult(key, result);
    renderAiResult($('ai-section'), show, episode, result);
    scheduleSync();
  } catch (err) {
    console.error(err);
    if (btn) btn.disabled = false;
    statusEl.innerHTML = `<div class="ai-error">生成に失敗しました。\n${esc(err.message)}</div>`;
  }
}

function renderAiResult(section, show, episode, result) {
  const date = new Date(result.generatedAt);
  section.innerHTML = `
    <h3>AI 要約</h3>
    <div class="ai-summary">${esc(result.summary)}</div>
    ${Array.isArray(result.keyPoints) && result.keyPoints.length ? `
      <h3>重要ポイント</h3>
      <ul class="ai-keypoints">
        ${result.keyPoints.map((p) => `<li>${esc(p)}</li>`).join('')}
      </ul>` : ''}
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

renderFavorites();
renderSyncStatus();
initSync();
