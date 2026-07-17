import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import { api } from '@/lib/api';
import { logger } from '@/lib/logger';
import type { PluginRegistry } from '@/core/pluginRegistry';
import { useNotesStore } from './notesStore';
import { useFloatingNoteStore } from './floatingNoteStore';

/**
 * 应用域状态：模块导航、插件 registry、编辑器设置。
 */
interface AppState {
  // 插件
  pluginRegistry: PluginRegistry | null;
  /** 插件可见性变化计数器，用于触发 mainPluginIds 重算 */
  visibilityTick: number;

  // 模块导航
  activeModule: string;
  /** 已访问过的模块集合（按需加载追踪） */
  activatedPlugins: Set<string>;

  // 编辑器设置
  showNoteSettings: boolean;
  wordWrap: boolean;
  vimMode: boolean;

  // 茑萝拓展设置面板切换
  showExtensionSettings: boolean;

  // ---- actions ----
  setPluginRegistry: (r: PluginRegistry | null) => void;
  bumpVisibility: () => void;
  setActiveModule: (m: string) => void;
  toggleNoteSettings: () => void;
  setWordWrap: (v: boolean) => void;
  setVimMode: (v: boolean) => void;
  toggleExtensionSettings: () => void;
  /** 注册浮窗事件监听，返回 cleanup */
  initFloatingNoteListeners: () => () => void;
}

export const useAppStore = create<AppState>((set) => ({
  pluginRegistry: null,
  visibilityTick: 0,
  activeModule: 'notes',
  activatedPlugins: new Set(),
  showNoteSettings: false,
  wordWrap: true,
  vimMode: false,
  showExtensionSettings: false,

  setPluginRegistry: (pluginRegistry) => set({ pluginRegistry }),
  bumpVisibility: () => set(s => ({ visibilityTick: s.visibilityTick + 1 })),

  setActiveModule: (m) => {
    logger.app.switchModule(m);
    // 上报当前激活模块给 Rust，用于任务栏媒体会话优先级：视频模块→视频优先，其余→音乐优先。
    window.__HOST_API__?.invoke('debug_log', { msg: `FE set_active_module ${m}` }).catch(() => {});
    window.__HOST_API__?.invoke('set_active_module', { module: m }).catch(() => {
      /* 忽略：Rust 端未实现或非 Windows 时不阻塞前端 */
    });
    set(state => ({
      activeModule: m,
      showNoteSettings: false,
      activatedPlugins: new Set(state.activatedPlugins).add(m),
    }));
  },

  toggleNoteSettings: () => {
    set(s => {
      logger.notes.toggleSettings(!s.showNoteSettings);
      return { showNoteSettings: !s.showNoteSettings };
    });
  },

  setWordWrap: (wordWrap) => set({ wordWrap }),
  setVimMode: (vimMode) => set({ vimMode }),
  toggleExtensionSettings: () => set(s => ({ showExtensionSettings: !s.showExtensionSettings })),

  initFloatingNoteListeners: () => {
    // 浮窗打开 → 加入集合，若当前编辑的是该笔记则清空编辑器
    const unlistenOpen = listen<string>('floating-note-opened', (event) => {
      const id = event.payload;
      useFloatingNoteStore.getState().addFloating(id);
      const { currentNoteId } = useNotesStore.getState();
      if (currentNoteId === id) {
        useNotesStore.getState().clearCurrent();
      }
    });

    // 浮窗关闭 → 从集合移除 + 刷新笔记列表
    const unlistenClose = listen<{ noteId: string }>('floating-note-closed', (event) => {
      const { noteId } = event.payload;
      useFloatingNoteStore.getState().removeFloating(noteId);
      api.getAllNotes().then(data => {
        useNotesStore.getState().setNotes(data);
        logger.notes.listLoaded(data.length);
      }).catch((err) => logger.notes.loadError('浮窗关闭后刷新笔记列表', err));
    });

    return () => {
      unlistenOpen.then(fn => fn());
      unlistenClose.then(fn => fn());
    };
  },
}));
