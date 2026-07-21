/// <reference path="../global.d.ts" />
// =============================================
// 插件共享运行时 — 消除跨插件的基础设施重复代码
// =============================================
// 提取 music/image/video/reading 共享的：
//   - useRootPaths：根目录管理（localStorage 持久化）
//   - useBlacklist：Rust 集中管理的黑名单
//   - EmptyState/LoadingState/NoResultsState：统一的状态 UI
//
// 使用方式（插件入口顶部）：
//   import { useRootPaths, useBlacklist, EmptyState } from '../../_shared/pluginRuntime';
// =============================================

const React = window.__HOST_REACT__;
const { useState, useEffect, useCallback, useRef } = React;
const hostApi = window.__HOST_API__;

// ============ Hooks ============

/**
 * 根目录路径管理（localStorage 持久化）。
 * 所有媒体插件共享相同的 pick_directory + JSON 持久化逻辑。
 */
export function useRootPaths(storageKey: string) {
  const [rootPaths, setRootPaths] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  /** 打开目录选择器，返回选中的路径（或 null） */
  const addRoot = useCallback(async (): Promise<string | null> => {
    try {
      const result = await hostApi.invoke<string | null>('pick_directory');
      if (result) {
        setRootPaths(prev => {
          if (prev.includes(result)) return prev;
          const updated = [...prev, result];
          localStorage.setItem(storageKey, JSON.stringify(updated));
          return updated;
        });
        return result;
      }
    } catch (err) {
      console.error('[Plugin] 选择目录失败:', err);
    }
    return null;
  }, [storageKey]);

  /** 移除指定根目录 */
  const removeRoot = useCallback((pathToRemove: string) => {
    setRootPaths(prev => {
      const updated = prev.filter(p => p !== pathToRemove);
      localStorage.setItem(storageKey, JSON.stringify(updated));
      return updated;
    });
  }, [storageKey]);

  /** 静默加入根目录（不弹选择器，持久化）。用于「以安得云荟打开 / 拖入主窗口」的临时目录注册。 */
  const addRootPath = useCallback((pathToAdd: string) => {
    setRootPaths(prev => {
      if (prev.includes(pathToAdd)) return prev;
      const updated = [...prev, pathToAdd];
      localStorage.setItem(storageKey, JSON.stringify(updated));
      return updated;
    });
  }, [storageKey]);

  return { rootPaths, setRootPaths, addRoot, addRootPath, removeRoot };
}

/**
 * Rust 集中管理的黑名单（按模块隔离）。
 * music/image/video 共享相同的 get/add/remove 模式。
 */
export function useBlacklist(module: string) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());

  // 初始化：从 Rust 加载当前模块的屏蔽列表
  useEffect(() => {
    hostApi.invoke<string[]>('get_blacklist_paths', { module }).then(paths => {
      setHidden(new Set(paths));
    }).catch((err: unknown) => console.warn(`[${module}] 加载黑名单失败:`, err));
  }, [module]);

  /** 加入黑名单（本地 + Rust 持久化） */
  const add = useCallback((path: string, displayName: string) => {
    setHidden(prev => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });
    hostApi.invoke('add_to_blacklist', { module, path, displayName })
      .catch((err: unknown) => console.warn(`[${module}] 加入黑名单失败:`, err));
  }, [module]);

  /** 批量移除黑名单（用于重新扫描时清空） */
  const removeAll = useCallback(async (paths: string[]) => {
    for (const path of paths) {
      await hostApi.invoke('remove_from_blacklist', { module, path })
        .catch((err: unknown) => console.warn(`[${module}] 移除黑名单失败:`, err));
    }
  }, [module]);

  /** 清空本地黑名单集合（不调 Rust，用于 removeAll 后同步本地） */
  const clear = useCallback(() => {
    setHidden(new Set());
  }, []);

  return { hidden, add, removeAll, clear, setHidden };
}

// ============ 通用流式打开 Hook（项目级高并发能力）============
//
// 把"监听分块事件 + 帧缓冲合并 + 缓存透明 + 可取消"沉淀为共享能力，
// 供各模块的重操作（打开大书、加载大文件等）复用，与扫描流的
// createFrameBuffer 机制同源，避免每个模块重复造轮子。
// 阅读模块已率先落地：open_book 按章推送 chunk，前端用本 Hook 合并渲染。

export interface StreamingOpenEvents<TMeta, TItem> {
  metaEvent: string;
  itemEvent: string;
  progressEvent: string;
}

