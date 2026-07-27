import { useEffect, useMemo, useState, useCallback } from 'react';
import { Puzzle, Search, ArrowLeftRight } from 'lucide-react';
import type { PluginRegistry, PluginDef } from '@/core/pluginRegistry';
import { PluginIcon } from '@/components/PluginIcon';
import { ModuleSidebarShell } from '@/components/ModuleSidebarShell';
import { SecondaryNavShell } from '@/components/SecondaryNavShell';
import { PluginErrorBoundary } from '@/core/PluginHost';
import { useAppStore } from '@/stores/appStore';
import { useI18n } from '@/lib/i18n';
import { api } from '@/lib/api';

/** 统一侧边栏 — 始终复用同一个 ModuleSidebarShell，仅中间的 children 内容根据 activeModule 切换。 */
export function HostSidebar() {
  const { t } = useI18n();
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

  // 茑萝子模块「rag」默认不在侧栏展示（其 manifest.visible=false，作为内置功能），
  // 由「全局设置 → 茑萝 → 显示 RAG 知识库模块」开关控制。
  const [ragVisible, setRagVisible] = useState<boolean>(() => {
    try { return localStorage.getItem('niaoluo:rag-visible') === '1'; } catch { return false; }
  });
  useEffect(() => {
    const onRagVis = () => setRagVisible(localStorage.getItem('niaoluo:rag-visible') === '1');
    window.addEventListener('niaoluo-rag-visibility', onRagVis);
    return () => window.removeEventListener('niaoluo-rag-visibility', onRagVis);
  }, []);

  // 子插件列表（归属 niaoluo 的模块类插件）
  const children = useMemo(
    () =>
      pluginRegistry
        ? pluginRegistry
            .getAll()
            .filter(
              (p) =>
                p.kind === 'module' &&
                p.parent === 'niaoluo' &&
                (p.id !== 'rag' || ragVisible),
            )
        : [],
    [pluginRegistry, tick, ragVisible],
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

  // 只在茑萝模式、子插件模式，或黄金棋盘·模块设置页显示侧栏
  // （capsule-settings 既不是 extensions 也无 parent，需显式纳入，否则进入设置时侧栏整体消失）
  const showSidebar =
    activeModule === 'extensions' ||
    activeModule === 'capsule-settings' ||
    !!(pluginRegistry?.get(activeModule)?.parent);

  // 子插件模式（如绘画/IDE）：在「茑萝」标题下提供返回按钮（不改动图标栏逻辑）
  // 黄金棋盘·模块设置页同样视为茑萝子模块（返回 茑萝 列表，维持层级归属，不脱离母模块）
  const isChild =
    (activeModule !== 'extensions' && !!pluginRegistry?.get(activeModule)?.parent) ||
    activeModule === 'capsule-settings';

  // 侧边栏齿轮：茑萝母目录打开「管理拓展设置」；子插件（如 IDE）复用同一齿轮，
  // 派发 module-settings-toggle 事件由对应子插件自行打开其独立模块设置页（而非另设按钮）。
  // 必须在早期 return 之前声明，遵守 Hooks 调用顺序。
  const onOpenModuleSettings = useCallback(() => {
    if (activeModule === 'extensions') {
      toggleExtensionSettings();
    } else if (activeModule === 'capsule-settings') {
      // 设置页再点齿轮 → 返回黄金棋盘主面板
      setActiveModule('capsule');
    } else if (isChild) {
      window.dispatchEvent(new CustomEvent('module-settings-toggle', { detail: { moduleId: activeModule } }));
    }
  }, [activeModule, isChild, toggleExtensionSettings, setActiveModule]);

  if (!showSidebar || !pluginRegistry) return null;

  // 茑萝模式下显示搜索框，子插件模式不显示
  const searchProps =
    activeModule === 'extensions'
      ? { searchQuery: search, onSearchChange: setSearch, searchPlaceholder: t('sidebar.searchExt') }
      : {};

  // ---- 渲染 children 内容 ----
  let content: React.ReactNode = null;

  if (activeModule === 'extensions') {
    // 黄金棋盘：先确保插件已加载（manifest.visible=false 默认不加载），再切换到主窗口搜索面板。
    // 浮岛胶囊仍由光标靠近顶部监视（capsule_start_monitor）自动弹出，不受此影响。
    const handlePluginClick = async (plugin: PluginDef) => {
      if (plugin.id !== 'capsule') {
        setActiveModule(plugin.id);
        return;
      }
      try {
        const reg = (window as unknown as { __PLUGIN_REGISTRY__?: { get: (id: string) => unknown } }).__PLUGIN_REGISTRY__;
        const hot = (window as unknown as { __pluginHot__?: { load: (d: unknown) => Promise<void> } }).__pluginHot__;
        if (reg && !reg.get('capsule')) {
          const installed = await api.getInstalledPlugins();
          const def = (installed.valid ?? []).find((p) => p.id === 'capsule');
          if (def) {
            await api.setPluginVisibility('capsule', true);
            await hot?.load(def);
          }
        }
        setActiveModule('capsule');
      } catch (e) {
        console.error('[HostSidebar] 打开黄金棋盘失败', e);
      }
    };

    // 茑萝：子插件列表（母目录）
    const renderBtn = (plugin: PluginDef) => (
      <button
        key={plugin.id}
        onClick={() => handlePluginClick(plugin)}
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
          {children.length === 0 ? t('sidebar.noExtInstalled') : t('sidebar.noExtMatch')}
        </div>
      );
    } else {
      content = (
        <SecondaryNavShell>
          {groups.map(([cat, items], gi) => (
            <div key={cat ? `g-${cat}` : `g-empty-${gi}`} className="mb-1">
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
  } else if (activeModule === 'capsule' || activeModule === 'capsule-settings') {
    // 黄金棋盘 / 黄金棋盘·设置：侧栏显示搜索 / 传输双 Tab（复用茑萝侧栏，不另建）
    const capsuleTab = (() => { try { return localStorage.getItem('niaoluo:capsule-tab') || 'search'; } catch { return 'search'; } })();
    const setCapsuleTab = (tab: string) => {
      try { localStorage.setItem('niaoluo:capsule-tab', tab); } catch {}
      window.dispatchEvent(new CustomEvent('capsule-tab-changed'));
      if (activeModule === 'capsule-settings') {
        // 设置页内点击 Tab → 切回主面板并带上目标 Tab
        setActiveModule('capsule');
      } else {
        setTick((t) => t + 1); // 强制自身重渲染
      }
    };
    content = (
      <SecondaryNavShell>
        <div className="mb-1">
          <button
            onClick={() => setCapsuleTab('search')}
            className={`w-full text-left px-3 py-2.5 rounded-xl transition-colors flex items-center gap-2.5 ${
              capsuleTab === 'search'
                ? 'bg-[var(--element-bg)]/10 text-[var(--element-color-raw)]'
                : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
            }`}
          >
            <Search size={18} />
            <span className="text-sm font-medium">文件搜索</span>
          </button>
          <button
            onClick={() => setCapsuleTab('transfer')}
            className={`w-full text-left px-3 py-2.5 rounded-xl transition-colors flex items-center gap-2.5 ${
              capsuleTab === 'transfer'
                ? 'bg-[var(--element-bg)]/10 text-[var(--element-color-raw)]'
                : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
            }`}
          >
            <ArrowLeftRight size={18} />
            <span className="text-sm font-medium">传输</span>
          </button>
        </div>
      </SecondaryNavShell>
    );
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

  const moduleSettingsLabel = activeModule === 'extensions'
    ? (showExtensionSettings ? t('sidebar.backToList') : t('sidebar.manageExtSettings'))
    : t('sidebar.moduleSettings');

  return (
    <ModuleSidebarShell
      moduleId="niaoluo"
      icon={<Puzzle size={20} className="text-[var(--element-bg)]" />}
      title={t('sidebar.niaoluo')}
      onOpenModuleSettings={onOpenModuleSettings}
      moduleSettingsLabel={moduleSettingsLabel}
      backAction={isChild ? { onClick: () => setActiveModule('extensions'), label: t('sidebar.back') } : undefined}
      {...searchProps}
    >
      {content}
    </ModuleSidebarShell>
  );
}
