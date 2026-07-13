import { useEffect, useState, Component, type ReactNode, type ErrorInfo } from 'react';
import React from 'react';
// 完整 react-dom（含 flushSync），作为 __HOST_REACT_DOM__ 提供给插件沙箱；
// 插件（如 tiptap）外部化的 'react-dom' 需要 flushSync，故不能用 react-dom/client。
import ReactDOM from 'react-dom';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen, emit } from '@tauri-apps/api/event';
import { PluginRegistry, HOST_API_VERSION } from '@/core/pluginRegistry';
import { api, type PluginManifest } from '@/lib/api';
import { pluginDiagnostics } from '@/core/pluginDiagnostics';
import { logger } from '@/lib/logger';
import { createFrameBuffer } from '@/lib/frameBuffer';
import {
  createSandboxGlobals,
  executeInSandbox,
} from '@/core/pluginSandbox';
import { pluginPerformanceMonitor } from '@/core/pluginPerformanceMonitor';
import { ModuleSidebarShell } from '@/components/ModuleSidebarShell';
import { SecondaryNavShell } from '@/components/SecondaryNavShell';
import { NestedNavList } from '@/components/NestedNavList';
import { ModuleSettingsPanel } from '@/components/ModuleSettingsPanel';
import { CollapsibleSearch } from '@/components/CollapsibleSearch';
import { IconButton } from '@/components/IconButton';
import { PluginIcon } from '@/components/PluginIcon';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';

