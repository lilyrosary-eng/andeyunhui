// 对话 Tab 动作桥接（T07）。
//
// 背景：全局 AppBar（MobileApp 渲染）的右侧按钮（⊕ 新建会话 / ⋮ 溢出）需触发
// ChatHome 内 useAiStream 的方法，但 AppBar 与 ChatHome 是兄弟节点，无直接 props 通道。
// 这里用 zustand 做「回调注册表」：ChatHome 挂载时注册实现，AppBar 按钮调 chatStore。
//
// 不放对话状态本身（messages/busy 仍在 useAiStream 内），仅放跨组件的动作句柄，
// 避免把 hook 状态拍平到全局 store（保持 hook 内聚，符合 §6.3 组件职责分离）。

import { create } from 'zustand';

interface ChatStore {
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
}

export const useChatStore = create<ChatStore>((set) => ({
  newConversation: null,
  openOverflow: null,
  openSourcePicker: null,
  sourceLabel: null,
  setNewConversation: (fn) => set({ newConversation: fn }),
  setOpenOverflow: (fn) => set({ openOverflow: fn }),
  setOpenSourcePicker: (fn) => set({ openSourcePicker: fn }),
  setSourceLabel: (label) => set({ sourceLabel: label }),
}));
