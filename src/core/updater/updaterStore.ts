import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { storage } from '@/core/storage';
import { KEYS } from '@/core/storage/keys';

export interface UpdateInfo {
  supported: boolean;
  available: boolean;
  currentVersion: string;
  version?: string;
  date?: string;
  body?: string;
  downloadUrl?: string;
  /** 安装包大小（清单 size，字节） */
  size?: number;
}

export interface UpdateLastStatus {
  status: 'success' | 'failed';
  version?: string;
  error?: string;
  timestamp?: number;
}

type UpdaterPhase =
  | 'idle'
  | 'checking'
  | 'latest'
  | 'available'
  | 'downloading'
  | 'installing'
  | 'error';

interface UpdateProgressEvent {
  phase: 'downloading' | 'installing';
  version: string;
  downloaded: number;
  total?: number | null;
  speed?: number;
}

interface UpdaterState {
  initialized: boolean;
  phase: UpdaterPhase;
  info: UpdateInfo | null;
  downloaded: number;
  total: number;
  speed: number;
  error: string;
  dismissed: boolean;
  lastStatus: UpdateLastStatus | null;
  init: () => void;
  check: (manual?: boolean) => Promise<void>;
  startUpdate: () => Promise<void>;
  cancel: () => Promise<void>;
  dismiss: () => void;
  clearLastStatus: () => void;
}

export const isWindowsDesktop =
  typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

let unlisten: UnlistenFn | null = null;
let autoTimer: number | null = null;
let statusTimer: number | null = null;
let cancelRequested = false;

function setLastCheckNow() {
  storage.setString(KEYS.updater.lastCheck.key, String(Date.now()));
}

export const useUpdaterStore = create<UpdaterState>((set, get) => ({
  initialized: false,
  phase: 'idle',
  info: null,
  downloaded: 0,
  total: 0,
  speed: 0,
  error: '',
  dismissed: false,
  lastStatus: null,

  init: () => {
    if (get().initialized) return;
    set({ initialized: true });
    if (!isWindowsDesktop) return;

    void (async () => {
      try {
        unlisten = await listen<UpdateProgressEvent>('update-progress', (event) => {
          const payload = event.payload;
          if (payload.phase === 'downloading') {
            set({
              phase: 'downloading',
              downloaded: payload.downloaded,
              total: payload.total ?? 0,
              speed: payload.speed ?? 0,
            });
          } else if (payload.phase === 'installing') {
            set({ phase: 'installing', speed: 0 });
          }
        });
      } catch {
        // 事件监听失败不阻塞更新；设置页仍可手动检查。
      }

      try {
        const status = await invoke<UpdateLastStatus | null>('update_take_status');
        if (status && (status.status === 'success' || status.status === 'failed')) {
          set({ lastStatus: status });
          if (statusTimer !== null) window.clearTimeout(statusTimer);
          statusTimer = window.setTimeout(() => set({ lastStatus: null }), 12000);
        }
      } catch {
        // 非 Windows 或首次安装没有状态文件：忽略。
      }

      autoTimer = window.setTimeout(() => {
        const last = Number(storage.getString(KEYS.updater.lastCheck.key, '0')) || 0;
        if (Date.now() - last > 24 * 60 * 60 * 1000) {
          void get().check(false);
        }
      }, 15_000);
    })();

    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        unlisten?.();
        unlisten = null;
        if (autoTimer !== null) window.clearTimeout(autoTimer);
        if (statusTimer !== null) window.clearTimeout(statusTimer);
      });
    }
  },

  check: async (manual = true) => {
    const phase = get().phase;
    if (phase === 'checking' || phase === 'downloading' || phase === 'installing') return;

    set({ phase: 'checking', error: '', dismissed: false });
    try {
      const info = await invoke<UpdateInfo>('update_check');
      setLastCheckNow();
      if (!info.supported) {
        set({ phase: 'idle', info });
        return;
      }
      set({
        info,
        phase: info.available ? 'available' : 'latest',
        downloaded: 0,
        total: 0,
        speed: 0,
      });
    } catch (error) {
      // 自动检查失败静默，不打扰用户；手动检查才显示错误。
      set({
        phase: manual ? 'error' : 'idle',
        error: manual ? String(error) : '',
      });
    }
  },

  startUpdate: async () => {
    const phase = get().phase;
    if (phase === 'downloading' || phase === 'installing') return;

    cancelRequested = false;
    set({
      phase: 'downloading',
      downloaded: 0,
      total: get().info?.size ?? 0,
      speed: 0,
      error: '',
      dismissed: false,
    });
    try {
      await invoke('update_download_and_apply');
      // 成功时后端会在约 1.5s 后退出应用；这里通常不会继续执行。
    } catch (error) {
      const message = String(error);
      if (cancelRequested || message.includes('取消')) {
        set({
          phase: get().info?.available ? 'available' : 'idle',
          downloaded: 0,
          total: 0,
          speed: 0,
          error: '',
        });
      } else {
        set({ phase: 'error', error: message, speed: 0 });
      }
      cancelRequested = false;
    }
  },

  cancel: async () => {
    if (get().phase !== 'downloading') return;
    cancelRequested = true;
    try {
      await invoke('update_cancel');
    } catch {
      // 任务可能刚好结束；以 startUpdate 的最终状态为准。
    }
    set({
      phase: get().info?.available ? 'available' : 'idle',
      downloaded: 0,
      total: 0,
      speed: 0,
      error: '',
    });
  },

  dismiss: () => set({ dismissed: true }),
  clearLastStatus: () => set({ lastStatus: null }),
}));
