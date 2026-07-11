import { useState, useMemo, useSyncExternalStore, useCallback, useEffect } from 'react';
import { FolderOpen, AlertTriangle, RefreshCw, Package, Trash2, Download, Loader2 } from 'lucide-react';
import { Switch } from "@/components/ui/switch"
import { pluginDiagnostics, type DiagnosticEntry } from '@/core/pluginDiagnostics';
import { PluginIcon } from '@/components/PluginIcon';
import { api } from '@/lib/api';
import { logger } from '@/lib/logger';
import { createSandboxGlobals, executeInSandbox } from '@/core/pluginSandbox';

export function ExtensionManagerPanel() {
  // 订阅诊断数据变更
  const diagnostics = useSyncExternalStore(
    pluginDiagnostics.subscribe.bind(pluginDiagnostics),
    pluginDiagnostics.getSnapshot.bind(pluginDiagnostics)
  );

  const registry = window.__PLUGIN_REGISTRY__;
  // tick：订阅插件注册表事件，重载/卸载后强制重算列表
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    window.addEventListener('plugin-registered', bump);
    window.addEventListener('plugin-unregistered', bump);
    window.addEventListener('plugin-visibility-changed', bump);
    return () => {
      window.removeEventListener('plugin-registered', bump);
      window.removeEventListener('plugin-unregistered', bump);
      window.removeEventListener('plugin-visibility-changed', bump);
    };
  }, []);
  const plugins = useMemo(() => (registry ? registry.getAll() : []), [registry, tick]);

  // 本地状态：跟踪每个插件的开关位置（初始值从注册表读取）
  const [visibilityMap, setVisibilityMap] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const p of plugins) {
      map[p.id] = p.visible !== false;
    }
    return map;
  });

  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState('');

  // ---- 路线 A：分发解耦 —— 清单下载安装 ----
  const [manifest, setManifest] = useState<any>(null);
  const [installing, setInstalling] = useState<Set<string>>(new Set());

  useEffect(() => {
    const { invoke } = window.__HOST_API__;
    invoke<string>('read_manifest')
      .then((json) => setManifest(JSON.parse(json)))
      .catch(() => {});
  }, []);

  const installablePlugins = useMemo(() => {
    if (!manifest?.plugins || !registry) return [];
    const installed = new Set(plugins.map((p: any) => p.id));
    return manifest.plugins.filter((p: any) => !installed.has(p.id));
  }, [manifest, plugins, registry]);

  const handleInstall = async (plugin: any) => {
    const { invoke } = window.__HOST_API__;
    setInstalling((s) => new Set(s).add(plugin.id));
    try {
      const name = await invoke<string>('install_bundled_plugin', { pluginId: plugin.id });
      await invoke('refresh_plugins');
      setRefreshMsg(`${name} 安装完成。`);
    } catch (e: any) {
      setRefreshMsg(`安装失败: ${e}`);
    }
    setInstalling((s) => { const n = new Set(s); n.delete(plugin.id); return n; });
  };

  const handleTogglePlugin = useCallback((pluginId: string, visible: boolean) => {
    setVisibilityMap(prev => ({ ...prev, [pluginId]: visible }));
    api.setPluginVisibility(pluginId, visible).then(() => {
      logger.plugins.visibilityUpdated(pluginId, visible);
    }).catch((err) => {
      logger.plugins.visibilityFailed(pluginId, err);
    });
  }, []);

  // 检测新插件（先刷新 Rust 侧缓存，再读取最新扫描结果）
  const handleRefresh = async () => {
    setRefreshing(true);
    setRefreshMsg('');
    try {
      const result = await api.refreshPlugins();
      for (const m of result.valid) {
        if (!registry.get(m.id)) {
          try {
            const scriptText = await api.readPluginFile(m.id, m.entry);

            // 直接沙箱执行（CSP 禁止 blob: URL import，故不走动态 import）
            const sandbox = createSandboxGlobals(m.id, registry, m.deps);
            executeInSandbox(scriptText, sandbox, m.id);

            logger.plugins.newPluginLoaded(m.id);
          } catch (err) {
            logger.plugins.newPluginFailed(m.id, err);
          }
        }
      }
      setRefreshMsg('检测完成。已运行的插件修改后需重启应用生效。');
    } catch (_err) {
      setRefreshMsg('检测失败，请查看控制台。');
    }
    setRefreshing(false);
  };

  // 按 pluginId 分组诊断
  const rejectedGroups = groupDiagnostics(diagnostics);

  return (
    <div className="max-w-4xl mx-auto w-full h-full flex flex-col gap-6 pt-8 px-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight text-neutral-800 dark:text-stone-100">管理拓展</h1>
        <div className="flex items-center gap-2">
          {refreshMsg && (
            <span className="text-xs text-neutral-400 dark:text-stone-500">{refreshMsg}</span>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing}
            className="btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-white/70 dark:bg-stone-800/70 border border-white/80 text-sm text-neutral-600 dark:text-stone-400 hover:bg-white transition-colors disabled:opacity-50"
          >
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            检测新插件
          </button>
        </div>
      </div>

      {/* 已启用插件 */}
      <section>
        <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3">
          已启用插件 ({plugins.length})
        </h2>
        <div className="bg-white/70 dark:bg-stone-800/70 backdrop-blur rounded-2xl border border-white/80 divide-y divide-neutral-200/50 overflow-hidden">
          {plugins.length === 0 ? (
            <div className="p-6 text-center text-sm text-neutral-400 dark:text-stone-500 space-y-4">
              <Package size={24} className="mx-auto text-neutral-300 dark:text-neutral-600" />
              <p>暂无已启用的插件</p>
              {installablePlugins.length > 0 && (
                <button
                  onClick={async () => {
                    const { invoke } = window.__HOST_API__;
                    setInstalling(new Set(installablePlugins.map((p: any) => p.id)));
                    for (const p of installablePlugins) {
                      try { await invoke('install_bundled_plugin', { pluginId: p.id }); } catch {}
                    }
                    await invoke('refresh_plugins');
                    setInstalling(new Set());
                    setRefreshMsg('所有推荐模块已安装。');
                  }}
                  className="btn-press inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[var(--element-bg)] text-white text-sm hover:opacity-90 transition-opacity"
                >
                  <Download size={14} />
                  一键安装推荐模块
                </button>
              )}
            </div>
          ) : (
            plugins.map((p) => {
              return (
                <div key={p.id} className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg element-muted flex items-center justify-center">
                      <PluginIcon name={p.iconName} size={18} fallback={<Package size={18} />} />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-neutral-800 dark:text-stone-100">{p.name}</div>
                      <div className="text-xs text-neutral-400 dark:text-stone-500">{p.id} · {p.kind}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {(() => {
                      const def = registry ? registry.get(p.id) : undefined;
                      const isLoaded = !!def;
                      return (
                        <span className={`flex items-center gap-1 text-xs ${isLoaded ? 'text-emerald-600' : 'text-neutral-400 dark:text-stone-500'}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${isLoaded ? 'bg-emerald-500' : 'bg-neutral-300 dark:bg-stone-600'}`} />
                          {isLoaded ? '运行中' : '已卸载'}
                        </span>
                      );
                    })()}
                    <button
                      onClick={() => {
                        const { invoke } = window.__HOST_API__;
                        invoke('reload_plugin', { pluginId: p.id }).catch(() => {});
                      }}
                      className="btn-press p-1.5 rounded-lg hover:bg-black/5 text-neutral-400 dark:text-stone-500 hover:text-emerald-500 transition-colors"
                      title="热重载（应用内重新加载，无需重启）"
                    >
                      <RefreshCw size={16} />
                    </button>
                    <button
                      onClick={() => {
                        const { invoke } = window.__HOST_API__;
                        invoke('unload_plugin', { pluginId: p.id }).catch(() => {});
                      }}
                      className="btn-press p-1.5 rounded-lg hover:bg-black/5 text-neutral-400 dark:text-stone-500 hover:text-red-500 transition-colors"
                      title="热卸载（应用内卸载，无需重启）"
                    >
                      <Trash2 size={16} />
                    </button>
                    <Switch
                      checked={visibilityMap[p.id] ?? true}
                      onCheckedChange={(val: boolean) => handleTogglePlugin(p.id, val)}
                      className="data-[state=checked]:bg-[var(--element-bg)]"
                      title="启用/禁用（重启后生效）"
                    />
                    <button
                      onClick={() => {
                        const { invoke } = window.__HOST_API__;
                        invoke('plugin:opener|open_path', { path: '' }).catch(() => {});
                      }}
                      className="btn-press p-1.5 rounded-lg hover:bg-black/5 text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300 transition-colors"
                      title="打开插件文件夹"
                    >
                      <FolderOpen size={16} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* 路线 A：可安装模块（分发解耦） */}
      {installablePlugins.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3">
            可安装模块 ({installablePlugins.length})
          </h2>
          <div className="bg-white/70 dark:bg-stone-800/70 backdrop-blur rounded-2xl border border-white/80 divide-y divide-neutral-200/50 overflow-hidden">
            {installablePlugins.map((p: any) => {
              const busy = installing.has(p.id);
              return (
                <div key={p.id} className="flex items-center justify-between p-4">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg element-muted flex items-center justify-center">
                      <Package size={18} />
                    </div>
                    <div>
                      <div className="text-sm font-medium text-neutral-800 dark:text-stone-100">{p.name}</div>
                      <div className="text-xs text-neutral-400 dark:text-stone-500">
                        {p.id} · {p.desc || p.kind} · {(p.size / 1024).toFixed(0)} KB
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => handleInstall(p)}
                    disabled={busy}
                    className="btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--element-bg)]/10 text-[var(--element-bg)] hover:bg-[var(--element-bg)]/20 transition-colors disabled:opacity-50 text-sm"
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                    {busy ? '安装中' : '安装'}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 未成功加载（诊断） */}
      {rejectedGroups.length > 0 && (
        <section>
          <h2 className="text-sm font-medium text-neutral-500 dark:text-stone-400 mb-3 flex items-center gap-1.5">
            <AlertTriangle size={14} className="text-amber-500" />
            未成功加载 ({rejectedGroups.length})
          </h2>
          <div className="bg-white/70 dark:bg-stone-800/70 backdrop-blur rounded-2xl border border-white/80 divide-y divide-neutral-200/50 overflow-hidden">
            {rejectedGroups.map(({ pluginId, entries }) => (
              <DiagnosticRow key={pluginId} pluginId={pluginId} entries={entries} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** 单条诊断信息行 */
function DiagnosticRow({ pluginId, entries }: { pluginId: string; entries: DiagnosticEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const latest = entries[entries.length - 1];
  const stageLabel: Record<string, string> = {
    scan: '扫描',
    version: '版本',
    load: '加载',
    register: '注册',
    conflict: '冲突',
  };

  return (
    <div className="p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center text-amber-500">
            <AlertTriangle size={18} />
          </div>
          <div>
            <div className="text-sm font-medium text-neutral-800 dark:text-stone-100">{pluginId}</div>
            <div className="text-xs text-neutral-400 dark:text-stone-500">
              [{stageLabel[latest.stage] || latest.stage}] {latest.reason}
            </div>
          </div>
        </div>
        {entries.length > 1 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300 transition-colors"
          >
            {expanded ? '收起' : `${entries.length} 条记录`}
          </button>
        )}
      </div>
      {expanded && entries.length > 1 && (
        <div className="mt-2 ml-11 space-y-1">
          {entries.map((e, i) => (
            <div key={i} className="text-xs text-neutral-400 dark:text-stone-500">
              [{stageLabel[e.stage] || e.stage}] {e.reason}
              <span className="ml-2 text-neutral-300 dark:text-neutral-600">
                {new Date(e.timestamp).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** 按 pluginId 分组诊断条目 */
function groupDiagnostics(entries: DiagnosticEntry[]): { pluginId: string; entries: DiagnosticEntry[] }[] {
  const map = new Map<string, DiagnosticEntry[]>();
  for (const e of entries) {
    const list = map.get(e.pluginId) || [];
    list.push(e);
    map.set(e.pluginId, list);
  }
  return [...map.entries()].map(([pluginId, entries]) => ({ pluginId, entries }));
}