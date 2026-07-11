import { useEffect, useMemo, useState } from 'react';
import { Puzzle } from 'lucide-react';
import type { PluginRegistry, PluginDef } from '@/core/pluginRegistry';
import { PluginIcon } from '@/components/PluginIcon';
import { ModuleSidebarShell } from '@/components/ModuleSidebarShell';
import { SecondaryNavShell } from '@/components/SecondaryNavShell';
import { PluginErrorBoundary } from '@/core/PluginHost';
import { useAppStore } from '@/stores/appStore';

/** 统一侧边栏 — 始终复用同一个 ModuleSidebarShell，仅中间的 children 内容根据 activeModule 切换。 */
export function HostSidebar() {
  const pluginRegistry = useAppStore(s => s.pluginRegistry) as PluginRegistry | null;
  const activeModule = useAppStore(s => s.activeModule);
  const setActiveModule = useAppStore(s => s.setActiveModule);
  const showExtensionSettings = useAppStore(s => s.showExtensionSettings);
  const toggleExtensionSettings = useAppStore(s => s.toggleExtensionSettings);

  const [search, setSearch] = useState('');
  const [tick, setTick] = useState(0);

  // 订阅注册表变更（热插拔/卸载），刷新子插件列表
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

  // 子插件列表（归属 niuluo 的模块类插件）
  const children = useMemo(
    () =>
      pluginRegistry
        ? pluginRegistry
            .getAll()
            .filter((p) => p.kind === 'module' && p.parent === 'niuluo')
        : [],
    [pluginRegistry, tick],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return children;
    return children.filter(
      (p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q),
    );
  }, [children, search]);

  const groups = useMemo(() => {
    const map = new Map<string, PluginDef[]>();
    for (const p of filtered) {
      const key = p.category || '';
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(p);
    }
    return Array.from(map.entries());
  }, [filtered]);

  // 只在茑萝模式或子插件模式下显示侧边栏
  const showSidebar =
    activeModule === 'extensions' ||
    !!(pluginRegistry?.get(activeModule)?.parent);

  if (!showSidebar || !pluginRegistry) return null;

  // 茑萝模式下显示搜索框，子插件模式不显示
  const searchProps =
    activeModule === 'extensions'
      ? { searchQuery: search, onSearchChange: setSearch, searchPlaceholder: '搜索拓展...' as const }
      : {};

  // ---- 渲染 children 内容 ----
  let content: React.ReactNode = null;

  if (activeModule === 'extensions') {
    // 茑萝：子插件列表（母目录）
    const renderBtn = (plugin: PluginDef) => (
      <button
        key={plugin.id}
        onClick={() => setActiveModule(plugin.id)}
        className={`w-full text-left px-3 py-2.5 rounded-xl transition-colors flex items-center gap-2.5 ${
          activeModule === plugin.id
            ? 'bg-[var(--element-bg)]/10 text-[var(--element-bg)]'
            : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
        }`}
      >
        <span className={`flex-shrink-0 ${activeModule === plugin.id ? '' : 'opacity-70'}`}>
          <PluginIcon name={plugin.iconName} size={18} fallback={<span className="text-xs font-bold">{plugin.name[0]}</span>} />
        </span>
        <span className="flex-1 min-w-0">
          <span className={`block text-sm font-medium truncate ${activeModule === plugin.id ? '' : 'text-neutral-700 dark:text-stone-200'}`}>
            {plugin.name}
          </span>
          <span className="block text-[11px] text-neutral-400 dark:text-stone-500 truncate">{plugin.id}</span>
        </span>
      </button>
    );

    if (filtered.length === 0) {
      content = (
        <div className="px-2 py-4 text-xs text-neutral-400 dark:text-stone-500 text-center">
          {children.length === 0 ? '暂无已安装的拓展' : '未找到匹配的拓展'}
        </div>
      );
    } else {
      content = (
        <SecondaryNavShell>
          {groups.map(([cat, items]) => (
            <div key={cat || '_'} className="mb-1">
              {cat && (
                <div className="px-3 pt-2 pb-1 text-[11px] font-medium text-neutral-400 dark:text-stone-500">
                  {cat}
                </div>
              )}
              {items.map(renderBtn)}
            </div>
          ))}
        </SecondaryNavShell>
      );
    }
  } else {
    // 子插件（如绘画）：渲染插件声明的 sidebar 组件内容
    const def = pluginRegistry.get(activeModule);
    if (def?.sidebar) {
      const PluginContent = def.sidebar;
      content = (
        <PluginErrorBoundary pluginId={activeModule}>
          <PluginContent />
        </PluginErrorBoundary>
      );
    }
  }

  // 子插件模式（如绘画/IDE）：在「茑萝」标题下提供返回按钮（不改动图标栏逻辑）
  const isChild = activeModule !== 'extensions' && !!pluginRegistry?.get(activeModule)?.parent;

  return (
    <ModuleSidebarShell
      moduleId="niuluo"
      icon={<Puzzle size={20} className="text-[var(--element-bg)]" />}
      title="茑萝"
      onOpenModuleSettings={toggleExtensionSettings}
      moduleSettingsLabel={showExtensionSettings ? '返回拓展列表' : '管理拓展设置'}
      backAction={isChild ? { onClick: () => setActiveModule('extensions'), label: '返回' } : undefined}
      {...searchProps}
    >
      {content}
    </ModuleSidebarShell>
  );
}
