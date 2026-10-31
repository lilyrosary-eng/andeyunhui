// 跨模块导航契约
//
// 目标：任何入口（命令面板、未来浮岛/其他模块）都能表达「去哪个模块、哪个 tab/子 tab、
// 哪个实体」，而不用各自硬编码事件名与跳转顺序。模块通过 registerNavigator 声明自己的
// 导航树处理方式；宿主统一负责「先切模块，再等处理器就绪，再执行」。
//
// 模块按需挂载（keep-alive 首次访问才 mount），所以处理器注册会晚于 setActiveModule。
// 未注册时把目标排队，处理器一注册立即消费；超时则退回 DOM 事件，避免调用方永久等待。

export interface NavigationTarget {
  /** 目标模块 id（插件 id / notes / transfer / settings…） */
  module: string;
  /** 层级路径：一级 tab → 二级 sub tab，例如 ['歌单', '我的收藏'] */
  tabs?: string[];
  /** 末级实体 id（歌曲 id、书籍路径、会话 id、来源 id…） */
  entity?: string;
  /** 模块自定义的附加参数（如 playlistId / submodule / view） */
  props?: Record<string, unknown>;
}

export type NavigatorHandler = (
  target: NavigationTarget,
) => boolean | void | Promise<boolean | void>;

interface PendingNavigation {
  target: NavigationTarget;
  resolve: (handled: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

const navigators = new Map<string, NavigatorHandler>();
const pending = new Map<string, PendingNavigation>();
const NAVIGATION_TIMEOUT_MS = 2000;

// 宿主启动时注入「切模块」实现，导航核心不直接依赖 appStore（也便于单测）。
let activateModule: (moduleId: string) => void = () => {};

/** 注册模块切换器（App 启动时调用一次）。 */
export function setModuleActivator(fn: (moduleId: string) => void): void {
  activateModule = typeof fn === 'function' ? fn : () => {};
}

function settlePending(moduleId: string, handled: boolean): void {
  const entry = pending.get(moduleId);
  if (!entry) return;
  pending.delete(moduleId);
  clearTimeout(entry.timer);
  entry.resolve(handled);
}

/**
 * 注册模块导航处理器。同模块重复注册会覆盖（组件按需重挂时以最新闭包为准）。
 * 返回注销函数；注销后该模块再次进入「待注册」状态。
 */
export function registerNavigator(moduleId: string, handler: NavigatorHandler): () => void {
  if (!moduleId || typeof handler !== 'function') {
    throw new Error('registerNavigator: 需要 moduleId 与 handler');
  }
  navigators.set(moduleId, handler);
  const queued = pending.get(moduleId);
  if (queued) {
    pending.delete(moduleId);
    clearTimeout(queued.timer);
    // 处理器可能仍处于「数据未就绪」阶段；返回 false 视为尚未消费，继续排队等下一次注册。
    void Promise.resolve()
      .then(() => handler(queued.target))
      .then((handled) => {
        if (handled === false) {
          enqueue(moduleId, queued.target, queued.resolve);
        } else {
          queued.resolve(true);
        }
      })
      .catch((err) => {
        console.warn('[navigation] 导航处理器执行失败:', moduleId, err);
        queued.resolve(false);
      });
  }
  return () => {
    if (navigators.get(moduleId) === handler) navigators.delete(moduleId);
  };
}

function enqueue(moduleId: string, target: NavigationTarget, resolve: (handled: boolean) => void): void {
  settlePending(moduleId, false);
  const timer = setTimeout(() => {
    const entry = pending.get(moduleId);
    if (entry?.target !== target) return;
    pending.delete(moduleId);
    // 兜底：旧式模块仍可监听 DOM 事件自行处理（不阻塞调用方）。
    window.dispatchEvent(new CustomEvent('andy:navigate', { detail: target }));
    resolve(false);
  }, NAVIGATION_TIMEOUT_MS);
  pending.set(moduleId, { target, resolve, timer });
}

/**
 * 跳转到目标。顺序：切模块 → 已有处理器直接执行；否则排队等模块挂载后注册。
 * 返回是否被处理器接受（超时/异常为 false）。
 */
export async function navigateTo(target: NavigationTarget): Promise<boolean> {
  if (!target || typeof target.module !== 'string' || !target.module) return false;
  const moduleId = target.module;
  activateModule(moduleId);
  const handler = navigators.get(moduleId);
  if (handler) {
    try {
      const result = await handler(target);
      return result !== false;
    } catch (err) {
      console.warn('[navigation] 导航处理器执行失败:', moduleId, err);
      return false;
    }
  }
  return new Promise<boolean>((resolve) => enqueue(moduleId, target, resolve));
}

/** 模块卸载时清理（热插拔场景），避免旧处理器跨版本残留。 */
export function unregisterNavigator(moduleId: string): void {
  navigators.delete(moduleId);
  settlePending(moduleId, false);
}