export interface StreamingOpenHandlers<TMeta, TItem> {
  onMeta: (meta: TMeta) => void;
  onItems: (items: TItem[]) => void;
  onProgress?: (p: { sent: number; total: number; done: boolean }) => void;
  onDone?: () => void;
  onError?: (err: unknown) => void;
}

export interface StreamingOpenOptions {
  /** 取消命令名（如 'cancel_open_book'），在 cancel 时调用以通知 Rust 侧中止进行中的任务 */
  cancelCommand?: string;
}

export function useStreamingOpen<TMeta, TItem>(
  events: StreamingOpenEvents<TMeta, TItem>,
  handlers: StreamingOpenHandlers<TMeta, TItem>,
  options?: StreamingOpenOptions,
) {
  // handlers 每次渲染可能变化，用 ref 持有最新值，保证 open/cancel 引用稳定
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const cleanupRef = useRef<{ destroy: () => void; unsub: (() => void)[] } | null>(null);
  const cancelledRef = useRef(false);

  const cancel = useCallback(() => {
    const c = cleanupRef.current;
    if (c) {
      try { c.destroy(); } catch (e) { /* 忽略 */ }
      c.unsub.forEach(fn => { try { fn(); } catch (e) { /* 忽略 */ } });
      cleanupRef.current = null;
      // 仅在确有进行中任务时才通知 Rust 取消——避免空 cancel 无谓递增
      // OPEN_BOOK_GENERATION，否则 open_book_streaming 的代次检查可能误判为
      // "已被取消"而静默返回，前端收不到任何事件（表现为"点击无反应"）。
      if (options?.cancelCommand) {
        hostApi.invoke(options.cancelCommand).catch(() => {});
      }
    }
    cancelledRef.current = true;
  }, [options?.cancelCommand]);

  const open = useCallback(async (command: string, args: Record<string, unknown>) => {
    // 取消上次未完成的打开，开始新的
    cancel();
    cancelledRef.current = false;

    // 诊断：确认 hostApi 和 createFrameBuffer 可用
    if (typeof hostApi.createFrameBuffer !== 'function') {
      console.error('[useStreamingOpen] hostApi.createFrameBuffer 不可用! hostApi keys:', Object.keys(hostApi || {}));
      handlersRef.current.onError?.(new Error('hostApi.createFrameBuffer is not a function'));
      return;
    }

    // 整个 open 过程（建缓冲 → 注册监听 → invoke）统一 try/catch，
    // 避免任何环节的异常被 React async 事件处理静默吞掉（表现为"点击无反应"）
    let metaBuffer: ReturnType<typeof hostApi.createFrameBuffer<TMeta>> | null = null;
    let itemBuffer: ReturnType<typeof hostApi.createFrameBuffer<TItem[]>> | null = null;
    let progressBuffer: ReturnType<typeof hostApi.createFrameBuffer<{ sent: number; total: number; done: boolean }>> | null = null;
    try {
      // 帧缓冲：meta/item/progress 各自批量合并到单帧，避免高频 setState 渲染风暴
      metaBuffer = hostApi.createFrameBuffer<TMeta>((items) => {
        if (cancelledRef.current) return;
        handlersRef.current.onMeta(items[items.length - 1]);
      });
      itemBuffer = hostApi.createFrameBuffer<TItem[]>((chunks) => {
        if (cancelledRef.current) return;
        handlersRef.current.onItems(chunks.flat());
      });
      progressBuffer = hostApi.createFrameBuffer<{ sent: number; total: number; done: boolean }>((items) => {
        if (cancelledRef.current) return;
        const last = items[items.length - 1];
        handlersRef.current.onProgress?.(last);
        if (last.done) {
          cancel();
          handlersRef.current.onDone?.();
        }
      });

      const unsubMeta = await hostApi.listen(events.metaEvent, (e: { payload: TMeta }) => metaBuffer!.push(e.payload));
      const unsubItem = await hostApi.listen(events.itemEvent, (e: { payload: TItem[] }) => itemBuffer!.push(e.payload));
      const unsubProgress = await hostApi.listen(events.progressEvent, (e: { payload: { sent: number; total: number; done: boolean } }) => progressBuffer!.push(e.payload));
      cleanupRef.current = {
        destroy: () => { metaBuffer?.destroy(); itemBuffer?.destroy(); progressBuffer?.destroy(); },
        unsub: [unsubMeta, unsubItem, unsubProgress],
      };

      await hostApi.invoke(command, args);
    } catch (err) {
      console.error('[useStreamingOpen] open 失败:', err);
      metaBuffer?.destroy();
      itemBuffer?.destroy();
      progressBuffer?.destroy();
      cleanupRef.current = null;
      handlersRef.current.onError?.(err);
    }
  }, [cancel, events]);

  // 模块卸载（切换模块/热重载）时取消进行中的任务
  useEffect(() => () => cancel(), [cancel]);

  return { open, cancel };
}

