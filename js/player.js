// <audio> 制御・Media Session・再生位置の保存/復元

import {
  episodeKey, getPosition, setPosition,
  getShowRate, setShowRate,
  getShowSkip, getNowPlaying, setNowPlaying,
} from './storage.js';
import { scheduleSync } from './sync.js';
import { esc, linkifyTimestamps } from './format.js';

const SKIP_FORWARD = 15;
const SKIP_BACK = 30;
const SLEEP_MINUTES = 20;

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  sec = Math.floor(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export class Player {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'metadata';
    this.current = null; // { show, episode, key }
    this._seeking = false;
    this._lastSaved = 0;

    this.el = {
      bar: document.getElementById('player-bar'),
      miniTitles: document.getElementById('player-mini-titles'),
      epTitle: document.getElementById('player-episode-title'),
      showTitle: document.getElementById('player-show-title'),
      playMini: document.getElementById('btn-play-mini'),
      iconPlayMini: document.getElementById('icon-play-mini'),
      iconPauseMini: document.getElementById('icon-pause-mini'),
      fullPlayer: document.getElementById('full-player'),
      fpCollapse: document.getElementById('fp-collapse'),
      fpEpTitle: document.getElementById('fp-ep-title'),
      fpShowTitle: document.getElementById('fp-show-title'),
      fpOpenEpisode: document.getElementById('fp-open-episode'),
      fpDesc: document.getElementById('fp-desc'),
      artwork: document.getElementById('player-artwork'),
      range: document.getElementById('player-range'),
      current: document.getElementById('player-current'),
      duration: document.getElementById('player-duration'),
      play: document.getElementById('btn-play'),
      iconPlay: document.getElementById('icon-play'),
      iconPause: document.getElementById('icon-pause'),
      rewind: document.getElementById('btn-rewind'),
      forward: document.getElementById('btn-forward'),
      settings: document.getElementById('btn-player-settings'),
      settingsStatus: document.getElementById('player-settings-status'),
      settingsOverlay: document.getElementById('player-settings-overlay'),
      rateOptions: document.getElementById('rate-options'),
      sleep: document.getElementById('btn-sleep'),
      sleepLabel: document.getElementById('sleep-label'),
    };
    this._sleepDeadline = null;
    this._sleepInterval = null;

    // 画面遷移・再生開始コールバック（app.js から設定される）
    this.onOpenEpisode = null;
    this.onOpenShow = null;
    this.onPlayStarted = null;

    this._bindUi();
    this._bindAudio();
    this._bindMediaSession();
  }

  _bindUi() {
    this.el.play.addEventListener('click', () => this.toggle());
    this.el.playMini.addEventListener('click', () => this.toggle());
    this.el.rewind.addEventListener('click', () => this.seekBy(-SKIP_BACK));
    this.el.forward.addEventListener('click', () => this.seekBy(SKIP_FORWARD));
    this.el.sleep.addEventListener('click', () => this.toggleSleepTimer());

    // ミニバーのタイトルタップ → フルプレイヤーを開く
    this.el.miniTitles.addEventListener('click', () => {
      if (this.current) this.expandPlayer();
    });
    // フルプレイヤーの閉じるボタン（再生は継続）
    this.el.fpCollapse.addEventListener('click', () => this.collapsePlayer());
    // フルプレイヤーの番組名タップ → エピソード一覧へ
    this.el.fpShowTitle.addEventListener('click', () => {
      if (!this.current) return;
      this.collapsePlayer();
      this.onOpenShow?.(this.current.show);
    });
    // エピソード詳細（AI 分析）ボタン
    this.el.fpOpenEpisode.addEventListener('click', () => {
      if (!this.current) return;
      this.collapsePlayer();
      this.onOpenEpisode?.(this.current.show, this.current.episode);
    });
    // 概要内のタイムスタンプでシーク
    this.el.fpDesc.addEventListener('click', (e) => {
      const link = e.target.closest('.ts-link');
      if (link && this.current) {
        this.playEpisodeAt(this.current.show, this.current.episode, Number(link.dataset.sec));
      }
    });

    // 再生設定シートの開閉
    this.el.settings.addEventListener('click', () => {
      this.el.settingsOverlay.classList.remove('hidden');
      this._applyRate();
    });
    this.el.settingsOverlay.addEventListener('click', (e) => {
      if (e.target === this.el.settingsOverlay) {
        this.el.settingsOverlay.classList.add('hidden');
      }
    });

    // 倍速の選択（セグメント）
    this.el.rateOptions.querySelectorAll('[data-rate]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!this.current) return;
        setShowRate(this.current.show.id, Number(btn.dataset.rate));
        this._applyRate();
        scheduleSync();
      });
    });
    this.el.range.addEventListener('input', () => {
      this._seeking = true;
      this.el.current.textContent = fmtTime(Number(this.el.range.value));
    });
    this.el.range.addEventListener('change', () => {
      this.audio.currentTime = Number(this.el.range.value);
      this._seeking = false;
    });
  }

  _bindAudio() {
    const a = this.audio;
    a.addEventListener('loadedmetadata', () => {
      this.el.range.max = String(Math.floor(a.duration) || 0);
      this.el.duration.textContent = fmtTime(a.duration);
      this._applyRate(); // load() で playbackRate がリセットされるため再適用
    });
    a.addEventListener('play', () => this._applyRate());
    a.addEventListener('timeupdate', () => {
      // 睡眠タイマー: バックグラウンドでも再生中は timeupdate が発火するのでここでも判定
      this._checkSleepTimer();
      this._checkOutroSkip();
      if (!this._seeking) {
        this.el.range.value = String(Math.floor(a.currentTime));
        this.el.current.textContent = fmtTime(a.currentTime);
      }
      // 5秒ごとに再生位置を保存
      if (this.current && Math.abs(a.currentTime - this._lastSaved) >= 5) {
        this._lastSaved = a.currentTime;
        setPosition(this.current.key, a.currentTime);
      }
    });
    a.addEventListener('play', () => {
      this._setPlayingUi(true);
      this.expandPlayer(); // 再生中はフルプレイヤー表示
    });
    a.addEventListener('pause', () => {
      this._setPlayingUi(false);
      this.collapsePlayer(); // 停止中はミニバー表示
      // outro 自動終了後は「聴き終わり(位置0)」の記録を上書きしない
      if (this.current && !this._outroDone) {
        setPosition(this.current.key, a.currentTime);
        scheduleSync(); // 一時停止のタイミングで再生位置を他端末へ同期
      }
    });
    a.addEventListener('ended', () => {
      if (this.current) setPosition(this.current.key, 0);
      setNowPlaying(null);
      this._setPlayingUi(false);
      scheduleSync();
    });
    a.addEventListener('error', () => {
      this.el.epTitle.textContent = '再生エラー: ' + (this.current?.episode.title || '');
    });
  }

  _bindMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => this.audio.play());
    ms.setActionHandler('pause', () => this.audio.pause());
    ms.setActionHandler('seekbackward', () => this.seekBy(-SKIP_BACK));
    ms.setActionHandler('seekforward', () => this.seekBy(SKIP_FORWARD));
    // AirPods のダブルタップ（次のトラック）→ 15秒スキップ、
    // トリプルタップ（前のトラック）→ 30秒巻き戻し
    try {
      ms.setActionHandler('nexttrack', () => this.seekBy(SKIP_FORWARD));
      ms.setActionHandler('previoustrack', () => this.seekBy(-SKIP_BACK));
    } catch { /* 未対応ブラウザは無視 */ }
  }

  _setPlayingUi(playing) {
    this.el.iconPlay.classList.toggle('hidden', playing);
    this.el.iconPause.classList.toggle('hidden', !playing);
    this.el.iconPlayMini.classList.toggle('hidden', playing);
    this.el.iconPauseMini.classList.toggle('hidden', !playing);
  }

  // フルプレイヤー（再生画面）を開く / 閉じる
  expandPlayer() {
    if (!this.current) return;
    this.el.fullPlayer.classList.remove('hidden');
    this.el.bar.classList.add('hidden');
  }

  collapsePlayer() {
    this.el.fullPlayer.classList.add('hidden');
    if (this.current) this.el.bar.classList.remove('hidden');
  }

  // 番組ごとの再生速度を audio・セグメント表示・設定ボタンに反映
  _applyRate() {
    if (!this.current) return;
    const rate = getShowRate(this.current.show.id);
    this.audio.playbackRate = rate;
    this.audio.defaultPlaybackRate = rate;
    this.el.rateOptions.querySelectorAll('[data-rate]').forEach((btn) => {
      btn.classList.toggle('active', Number(btn.dataset.rate) === rate);
    });
    this._updateSettingsStatus();
  }

  // 設定ボタン横に現在の状態（倍速・タイマー残り）を要約表示
  _updateSettingsStatus() {
    const parts = [];
    if (this.current) {
      const rate = getShowRate(this.current.show.id);
      if (rate !== 1) parts.push(rate.toFixed(1) + 'x');
    }
    if (this._sleepDeadline) {
      parts.push(Math.ceil((this._sleepDeadline - Date.now()) / 60000) + '分');
    }
    this.el.settingsStatus.textContent = parts.join('・');
    this.el.settings.classList.toggle('active', !!this._sleepDeadline);
  }

  // ---- 睡眠タイマー（20分で自動停止） ----

  toggleSleepTimer() {
    if (this._sleepDeadline) {
      this._clearSleepTimer();
      return;
    }
    this._sleepDeadline = Date.now() + SLEEP_MINUTES * 60 * 1000;
    this.el.sleep.classList.add('active');
    this._updateSleepLabel();
    this._sleepInterval = setInterval(() => this._checkSleepTimer(), 10000);
  }

  _checkSleepTimer() {
    if (!this._sleepDeadline) return;
    if (Date.now() >= this._sleepDeadline) {
      this.audio.pause();
      this._clearSleepTimer();
    } else {
      this._updateSleepLabel();
    }
  }

  _updateSleepLabel() {
    const remainMin = Math.ceil((this._sleepDeadline - Date.now()) / 60000);
    this.el.sleepLabel.textContent = `残り ${remainMin}分（タップで解除）`;
    this._updateSettingsStatus();
  }

  _clearSleepTimer() {
    clearInterval(this._sleepInterval);
    this._sleepInterval = null;
    this._sleepDeadline = null;
    this.el.sleep.classList.remove('active');
    this.el.sleepLabel.textContent = SLEEP_MINUTES + '分で停止';
    this._updateSettingsStatus();
  }

  // エピソードの終わり手前で自動終了（番組ごとの outro 設定）
  _checkOutroSkip() {
    if (!this.current || this._outroDone || this.audio.paused) return;
    const { outro } = getShowSkip(this.current.show.id);
    const d = this.audio.duration;
    if (outro > 0 && Number.isFinite(d) && this.audio.currentTime >= d - outro) {
      this._outroDone = true; // 再度再生ボタンを押せば最後まで聴ける
      this.audio.pause();
      this._setPlayingUi(false); // pause() が play() に割り込むと pause イベントが出ないため明示更新
      setPosition(this.current.key, 0); // 聴き終わり扱いにする
      setNowPlaying(null);
      scheduleSync();
    }
  }

  // 指定エピソードの指定秒数へジャンプして再生（概要のタイムスタンプリンク用）
  playEpisodeAt(show, episode, sec) {
    const key = episodeKey(show.id, episode);
    if (this.current?.key === key) {
      if (this.audio.readyState > 0) {
        this.audio.currentTime = sec;
      } else {
        this.audio.addEventListener(
          'loadedmetadata',
          () => { this.audio.currentTime = sec; },
          { once: true }
        );
      }
      if (this.audio.paused) this.audio.play().catch((e) => console.warn('play failed:', e));
      return;
    }
    if (this.current) setPosition(this.current.key, this.audio.currentTime);
    this._load(show, episode, key, { play: true, startAt: sec });
  }

  // エピソードをプレイヤーバーにロードする（play=false ならリロード後の復元表示のみ）
  _load(show, episode, key, { play, startAt: startAtOverride }) {
    this.current = { show, episode, key };
    this._lastSaved = 0;
    this._outroDone = false;
    this.audio.src = episode.enclosureUrl;

    // 指定位置 > 再開位置 > 冒頭スキップ設定 の優先順で開始位置を決める
    const resumeAt = getPosition(key);
    const { intro } = getShowSkip(show.id);
    const startAt = startAtOverride ?? (resumeAt > 5 ? resumeAt : intro);
    if (startAt > 0) {
      this.audio.addEventListener(
        'loadedmetadata',
        () => { this.audio.currentTime = startAt; },
        { once: true }
      );
    }

    // ミニバーとフルプレイヤー両方の表示内容を更新
    this.el.epTitle.textContent = episode.title;
    this.el.showTitle.textContent = show.title;
    this.el.artwork.src = show.artwork || '';
    this.el.fpEpTitle.textContent = episode.title;
    this.el.fpShowTitle.textContent = show.title;
    this.el.fpDesc.innerHTML = episode.description
      ? linkifyTimestamps(esc(episode.description))
      : '<span class="ai-note">このエピソードには概要がありません</span>';
    this.el.range.value = String(Math.floor(startAt));
    this.el.current.textContent = fmtTime(startAt);
    this.el.duration.textContent = episode.durationSec ? fmtTime(episode.durationSec) : '--:--';
    this._applyRate();
    if (play) this.expandPlayer();
    else this.collapsePlayer(); // 復元時はミニバーのみ

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: episode.title,
        artist: show.title,
        artwork: show.artwork ? [{ src: show.artwork, sizes: '600x600' }] : [],
      });
    }

    setNowPlaying({ show, episode });
    if (play) {
      this.audio.play().catch((e) => console.warn('play failed:', e));
      this.onPlayStarted?.(show, episode);
    }
  }

  playEpisode(show, episode) {
    const key = episodeKey(show.id, episode);

    // 同じエピソードならトグルとして扱う
    if (this.current?.key === key) {
      this.toggle();
      return;
    }

    if (this.current) setPosition(this.current.key, this.audio.currentTime);
    this._load(show, episode, key, { play: true });
  }

  // ページ読み込み時に前回の再生中エピソードを復元（再生はユーザー操作待ち）
  restore() {
    const np = getNowPlaying();
    if (!np?.show || !np?.episode) return;
    this._load(np.show, np.episode, episodeKey(np.show.id, np.episode), { play: false });
  }

  toggle() {
    if (this.audio.paused) {
      this.audio.play().catch((e) => console.warn('play failed:', e));
    } else {
      this.audio.pause();
    }
  }

  seekBy(sec) {
    const d = this.audio.duration || Infinity;
    this.audio.currentTime = Math.max(0, Math.min(d, this.audio.currentTime + sec));
  }

  isPlayingEpisode(key) {
    return this.current?.key === key && !this.audio.paused;
  }
}
