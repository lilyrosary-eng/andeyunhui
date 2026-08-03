/**
 * navStore — 移动端导航状态（zustand v5）。
 *
 * 设计依据：ANDROID-V1-HANDOFF §6.3 / §7.5。
 *
 * 模型：
 *   - 4 个 Tab 各持独立导航栈（stack），栈底为根 Screen。
 *   - 切换 Tab 不丢失各 Tab 的栈深度与滚动位置（由 NavStack 组件保留）。
 *   - drawerOpen / bottomSheetOpen 由本 store 统一管理，便于 Android 返回键
 *     按优先级集中拦截（MobileApp 内 listen 'android-back-pressed'）。
 *
 * 冷启动默认 Tab = 'transfer'（中转站），符合 §6.3 返回键归巢语义。
 */

import { create } from 'zustand';
import type { ReactNode } from 'react';

export type TabId = 'transfer' | 'chat' | 'discover' | 'profile';

/** 一个可渲染的屏幕实例。栈中每项即一个 Screen。 */
export interface Screen {
  /** 屏幕唯一标识，用作 AnimatePresence key */
  id: string;
  /** AppBar 标题 */
  title: string;
  /** 内容渲染函数；惰性调用以避免栈底屏也常驻 React 树 */
  render: () => ReactNode;
  /** 可选：AppBar 右侧操作 */
  appBarActions?: { icon: ReactNode; onClick: () => void; label?: string }[];
}

type NavStack = Screen[];

interface NavState {
  /** 当前激活 Tab */
  activeTab: TabId;
  /** 每个 Tab 的导航栈；栈底为根 Screen */
  tabs: Record<TabId, NavStack>;
  /** 左抽屉开合 */
  drawerOpen: boolean;
  /** 顶层 BottomSheet 开合（用于返回键优先级判断） */
  bottomSheetOpen: boolean;

  /** 推入新屏到指定 Tab 栈顶 */
  push: (tabId: TabId, screen: Screen) => void;
  /** 弹出指定 Tab 栈顶；根屏（栈深 1）不可弹 */
  pop: (tabId: TabId) => void;
  /** 切换激活 Tab（保留各 Tab 栈状态） */
  switchTab: (tabId: TabId) => void;
  /** 设置抽屉开合 */
  setDrawerOpen: (open: boolean) => void;
  /** 设置 BottomSheet 开合 */
  setBottomSheetOpen: (open: boolean) => void;
  /** 一次性初始化各 Tab 根 Screen（由 MobileApp 挂载时调用） */
  initRoots: (roots: Record<TabId, Screen>) => void;
}

export const useNavStore = create<NavState>()((set) => ({
  activeTab: 'transfer',
  tabs: {
    transfer: [],
    chat: [],
    discover: [],
    profile: [],
  },
  drawerOpen: false,
  bottomSheetOpen: false,

  push: (tabId, screen) =>
    set((s) => ({
      tabs: { ...s.tabs, [tabId]: [...s.tabs[tabId], screen] },
    })),

  pop: (tabId) =>
    set((s) => {
      const stack = s.tabs[tabId];
      if (stack.length <= 1) return s; // 根屏不可弹
      return { tabs: { ...s.tabs, [tabId]: stack.slice(0, -1) } };
    }),

  switchTab: (tabId) => set({ activeTab: tabId }),
  setDrawerOpen: (open) => set({ drawerOpen: open }),
  setBottomSheetOpen: (open) => set({ bottomSheetOpen: open }),

  initRoots: (roots) =>
    set({
      tabs: {
        transfer: [roots.transfer],
        chat: [roots.chat],
        discover: [roots.discover],
        profile: [roots.profile],
      },
    }),
}));

/** 当前激活 Tab 栈顶 Screen 的便捷选择器（避免组件内重复计算）。 */
export const selectCurrentScreen = (s: NavState): Screen | undefined => {
  const stack = s.tabs[s.activeTab];
  return stack[stack.length - 1];
};

/** 当前激活 Tab 栈深度。 */
export const selectStackDepth = (s: NavState): number => s.tabs[s.activeTab].length;
