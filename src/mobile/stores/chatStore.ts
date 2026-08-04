// 对话 Tab 动作桥接（T07）+ 多会话历史（T08）。
//
// 背景：全局 AppBar（MobileApp 渲染）的右侧按钮（⊕ 新建会话 / ⋮ 溢出）需触发
// ChatHome 内 useAiStream 的方法，但 AppBar 与 ChatHome 是兄弟节点，无直接 props 通道。
// 这里用 zustand 做「回调注册表」：ChatHome 挂载时注册实现，AppBar 按钮调 chatStore。
//
// T08 扩展：会话历史列表（AI 对话侧边栏需求）。
//   conversations: 全部会话（最新在前），持久化到 localStorage（key 同桌面 capsule，
//   但结构是移动端 TimelineItem 扁平时间线，字段不同，单独 key 避免混用）。
//   新建会话 / 切换会话 / 删除会话 全部在此 store 完成；useAiStream 只读写
//   "当前活跃会话" 的 timeline，切会话时由 store 通知。

import { create } from 'zustand';
import type { TimelineItem } from '../types/chat';

/** 一个会话。timeline 是移动端扁平时间线（消息/分隔/降级）。 */
export interface Conversation {
  id: string;
  title: string;
  timeline: TimelineItem[];
  /** 最后活跃时间戳（排序用） */
  updatedAt: number;
}

const CHAT_KEY = 'andeyunhui.mobile.conversations';

function loadConvs(): Conversation[] {
  try {
    const raw = localStorage.getItem(CHAT_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as Conversation[];
      if (Array.isArray(arr) && arr.length) return arr;
    }
  } catch { /* 解析失败忽略 */ }
  return [];
}

function persist(convs: Conversation[]) {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(convs)); } catch { /* 忽略 */ }
}

function uid(prefix: string): string {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 从首条用户消息生成会话标题 */
function titleFromTimeline(tl: TimelineItem[]): string {
  const first = tl.find((it) => it.type === 'message' && it.msg.role === 'user');
  if (!first || first.type !== 'message') return '新对话';
  const t = first.msg.content.trim().replace(/\s+/g, ' ');
  return t.length > 16 ? t.slice(0, 16) + '…' : t;
}

interface ChatStore {
  /** 全部会话，最新在前 */
  conversations: Conversation[];
  /** 当前活跃会话 id */
  activeConvId: string;

  /** 新建会话（清空当前对话） */
  newConversation: (() => void) | null;
  /** 打开溢出菜单（BottomSheet） */
  openOverflow: (() => void) | null;
  /** 打开算力来源选择（BottomSheet） */
  openSourcePicker: (() => void) | null;
  /** 当前算力来源显示名（AppBar 副标题用，可选） */
  sourceLabel: string | null;

  setNewConversation: (fn: (() => void) | null) => void;
  setOpenOverflow: (fn: (() => void) | null) => void;
  setOpenSourcePicker: (fn: (() => void) | null) => void;
  setSourceLabel: (label: string | null) => void;

  /** 创建新会话并激活（清空输入态由 ChatScreen 监听 activeConvId 处理） */
  createConversation: () => string;
  /** 切换会话 */
  selectConversation: (id: string) => void;
  /** 删除会话（删除活跃会话时自动切到剩余第一个） */
  deleteConversation: (id: string) => void;
  /** 更新指定会话的 timeline（流式写入 / 重试等），并刷新 updatedAt */
  updateTimeline: (convId: string, updater: (tl: TimelineItem[]) => TimelineItem[]) => void;
  /** 根据当前会话 timeline 刷新会话标题（首条用户消息） */
  refreshTitle: (convId: string) => void;
}

export const useChatStore = create<ChatStore>((set, get) => {
  const initial = loadConvs();
  const defaultConv: Conversation = {
    id: uid('c_'),
    title: '新对话',
    timeline: [],
    updatedAt: Date.now(),
  };
  const conversations = initial.length ? initial : [defaultConv];

  return {
    conversations,
    activeConvId: conversations[0].id,

    newConversation: null,
    openOverflow: null,
    openSourcePicker: null,
    sourceLabel: null,

    setNewConversation: (fn) => set({ newConversation: fn }),
    setOpenOverflow: (fn) => set({ openOverflow: fn }),
    setOpenSourcePicker: (fn) => set({ openSourcePicker: fn }),
    setSourceLabel: (label) => set({ sourceLabel: label }),

    createConversation: () => {
      const id = uid('c_');
      const conv: Conversation = { id, title: '新对话', timeline: [], updatedAt: Date.now() };
      set((s) => {
        const next = [conv, ...s.conversations];
        persist(next);
        return { conversations: next, activeConvId: id };
      });
      return id;
    },

    selectConversation: (id) => {
      if (get().activeConvId === id) return;
      const exists = get().conversations.some((c) => c.id === id);
      if (!exists) return;
      set({ activeConvId: id });
    },

    deleteConversation: (id) => {
      const s = get();
      const next = s.conversations.filter((c) => c.id !== id);
      if (next.length === 0) {
        // 全删后补一个空会话
        const fresh: Conversation = { id: uid('c_'), title: '新对话', timeline: [], updatedAt: Date.now() };
        persist([fresh]);
        set({ conversations: [fresh], activeConvId: fresh.id });
        return;
      }
      persist(next);
      set({
        conversations: next,
        activeConvId: s.activeConvId === id ? next[0].id : s.activeConvId,
      });
    },

    updateTimeline: (convId, updater) => {
      set((s) => {
        const next = s.conversations.map((c) =>
          c.id === convId
            ? { ...c, timeline: updater(c.timeline), updatedAt: Date.now() }
            : c,
        );
        persist(next);
        return { conversations: next };
      });
    },

    refreshTitle: (convId) => {
      set((s) => {
        const next = s.conversations.map((c) => {
          if (c.id !== convId || (c.title !== '新对话' && c.title.trim())) return c;
          return { ...c, title: titleFromTimeline(c.timeline) };
        });
        persist(next);
        return { conversations: next };
      });
    },
  };
});
