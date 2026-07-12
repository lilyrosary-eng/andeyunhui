// 音乐播放器单例 — 在插件 IIFE 作用域内，不依赖宿主
interface Track {
  id: string;
  filePath: string;
  title: string;
  artist: string;
  album: string;
  durationSecs: number;
  coverPath?: string;
}

type PlayMode = 'list' | 'single' | 'random';
type PlayerEvent = 'play' | 'pause' | 'trackChange' | 'progress' | 'end';

class MusicPlayer {
  private audio: HTMLAudioElement;
  private tracks: Track[] = [];
  private currentIndex: number = -1;
  private isPlaying: boolean = false;
  private volume: number = 0.7;
  private playMode: PlayMode = 'list';
  private shuffleIndices: number[] = [];
  // 持久化：当前播放的歌单 ID，组件重载时恢复选中状态
  currentPlaylistId: string | null = null;
  private eventListeners: Record<PlayerEvent, Set<(data: unknown) => void>> = {
    play: new Set(),
    pause: new Set(),
    trackChange: new Set(),
    progress: new Set(),
    end: new Set(),
  };

  constructor() {
    this.audio = new Audio();
    this.audio.volume = this.volume;
    this.audio.preload = 'metadata';
    this.bindEvents();
  }

  private bindEvents(): void {
    this.audio.addEventListener('play', () => {
      this.isPlaying = true;
      this.emit('play', null);
    });
    this.audio.addEventListener('pause', () => {
      this.isPlaying = false;
      this.emit('pause', null);
    });
    this.audio.addEventListener('ended', () => {
      this.emit('end', null);
      this.handleEnded();
    });
    this.audio.addEventListener('timeupdate', () => {
      this.emit('progress', {
        currentTime: this.audio.currentTime,
        duration: this.audio.duration || 0,
      });
    });
  }

  private emit(event: PlayerEvent, data: unknown): void {
    this.eventListeners[event].forEach(listener => listener(data));
  }

  on(event: PlayerEvent, listener: (data: unknown) => void): () => void {
    this.eventListeners[event].add(listener);
    return () => { this.eventListeners[event].delete(listener); };
  }

  setTracks(tracks: Track[], startIndex: number = 0): void {
    this.tracks = tracks;
    // 切换歌单时必须重置随机序列：旧 shuffleIndices 基于旧歌单长度，
    // 若新歌单更长则超出旧长度的歌曲永远不会被随机到，反之则索引越界。
    this.shuffleIndices = [];
    if (startIndex >= 0 && startIndex < tracks.length) {
      this.currentIndex = startIndex;
      this.loadTrack(startIndex);
    }
  }

  private loadTrack(index: number): void {
    if (index < 0 || index >= this.tracks.length) return;
    const track = this.tracks[index];
    const src = window.__HOST_API__?.convertFileSrc(track.filePath);
    if (src) {
      this.audio.src = src;
      this.currentIndex = index;
      this.emit('trackChange', track);
    }
  }

  play(): void {
    if (this.currentIndex < 0 && this.tracks.length > 0) {
      this.currentIndex = 0;
      this.loadTrack(0);
    }
    this.audio.play().catch((err) => {
      console.warn('[MusicPlayer] 播放被阻止或失败:', err.message);
      this.emit('pause', undefined);
    });
  }

  pause(): void {
    this.audio.pause();
  }

  togglePlay(): void {
    if (this.isPlaying) { this.pause(); } else { this.play(); }
  }

  private handleEnded(): void {
    const nextIndex = this.getNextIndex();
    if (nextIndex >= 0) {
      this.loadTrack(nextIndex);
      this.play();
    } else {
      this.pause();
    }
  }