// ========== 插件错误边界 ==========
// 防止单个插件崩溃导致整个应用白屏
interface ErrorBoundaryState { hasError: boolean; error: Error | null; pluginId: string; }
export class PluginErrorBoundary extends Component<{ pluginId: string; children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null, pluginId: this.props.pluginId };
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  componentDidCatch(error: Error, _info: ErrorInfo) {
    logger.plugins.errorBoundary(this.props.pluginId, error.message);
    pluginDiagnostics.addEntry({
      pluginId: this.props.pluginId,
      stage: 'runtime',
      reason: `渲染崩溃: ${error.message}`,
      timestamp: Date.now(),
    });
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center h-full bg-[#f5f5f0] dark:bg-[#1c1917] gap-3 text-center px-6">
          <div className="w-12 h-12 rounded-full bg-red-50 dark:bg-red-900/20 flex items-center justify-center">
            <span className="text-red-400 text-lg">!</span>
          </div>
          <h3 className="text-sm font-medium text-neutral-600 dark:text-stone-300">插件「{this.props.pluginId}」出现错误</h3>
          <p className="text-xs text-neutral-400 dark:text-stone-500 max-w-md">{this.state.error?.message}</p>
          <div className="flex gap-2">
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="px-4 py-1.5 rounded-lg border border-neutral-200/50 dark:border-stone-600/50 text-sm text-neutral-500 dark:text-stone-400 hover:bg-neutral-100 dark:hover:bg-stone-800 transition-colors"
            >
              重试
            </button>
            <button
              onClick={() => {
                api.setPluginVisibility(this.props.pluginId, false).catch(() => {});
                logger.plugins.disablePlugin(this.props.pluginId);
              }}
              className="px-4 py-1.5 rounded-lg bg-red-50 dark:bg-red-900/20 text-sm text-red-500 hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors"
            >
              禁用插件
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

interface PluginHostProps {
  onPluginsLoaded: (registry: PluginRegistry) => void;
  children: ReactNode;
}

// 全局单例，确保只初始化一次
let initialized = false;

export function PluginHost({ onPluginsLoaded, children }: PluginHostProps) {
  const [ready, setReady] = useState(initialized);
  const [registry] = useState(() => new PluginRegistry());

  useEffect(() => {
    if (initialized) return;
    initialized = true;

    // 挂载宿主 React 和 API 到全局（仅首次设置，后续不可覆盖）
    const hostApi = { invoke, convertFileSrc, listen, emit, createFrameBuffer };
    const hostUi = { ModuleSidebarShell, SecondaryNavShell, NestedNavList, ModuleSettingsPanel, CollapsibleSearch, IconButton, Icon: PluginIcon, ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator };
    const defNonWritable = (key: string, value: unknown) => {
      Object.defineProperty(window, key, { value, writable: false, configurable: false });
    };
    defNonWritable('__HOST_REACT__', React);
    defNonWritable('__HOST_REACT_DOM__', ReactDOM);
    defNonWritable('__HOST_API__', hostApi);
    defNonWritable('__PLUGIN_REGISTRY__', registry);
    defNonWritable('__HOST_UI__', hostUi);

    // 先设置 ready，让主界面立即渲染（不依赖插件加载）
    setReady(true);

    // 进度：主界面骨架已就绪，准备加载插件（40%）
    const boot = window as unknown as {
      __bootProgress?: (pct: number, opts?: { text?: string; phase?: string }) => void;
    };
    boot.__bootProgress?.(40, { text: "准备插件环境", phase: "PHASE 03 / 05" });

    // 热插拔：监听 Rust 派发的事件，应用内重载 / 卸载插件（无需重启）
    listen('plugin-reload', ((e: { payload: string }) =>
      void reloadSinglePlugin(e.payload, registry)) as never);
    listen('plugin-unload', ((e: { payload: string }) =>
      unloadSinglePlugin(e.payload, registry)) as never);
    // 文件系统热插拔：Rust notify watcher 检测到 extensions/ 或 user_plugins/ 变化时
    // 自动重新扫描并加载新增/卸载移除的插件（真正的免重启热插拔）
    listen('plugin-fs-change', ((_e: { payload: unknown }) => {
      void (async () => {
        try {
          // 200ms 防抖已在 Rust 侧完成，这里直接触发重扫
          const updated = await api.refreshPlugins();
          if (!updated || !updated.valid) return;
          const updatedIds = new Set(updated.valid.map((m: { id: string }) => m.id));
          const currentIds = new Set(registry.getAll().map((p: { id: string }) => p.id));

          // 新增的插件：加载（跳过 visible=false 的已禁用插件）
          for (const m of updated.valid) {
            if (!currentIds.has(m.id) && m.visible !== false) {
              try {
                await loadSinglePlugin(m as Parameters<typeof loadSinglePlugin>[0], registry);
              } catch (err) {
                console.warn('[PluginHost] 热插拔加载失败:', m.id, err);
              }
            }
          }
          // 移除的插件：卸载
          for (const id of currentIds) {
            if (!updatedIds.has(id)) {
              try { unloadSinglePlugin(id, registry); } catch {}
            }
          }
        } catch (err) {
          console.warn('[PluginHost] 热插拔事件处理失败:', err);
        }
      })();
    }) as never);
    // 暴露给扩展管理器等宿主 UI 直接调用（如应用内装/卸插件市场）
    (window as unknown as { __pluginHot__?: unknown }).__pluginHot__ = {
      reload: (id: string) => reloadSinglePlugin(id, registry),
      unload: (id: string) => unloadSinglePlugin(id, registry),
      // 加载单个插件（用于"启用"按钮，传入 manifest 对象）
      load: (manifest: PluginManifest) => loadSinglePlugin(manifest, registry),
    };

    loadPlugins(registry).then(() => {
      onPluginsLoaded(registry);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 mount 时执行一次，通过全局单例保护
  }, []);

  if (!ready) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-[#f5f5f0] text-neutral-400">
        加载中...
      </div>
    );
  }

  return <>{children}</>;
}

// ========== 热插拔：应用内重载 / 卸载插件（无需重启） ==========

/** 安全调用插件的 destroy 钩子，释放 audio/定时器/事件监听等资源 */
function safeDestroyPlugin(id: string, registry: PluginRegistry): void {
  const def = registry.get(id);
  if (def?.destroy) {
    try { def.destroy(); } catch (err) {
      logger.log(`[pluginHot] destroy 抛错 ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function reloadSinglePlugin(id: string, registry: PluginRegistry): Promise<void> {
  try {
    const manifestText = await api.readPluginFile(id, 'manifest.json');
    const manifest = JSON.parse(manifestText) as PluginManifest;
    const entry = manifest.entry || 'index.js';
    const scriptText = await api.readPluginFile(id, entry);
    // 先调用 destroy 释放旧实例资源，再注销（register 有重复 id 守卫，必须先清）
    safeDestroyPlugin(id, registry);
    registry.unregister(id);
    const sandbox = createSandboxGlobals(id, registry, manifest.deps);
    executeInSandbox(scriptText, sandbox, id);
    const def = registry.get(id);
    if (def) {
      // 热重载路径也需从 manifest 注入 codename（与首次加载保持一致）
      if (manifest.codename) {
        def.codename = manifest.codename;
      }
      window.dispatchEvent(new CustomEvent('plugin-registered', { detail: def }));
    } else {
      logger.log(`[pluginHot] register 未被调用，registry 无 def: ${id}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.log(`[pluginHot] 重载失败 ${id}: ${reason}`);
    pluginDiagnostics.addEntry({
      pluginId: id,
      stage: 'runtime',
      reason: `热重载失败: ${reason}`,
      timestamp: Date.now(),
    });
  }
}

function unloadSinglePlugin(id: string, registry: PluginRegistry): void {
  // 卸载前调用 destroy 释放资源（audio、定时器、事件监听等）
  safeDestroyPlugin(id, registry);
  registry.unregister(id);
  window.dispatchEvent(new CustomEvent('plugin-unregistered', { detail: { id } }));
  logger.log(`[pluginHot] 已卸载 ${id}`);
}

/** 安全加载单个插件 */
const PLUGIN_LOAD_TIMEOUT_MS = 10_000; // 插件加载超时 10s

/** 带超时保护的 Promise */
function withTimeout<T>(promise: Promise<T>, ms: number, pluginId: string): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timerId = setTimeout(() => reject(new Error(`插件加载超时 (${ms}ms): ${pluginId}`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timerId !== undefined) clearTimeout(timerId);
  });
}

async function loadSinglePlugin(
  manifest: PluginManifest,
  registry: PluginRegistry,
): Promise<void> {
  pluginPerformanceMonitor.startMeasure(manifest.id, 'load');

  try {
    // 嵌套子插件由 Rust 端按 id 递归定位真实路径，前端只需传入干净 id
    const scriptText = await withTimeout(
      api.readPluginFile(manifest.id, manifest.entry),
      PLUGIN_LOAD_TIMEOUT_MS,
      manifest.id,
    );

    // 所有插件均为 IIFE 格式，直接沙箱中执行（使用 new Function 替代 eval）
    // CSP 不允许 blob: URL import，统一走 executeInSandbox
    const sandbox = createSandboxGlobals(manifest.id, registry, manifest.deps);
    executeInSandbox(scriptText, sandbox, manifest.id);

    pluginPerformanceMonitor.endMeasure(manifest.id, 'load');
  } catch (err) {
    pluginPerformanceMonitor.endMeasure(manifest.id, 'load');
    throw err;
  }
}

/** 五阶段插件加载流水线 + 诊断收集 */
async function loadPlugins(registry: PluginRegistry) {
  const boot = window as unknown as {
    __bootProgress?: (pct: number, opts?: { text?: string; phase?: string }) => void;
  };
  logger.plugins.pipelineStart();

  // 阶段 0：获取扫描结果
  let result;
  try {
    result = await api.getInstalledPlugins();
    logger.plugins.stage0Done(result.valid.length, result.rejected.length);
    // 进度：插件清单已扫描（50%）
    boot.__bootProgress?.(50, { text: "扫描插件", phase: "PHASE 03 / 05" });
  } catch (err) {
    logger.plugins.stage0Failed(err);
    return;
  }

  // 把 Rust 端拒绝的插件录入诊断
  for (const r of result.rejected) {
    pluginDiagnostics.addEntry({
      pluginId: r.folderName,
      stage: 'scan',
      reason: r.reason,
      timestamp: Date.now(),
    });
    logger.plugins.scanRejected(r.folderName, r.reason);
  }

  const manifests = result.valid;
  if (manifests.length === 0) {
    logger.plugins.noPlugins();
    return;
  }

  // 阶段 1：hostApiVersion 版本过滤 + visible 检查
  // visible=false 的插件不加载（用户在拓展管理中禁用的），但仍会出现在 getInstalledPlugins 结果中，
  // 供 ExtensionManagerPanel 显示为"已禁用"状态，用户可随时重新启用。
  const compatible = manifests.filter(m => {
    if (m.hostApiVersion !== HOST_API_VERSION) {
      const reason = `版本不兼容 (需要 v${HOST_API_VERSION}, 插件要求 v${m.hostApiVersion})`;
      pluginDiagnostics.addEntry({
        pluginId: m.id,
        stage: 'version',
        reason,
        timestamp: Date.now(),
      });
      logger.plugins.versionRejected(reason, m.id);
      return false;
    }
    if (m.visible === false) {
      logger.log(`[plugins] ${m.id} 已禁用 (visible=false)，跳过加载`);
      return false;
    }
    return true;
  });
  logger.plugins.stage1Done(compatible.length, manifests.length);

  if (compatible.length === 0) return;

  // 阶段 2：并行加载，互不拖累（使用沙箱化执行替代 eval）
  logger.plugins.stage2Start(compatible.length);
  let loadedCount = 0;
  const totalPlugins = compatible.length;
  const results = await Promise.allSettled(
    compatible.map(async (m) => {
      await loadSinglePlugin(m, registry);
      loadedCount++;
      // 进度：按已加载插件数推进（50% → 80%）
      boot.__bootProgress?.(
        50 + Math.round((loadedCount / totalPlugins) * 30),
        { text: "加载模块", phase: "PHASE 04 / 05" }
      );
      return m;
    })
  );

  // 阶段 3：自注册校验
  let successCount = 0;
  for (const settled of results) {
    if (settled.status === 'rejected') {
      const err = settled.reason;
      const reason = err instanceof Error ? err.message : String(err);
      pluginDiagnostics.addEntry({
        pluginId: '(未知)',
        stage: 'load',
        reason: `脚本加载失败: ${reason}`,
        timestamp: Date.now(),
      });
      logger.plugins.stage2Failed(reason);
      continue;
    }

    const manifest = settled.value;
    const registered = registry.get(manifest.id);

    if (!registered) {
      const reason = '加载成功但未调用 register()';
      pluginDiagnostics.addEntry({
        pluginId: manifest.id,
        stage: 'register',
        reason,
        timestamp: Date.now(),
      });
      logger.plugins.stage3Fail(manifest.id, reason);
      continue;
    }

    if (registered.kind !== manifest.kind) {
      const reason = `kind 不匹配 (manifest: ${manifest.kind}, 注册: ${registered.kind})`;
      pluginDiagnostics.addEntry({
        pluginId: manifest.id,
        stage: 'register',
        reason,
        timestamp: Date.now(),
      });
      logger.plugins.stage3FailCleanup(manifest.id, reason);
      registry.unregister(manifest.id);
      continue;
    }

    // 从 manifest 注入元数据（codename 等）到已注册的 PluginDef。
    // 插件注册时无需重复声明 codename，统一由 manifest.json 管理。
    if (manifest.codename) {
      registered.codename = manifest.codename;
    }

    successCount++;
    logger.plugins.stage3Pass(manifest.id, manifest.kind, manifest.visible);
  }

  logger.plugins.pipelineDone(successCount, compatible.length);

  // 进度：插件流水线完成，进入收尾初始化（90%）
  boot.__bootProgress?.(90, { text: "初始化完成", phase: "PHASE 05 / 05" });

  // 开发环境输出性能报告
  if (import.meta.env.DEV) {
    const report = pluginPerformanceMonitor.getReport();
    logger.plugins.perfReport(report);
  }
}