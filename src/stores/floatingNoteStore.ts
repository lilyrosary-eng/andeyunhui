import { create } from 'zustand';

/**
 * 浮窗笔记 ID 集合：记录已打开为独立窗口的笔记，
 * 主列表据此过滤（不在列表中重复显示）。
 */
interface FloatingNoteState {
  floatingNoteIds: Set<string>;
  addFloating: (id: string) => void;
  removeFloating: (id: string) => void;
  /** 批量替换（预留） */
  setFloating: (ids: Set<string>) => void;
}

export const useFloatingNoteStore = create<FloatingNoteState>((set) => ({
  floatingNoteIds: new Set(),
  addFloating: (id) => set(s => {
    const next = new Set(s.floatingNoteIds);
    next.add(id);
    return { floatingNoteIds: next };
  }),
  removeFloating: (id) => set(s => {
    const next = new Set(s.floatingNoteIds);
    next.delete(id);
    return { floatingNoteIds: next };
  }),
  setFloating: (floatingNoteIds) => set({ floatingNoteIds }),
}));