  private getNextIndex(): number {
    if (this.tracks.length === 0) return -1;
    switch (this.playMode) {
      case 'single': return this.currentIndex;
      case 'random':
        if (this.shuffleIndices.length === 0) {
          this.shuffleIndices = this.tracks.map((_, i) => i);
          for (let i = this.shuffleIndices.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.shuffleIndices[i], this.shuffleIndices[j]] = [this.shuffleIndices[j], this.shuffleIndices[i]];
          }
        }
        const cur = this.shuffleIndices.indexOf(this.currentIndex);
        return this.shuffleIndices[(cur + 1) % this.shuffleIndices.length];
      default: return (this.currentIndex + 1) % this.tracks.length;
    }
  }

  private getPrevIndex(): number {
    if (this.tracks.length === 0) return -1;
    switch (this.playMode) {
      case 'single': return this.currentIndex;
      case 'random':
        if (this.shuffleIndices.length === 0) return (this.currentIndex - 1 + this.tracks.length) % this.tracks.length;
        const cur = this.shuffleIndices.indexOf(this.currentIndex);
        return this.shuffleIndices[(cur - 1 + this.shuffleIndices.length) % this.shuffleIndices.length];
      default: return (this.currentIndex - 1 + this.tracks.length) % this.tracks.length;
    }
  }

  next(): void {
    const idx = this.getNextIndex();
    if (idx >= 0) { this.loadTrack(idx); if (this.isPlaying) this.play(); }
  }

  prev(): void {
    const idx = this.getPrevIndex();
    if (idx >= 0) { this.loadTrack(idx); if (this.isPlaying) this.play(); }
  }

  seek(time: number): void { this.audio.currentTime = time; }
  setVolume(vol: number): void { this.volume = Math.max(0, Math.min(1, vol)); this.audio.volume = this.volume; }
  setPlayMode(mode: PlayMode): void { this.playMode = mode; if (mode !== 'random') this.shuffleIndices = []; }
  getIsPlaying(): boolean { return this.isPlaying; }
  getCurrentTrack(): Track | null { return this.tracks[this.currentIndex] || null; }
  getCurrentIndex(): number { return this.currentIndex; }
  getTracks(): Track[] { return this.tracks; }
  getVolume(): number { return this.volume; }
  getPlayMode(): PlayMode { return this.playMode; }
  getCurrentTime(): number { return this.audio.currentTime || 0; }
  getDuration(): number { return this.audio.duration || 0; }

  /**
   * 释放播放器持有的所有资源：暂停音频、清空 src、移除事件监听。
   * 由 PluginHost 在插件卸载/重载前调用 destroy 钩子触发。
   * 调用后清除 window.__MUSIC_PLAYER__ 全局引用，使下次加载创建全新实例，
   * 避免复用「已销毁」的旧实例（audio.src 已清空、监听器已清空）导致功能失效。
   */
  destroy(): void {
    try {
      this.audio.pause();
      this.audio.src = '';
      this.audio.removeAttribute('src');
      this.audio.load();
    } catch { /* 忽略：audio 已处于异常态 */ }
    // 清空所有事件监听器，防止孤儿回调
    (Object.keys(this.eventListeners) as PlayerEvent[]).forEach(k => {
      this.eventListeners[k].clear();
    });
    this.tracks = [];
    this.currentIndex = -1;
    this.isPlaying = false;
    // 清除全局引用，使重载时 `globalWin.__MUSIC_PLAYER__ ?? new MusicPlayer()` 走新建分支
    const w = window as unknown as { __MUSIC_PLAYER__?: MusicPlayer };
    if (w.__MUSIC_PLAYER__ === this) {
      delete w.__MUSIC_PLAYER__;
    }
  }
}

// 单例：热重载时若 window.__MUSIC_PLAYER__ 已被 destroy 清除，则新建实例。
// window.__MUSIC_PLAYER__ 由全局类型声明定义，供跨模块访问（如歌词悬浮窗）。
const globalWin = window as unknown as { __MUSIC_PLAYER__?: MusicPlayer };
export const musicPlayer: MusicPlayer = globalWin.__MUSIC_PLAYER__ ?? new MusicPlayer();
globalWin.__MUSIC_PLAYER__ = musicPlayer;
export type { Track, PlayMode };