// ============ 通用扫描流 Hook（项目级高并发能力）============
//
// 把四个媒体模块"扫描根目录"中完全相同的 高并发骨架 沉淀为共享能力：
//   1) 帧缓冲合并高频 scan-chunk / scan-progress（createFrameBuffer，避免渲染风暴）；
//   2) 先试缓存命中（cacheCommand），未命中再流式扫描（scanCommand）；
//   3) spawn_blocking 卸载在 Rust 侧，前端只消费事件；
//   4) 原子取消（cancel_scan）+ 卸载清理。
// 阅读/image 共用 'scan-chunk'/'scan-progress'，video 用 'video-scan-chunk'/...
// 各模块仅传入事件名与命令名即可复用同一套高并发机制，消除四处重复实现。

export interface ScanProgressLite {
  found: number;
  total: number;
  done: boolean;
}

export interface ScanStreamConfig<TItem> {
  /** 分块事件名（如 'scan-chunk'） */
  chunkEvent: string;
  /** 进度事件名（如 'scan-progress'） */
  progressEvent: string;
  /** 缓存加载命令（命中则直接 onItems 追加，跳过扫描） */
  cacheCommand: string;
  /** 流式扫描命令 */
  scanCommand: string;
  /** 待扫描的根目录列表 */
  rootPaths: string[];
  /** 追加一批条目（chunk 或缓存命中），参数为本帧累积的所有批次 */
  onItems: (items: TItem[]) => void;
  /** 进度更新（取最新一条） */
  onProgress?: (p: ScanProgressLite) => void;
  /** 整轮扫描完成（progress.done 或所有根处理完） */
  onDone?: () => void;
  onError?: (err: unknown) => void;
}

export function useScanStream<TItem>(config: ScanStreamConfig<TItem>) {
  // config 每次渲染可能变化，用 ref 持有最新值，保证 start/cancel 引用稳定
  const configRef = useRef(config);
  configRef.current = config;
  const cancelledRef = useRef(false);
  const doneRef = useRef(false);
  // 上次 start 的清理函数（cancel 调用时执行，防止重复监听器堆积）
  const cleanupRef = useRef<(() => void) | null>(null);
  // start 版本号：每次 start 递增，frame buffer 回调比对版本号，防止旧监听器处理新事件
  const versionRef = useRef(0);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    versionRef.current += 1; // 让旧 frame buffer 回调失效
    const c = cleanupRef.current;
    if (c) {
      try { c(); } catch (e) { /* 忽略 */ }
      cleanupRef.current = null;
    }
    hostApi.invoke('cancel_scan').catch(() => {});
  }, []);

  const start = useCallback(async () => {
    // 清理上次 scan 的监听器（防御 React StrictMode 两次 effect 或快速切换）
    cancel();
    cancelledRef.current = false;
    doneRef.current = false;
    const myVersion = versionRef.current;
    const cfg = configRef.current;

    // 帧缓冲：chunk / progress 各自批量合并到单帧，避免高频 setState 渲染风暴
    const itemBuffer = hostApi.createFrameBuffer<TItem[]>((chunks) => {
      if (cancelledRef.current || versionRef.current !== myVersion) return;
      cfg.onItems(chunks.flat());
    });
    const progressBuffer = hostApi.createFrameBuffer<ScanProgressLite>((items) => {
      if (cancelledRef.current || versionRef.current !== myVersion) return;
      const last = items[items.length - 1];
      cfg.onProgress?.(last);
      if (last.done && !doneRef.current) {
        doneRef.current = true;
        cfg.onDone?.();
      }
    });

    const unsubChunk = await hostApi.listen(cfg.chunkEvent, (e: { payload: TItem[] }) => itemBuffer.push(e.payload));
    const unsubProgress = await hostApi.listen(cfg.progressEvent, (e: { payload: ScanProgressLite }) => progressBuffer.push(e.payload));

    const cleanup = () => {
      try { unsubChunk(); } catch (e) { /* 忽略 */ }
      try { unsubProgress(); } catch (e) { /* 忽略 */ }
      itemBuffer.destroy();
      progressBuffer.destroy();
    };
    // 立刻注册清理函数，cancel 可随时调用
    cleanupRef.current = cleanup;

    try {
      for (const root of cfg.rootPaths) {
        if (cancelledRef.current || versionRef.current !== myVersion) break;
        // 1. 先试缓存命中
        try {
          const cached = await hostApi.invoke<TItem[] | null>(cfg.cacheCommand, { rootPath: root });
          if (cached && cached.length > 0) {
            if (cancelledRef.current || versionRef.current !== myVersion) break;
            cfg.onItems(cached);
            continue;
          }
        } catch (e) {
          // 缓存不存在/异常 → 走流式扫描
          void e;
        }
        if (cancelledRef.current || versionRef.current !== myVersion) break;
        // 2. 流式扫描 — 等待一个微任务周期确保 Tauri 事件监听器完全激活
        await new Promise<void>(r => setTimeout(r, 0));
        try {
          await hostApi.invoke(cfg.scanCommand, { rootPath: root });
        } catch (err) {
          if (!cancelledRef.current && versionRef.current === myVersion) cfg.onError?.(err);
        }
        // 3. 等待一帧确保 frameBuffer 的 rAF 回调已执行（scan-chunk 事件可能在 spawn_blocking 线程
        //    发出后尚未被前端消费），避免数据丢失导致显示"无结果"
        await new Promise<void>(r => requestAnimationFrame(() => setTimeout(r, 0)));
      }
      if (!cancelledRef.current && versionRef.current === myVersion && !doneRef.current) {
        doneRef.current = true;
        cfg.onDone?.();
      }
    } finally {
      // 只有当前版本的 cleanup 才执行（防止旧版本 cleanup 意外删除新版本监听器）
      if (cleanupRef.current === cleanup) {
        cleanup();
        cleanupRef.current = null;
      }
    }
  }, [cancel]);

  // 模块卸载（切换模块/热重载）时取消进行中的扫描
  useEffect(() => () => cancel(), [cancel]);

  return { start, cancel };
}

