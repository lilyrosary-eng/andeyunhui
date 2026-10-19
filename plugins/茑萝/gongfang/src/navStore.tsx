/// <reference path="../../../global.d.ts" />
// 茑萝 · 攻防 · 框架导航的跨组件状态（2026-10-20）
//
// ## 为什么需要它
// 五大「功能块」（网络爬虫 / 逆向工程 / 渗透测试 / 自动化测试 / API 网关）的入口
// 从主区域顶部的 Tab 行搬到了**插件侧栏**。侧栏与主区域是两个平行组件（宿主分别渲染），
// 没有父子关系，所以选中项、以及各框架的编译能力（features）必须有地方共享 —— 就是这个模块。
//
// ## 为什么不放回主区域
// 主区域顶部原先有一排 Tab，侧栏再放一份就是同一个入口出现两次。搬走之后主区域只剩
// 「目标 / 信息台 / 审计」这些开关，导航只有一处。
//
// ## 为什么不是 localStorage / 事件
// 同一 window、同一 bundle，模块级单例最直接：同步读取、无序列化、卸载不丢。
// 用 CustomEvent/事件总线反而要处理监听器生命周期。

const React = window.__HOST_REACT__;
const { useEffect, useReducer } = React;

/** 五大功能块的 key（与后端 feature 名一一对应）。 */
export type TabKey = 'crawler' | 'reverse' | 'pentest' | 'automation' | 'gateway';

export interface NavState {
  /** 当前选中的功能块 */
  tab: TabKey;
  /** 各框架是否随当前内核编译（null = 还没取到，此时不做拦截） */
  features: Record<TabKey, boolean> | null;
  /** gongfang_status 拉取失败（无法确认编译能力） */
  featureWarn: boolean;
}

/** 五大功能块（图标内联 SVG，避免引入图标依赖）。 */
export const FRAMEWORK_TABS: { key: TabKey; label: string; icon: React.ReactNode }[] = [
  {
    key: 'crawler',
    label: '网络爬虫',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
      </svg>
    ),
  },
  {
    key: 'reverse',
    label: '逆向工程',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    ),
  },
  {
    key: 'pentest',
    label: '渗透测试',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m14 4 6 6-11 11H3v-6L14 4z" />
        <path d="m13 5 6 6" />
      </svg>
    ),
  },
  {
    key: 'automation',
    label: '自动化测试',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 8V4H8" />
        <rect x="4" y="8" width="16" height="12" rx="2" />
        <path d="M2 14h2M20 14h2M15 13v2M9 13v2" />
      </svg>
    ),
  },
  {
    key: 'gateway',
    label: 'API 网关',
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12h4l3-9 4 18 3-9h4" />
      </svg>
    ),
  },
];

/** TabKey → 中文名（审计日志用）。 */
export const FRAMEWORK_LABELS: Record<TabKey, string> = {
  crawler: '网络爬虫',
  reverse: '逆向工程',
  pentest: '渗透测试',
  automation: '自动化测试',
  gateway: 'API 网关',
};

let state: NavState = { tab: 'crawler', features: null, featureWarn: false };
const subs = new Set<() => void>();

export function getNav(): NavState {
  return state;
}

/**
 * 合并写入。**逐字段比较**，值没变就不通知 —— features 是每次轮询都新建的对象，
 * 不做这项比较会让侧栏和主区域跟着 2 秒一次的轮询白白重渲染。
 */
export function setNav(patch: Partial<NavState>): void {
  let changed = false;
  const next: NavState = { ...state };
  for (const k of Object.keys(patch) as (keyof NavState)[]) {
    const v = patch[k];
    if (k === 'features' && state.features && v && typeof v === 'object') {
      const a = state.features as unknown as Record<string, unknown>;
      const b = v as unknown as Record<string, unknown>;
      const same = Object.keys(b).every((kk) => a[kk] === b[kk]);
      if (same) continue;
    }
    if (state[k] !== v) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (next as any)[k] = v;
      changed = true;
    }
  }
  if (!changed) return;
  state = next;
  for (const f of subs) f();
}

export function subscribeNav(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** 组件侧订阅：侧栏与主区域都用它。 */
export function useNav(): NavState {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeNav(() => bump()), []);
  return getNav();
}
