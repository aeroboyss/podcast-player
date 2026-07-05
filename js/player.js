// <audio> 制御・Media Session・再生位置の保存/復元

import { episodeKey, getPosition, setPosition } from './storage.js';
import { scheduleSync } from './sync.js';

const SKIP_FORWARD = 15;
const SKIP_BACK = 30;

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
      artwork: document.getElementById('player-artwork'),
      epTitle: document.getElementById('player-episode-title'),
      showTitle: document.getElementById('player-show-title'),
      range: document.getElementById('player-range'),
      current: document.getElementById('player-current'),
      duration: document.getElementById('player-duration'),
      play: document.getElementById('btn-play'),
      iconPlay: document.getElementById('icon-play'),
      iconPause: document.getElementById('icon-pause'),
      rewind: document.getElementById('btn-rewind'),
      forward: document.getElementById('btn-forward'),
    };

    this._bindUi();
    this._bindAudio();
    this._bindMediaSession();
  }

  _bindUi() {
    this.el.play.addEventListener('click', () => this.toggle());
    this.el.rewind.addEventListener('click', () => this.seekBy(-SKIP_BACK));
    this.el.forward.addEventListener('click', () => this.seekBy(SKIP_FORWARD));
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
    });
    a.addEventListener('timeupdate', () => {
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
    a.addEventListener('play', () => this._setPlayingUi(true));
    a.addEventListener('pause', () => {
      this._setPlayingUi(false);
      if (this.current) {
        setPosition(this.current.key, a.currentTime);
        scheduleSync(); // 一時停止のタイミングで再生位置を他端末へ同期
      }
    });
    a.addEventListener('ended', () => {
      if (this.current) setPosition(this.current.key, 0);
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
  }

  _setPlayingUi(playing) {
    this.el.iconPlay.classList.toggle('hidden', playing);
    this.el.iconPause.classList.toggle('hidden', !playing);
  }

  playEpisode(show, episode) {
    const key = episodeKey(show.id, episode);

    // 同じエピソードならトグルとして扱う
    if (this.current?.key === key) {
      this.toggle();
      return;
    }

    if (this.current) setPosition(this.current.key, this.audio.currentTime);

    this.current = { show, episode, key };
    this._lastSaved = 0;
    this.audio.src = episode.enclosureUrl;

    const resumeAt = getPosition(key);
    if (resumeAt > 5) {
      this.audio.addEventListener(
        'loadedmetadata',
        () => { this.audio.currentTime = resumeAt; },
        { once: true }
      );
    }

    this.el.bar.classList.remove('hidden');
    this.el.artwork.src = show.artwork || '';
    this.el.epTitle.textContent = episode.title;
    this.el.showTitle.textContent = show.title;
    this.el.range.value = '0';
    this.el.current.textContent = fmtTime(resumeAt);
    this.el.duration.textContent = episode.durationSec ? fmtTime(episode.durationSec) : '--:--';

    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: episode.title,
        artist: show.title,
        artwork: show.artwork ? [{ src: show.artwork, sizes: '600x600' }] : [],
      });
    }

    this.audio.play().catch((e) => console.warn('play failed:', e));
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