// ============ 共享状态 UI 组件 ============

interface EmptyStateProps {
  /** 大图标节点 */
  icon: React.ReactNode;
  /** 模块标题 */
  title: string;
  /** 描述文字 */
  description: string;
  /** 按钮文字 */
  buttonText: string;
  onSelect: () => void;
}

/** 空状态：无根目录时的引导界面 */
export function EmptyState({ icon, title, description, buttonText, onSelect }: EmptyStateProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center h-full gap-4">
      <div className="w-16 h-16 rounded-2xl bg-[var(--element-muted)] flex items-center justify-center">
        {icon}
      </div>
      <h2 className="text-lg font-semibold text-neutral-700 dark:text-stone-200">{title}</h2>
      <p className="text-sm text-neutral-400 dark:text-stone-500 text-center max-w-xs">{description}</p>
      <p className="text-xs text-neutral-400/60 dark:text-stone-600 text-center max-w-xs flex items-center gap-1">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        仅扫描索引，不会修改原始文件
      </p>
      <button
        onClick={onSelect}
        className="btn-press px-6 py-2.5 rounded-xl bg-[var(--element-bg)] text-white font-medium hover:opacity-90 transition-opacity"
      >
        {buttonText}
      </button>
    </div>
  );
}

interface LoadingStateProps {
  /** 进度文字（如"已扫描 42/100 首..."） */
  progressText?: string;
  onCancel: () => void;
}

/** 加载状态：扫描中转圈 + 取消按钮 */
export function LoadingState({ progressText, onCancel }: LoadingStateProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center h-full gap-3">
      <div className="w-6 h-6 border-2 border-[var(--element-bg)] border-t-transparent rounded-full animate-spin" />
      <p className="text-sm text-neutral-400 dark:text-stone-500">{progressText || '正在扫描...'}</p>
      <button
        onClick={onCancel}
        className="btn-press text-xs text-neutral-400 dark:text-stone-500 hover:text-red-400"
      >
        取消扫描
      </button>
    </div>
  );
}

interface NoResultsStateProps {
  text?: string;
  buttonText?: string;
  onSelect: () => void;
}

/** 无结果状态：扫描完成但未找到内容 */
export function NoResultsState({ text, buttonText, onSelect }: NoResultsStateProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center h-full gap-4">
      <p className="text-sm text-neutral-400 dark:text-stone-500">{text || '未找到内容'}</p>
      <button
        onClick={onSelect}
        className="btn-press text-xs text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200"
      >
        {buttonText || '更换目录'}
      </button>
    </div>
  );
}
