// 全局命令面板（Ctrl+K）
//
// 设计：Provider 只产出「可执行项」，面板负责搜索/键盘/分组/最近使用。
// 内置 provider：模块、动作、笔记；业务模块（音乐/阅读/AI 会话…）通过 registry 注册实体搜索。
// 结果优先走统一导航契约（module + tabs + entity），模块自己决定如何落到 tab/子 tab。
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  ArrowUp,
  Camera,
  CornerDownLeft,
  FileText,
  Inbox,
  Maximize2,
  Minimize2,
  Plus,
  Puzzle,
  Search,
  Settings,
  Sparkles,
  StickyNote,
} from 'lucide-react';
import { PluginIcon } from '@/components/PluginIcon';
import { useAppStore } from '@/stores/appStore';
import { useNotesStore } from '@/stores/notesStore';
import {
  getCommandProviders,
  subscribeCommandProviders,
  type PaletteProvider,
} from '@/core/commandPalette/registry';
import type { NavigationTarget } from '@/core/navigation/navigation';
import { navigateTo } from '@/core/navigation/navigation';
import { loadShortcutKeys, matchesShortcut, SHORTCUTS_CHANGED_EVENT } from '@/lib/shortcuts';
import { requestSettingsTab } from '@/core/settings/settingsNav';
import { parseScope, scoreFields } from '@/components/command-palette/scoring';
import { matchQuery, prepareQuery, splitMatches } from '@/lib/fuzzy';
import { useI18n } from '@/lib/i18n';

interface CommandItem {
  id: string;
  title: string;
  subtitle?: string;
  group: string;
  groupKey: string;
  icon?: ReactNode;
  keywords?: string;
  /** provider 自带命中权重（收藏/最近播放等） */
  rank?: number;
  navigate?: NavigationTarget;
  run: () => void | Promise<void>;
}

const RECENT_KEY = 'andy.cmdk.recent';
const USAGE_KEY = 'andy.cmdk.usage';
const RECENT_MAX = 12;
const MAX_RESULTS = 60;
const PROVIDER_RESULT_CAP = 12;
const SCOPED_PROVIDER_RESULT_CAP = 40;

/**
 * 命中高亮。区间取自 matchQuery —— 与排序同一套匹配逻辑，
 * 所以不会出现「高亮了一段却没排上来」或「排上来了却不高亮」两套手感打架。
 * 只命中正文（标题里没有查询词）的 provider 结果自然没有区间，退化为纯文本。
 */
function Highlighted({ text, query }: { text: string; query: string }) {
  const m = query.trim() ? matchQuery(prepareQuery(query), text) : null;
  if (!m || m.ranges.length === 0) return <>{text}</>;
  return (
    <>
      {splitMatches(text, m.ranges).map(([seg, hit], i) =>
        hit ? (
          <mark key={i} className="bg-transparent font-medium text-[var(--element-color-raw)]">{seg}</mark>
        ) : (
          <span key={i}>{seg}</span>
        ),
      )}
    </>
  );
}

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function saveRecent(ids: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids.slice(0, RECENT_MAX)));
  } catch { /* 忽略配额/隐私模式 */ }
}

function loadUsage(): Record<string, number> {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    if (!obj || typeof obj !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveUsage(map: Record<string, number>): void {
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(map)); } catch { /* 忽略 */ }
}

export interface CommandPaletteProps {
  /** 截图等宿主动作（由 App 注入，避免面板直接耦合业务实现） */
  onScreenshot?: () => void;
}

export function CommandPalette({ onScreenshot }: CommandPaletteProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [providerItems, setProviderItems] = useState<CommandItem[]>([]);
  const [providers, setProviders] = useState<PaletteProvider[]>(() => getCommandProviders());
  const [paletteKeys, setPaletteKeys] = useState(() => loadShortcutKeys('command-palette', 'Ctrl + K'));
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const [usage, setUsage] = useState<Record<string, number>>(() => loadUsage());
  const openRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const toggleImmersive = useAppStore((s) => s.toggleImmersive);
  const immersive = useAppStore((s) => s.immersive);
  const pluginRegistry = useAppStore((s) => s.pluginRegistry);
  // 子插件（茑萝/薄荷的子项）是**父模块被打开时才注册**的；registry 是同一个对象引用，
  // 只订阅 pluginRegistry 不会触发重算。visibilityTick 在 plugin-registered/unregistered
  // 时 bump，订阅它才能让"后来注册的子模块"进入搜索（2026-11-10 用户报：子项搜不到）。
  const visibilityTick = useAppStore((s) => s.visibilityTick);

  const notes = useNotesStore((s) => s.notes);
  const loadNoteContent = useNotesStore((s) => s.loadNoteContent);
  const createNote = useNotesStore((s) => s.createNote);

  const openPalette = useCallback(() => {
    if (openRef.current) return;
    setQuery('');
    setProviderItems([]);
    setActiveIndex(0);
    setOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
    setProviderItems([]);
  }, []);

  useEffect(() => { openRef.current = open; }, [open]);

  // 快捷键可配置（设置 → 快捷键 → 命令面板），默认 Ctrl/Cmd+K。
  // 笔记的「链接」已改为 Ctrl+Shift+K，因此这里不再对输入框让位。
  useEffect(() => {
    const refreshKeys = () => setPaletteKeys(loadShortcutKeys('command-palette', 'Ctrl + K'));
    window.addEventListener(SHORTCUTS_CHANGED_EVENT, refreshKeys);
    window.addEventListener('storage', refreshKeys);
    return () => {
      window.removeEventListener(SHORTCUTS_CHANGED_EVENT, refreshKeys);
      window.removeEventListener('storage', refreshKeys);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!matchesShortcut(paletteKeys, e)) return;
      if (openRef.current) {
        e.preventDefault();
        inputRef.current?.select();
        return;
      }
      e.preventDefault();
      openPalette();
    };
    const onOpenEvent = () => openPalette();
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('open-command-palette', onOpenEvent);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('open-command-palette', onOpenEvent);
    };
  }, [openPalette, paletteKeys]);

  // 模块 provider 注册表（音乐/阅读等模块在加载时自己注册）
  useEffect(() => subscribeCommandProviders(() => setProviders(getCommandProviders())), []);

  // 打开面板时让各 provider 刷新快照（provider 自行 TTL 节流，避免每次打开都全量重读）
  useEffect(() => {
    if (!open) return;
    for (const provider of providers) {
      try {
        void Promise.resolve(provider.refresh?.()).catch((err) =>
          console.warn('[command-palette] provider 刷新失败:', provider.id, err),
        );
      } catch (err) {
        console.warn('[command-palette] provider 刷新异常:', provider.id, err);
      }
    }
    // providers 数量变化（热插拔）时也刷新一次；不依赖整个数组避免每次注册重刷
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, providers.length]);

  const recordUse = useCallback((id: string) => {
    setRecent((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, RECENT_MAX);
      saveRecent(next);
      return next;
    });
    setUsage((prev) => {
      const next = { ...prev, [id]: (prev[id] ?? 0) + 1 };
      saveUsage(next);
      return next;
    });
  }, []);

  const staticGroups = useMemo(() => ([
    { key: 'modules', label: t('commandPalette.group.modules') },
    { key: 'actions', label: t('commandPalette.group.actions') },
    { key: 'notes', label: t('commandPalette.group.notes') },
  ]), [t]);

  // 静态 provider：模块 / 动作 / 笔记
  const staticItems = useMemo<CommandItem[]>(() => {
    // 仅作刷新触发：子插件注册发生在父模块打开之后，靠这个 tick 让 memo 重算
    void visibilityTick;
    const items: CommandItem[] = [];
    const seen = new Set<string>();
    const groupLabel = (key: string) => staticGroups.find((g) => g.key === key)?.label ?? key;

    const moduleItem = (id: string, title: string, subtitle: string, iconName?: string): CommandItem => ({
      id: `module:${id}`,
      title,
      subtitle,
      group: groupLabel('modules'),
      groupKey: 'modules',
      icon: iconName ? <PluginIcon name={iconName} size={16} fallback={<Puzzle size={16} />} /> : <Puzzle size={16} />,
      keywords: `${id} ${subtitle}`,
      run: () => setActiveModule(id),
    });

    // 特殊模块（不走插件 registry）
    items.push(moduleItem('notes', '笔记', '内置模块'));
    seen.add('notes');
    items.push(moduleItem('transfer', '中转站', '内置模块 · 文件/剪贴板总线'));
    seen.add('transfer');
    items.push(moduleItem('extensions', '拓展管理', '内置模块'));
    seen.add('extensions');
    items.push(moduleItem('settings', '设置', '内置模块'));
    seen.add('settings');

    // 插件模块
    for (const def of pluginRegistry?.getAll() ?? []) {
      if (def.kind !== 'module' || def.visible === false || seen.has(def.id)) continue;
      const parentLabel = def.parent === 'niaoluo' ? '茑萝子模块' : def.parent ? `子模块 · ${def.parent}` : '模块';
      const subtitle = def.codename ? `${parentLabel} · ${def.codename}` : parentLabel;
      items.push(moduleItem(def.id, def.name, subtitle, def.iconName));
      seen.add(def.id);
    }

    // 动作
    const action = (
      id: string,
      title: string,
      subtitle: string,
      icon: ReactNode,
      run: () => void | Promise<void>,
      keywords = '',
    ) => items.push({
      id: `action:${id}`,
      title,
      subtitle,
      group: groupLabel('actions'),
      groupKey: 'actions',
      icon,
      run,
      keywords,
    });

    action('new-note', '新建笔记', '笔记', <Plus size={16} />, async () => {
      setActiveModule('notes');
      await createNote();
    }, '新建 创建 note');
    action('settings-general', '设置：通用', '设置', <Settings size={16} />, () => {
      setActiveModule('settings');
      requestSettingsTab('general');
    }, 'general 常规');
    action('settings-model', '设置：模型', '设置', <Settings size={16} />, () => {
      setActiveModule('settings');
      requestSettingsTab('model');
    }, 'model ai 模型');
    action('settings-extensions', '设置：扩展', '设置', <Puzzle size={16} />, () => {
      setActiveModule('settings');
      requestSettingsTab('extensions');
    }, 'extension 插件 授权');
    action('settings-themes', '设置：主题', '设置', <Sparkles size={16} />, () => {
      setActiveModule('settings');
      requestSettingsTab('themes');
    }, 'theme 主题');
    action('extensions-hub', '拓展管理', '茑萝 / 插件市场', <Puzzle size={16} />, () => setActiveModule('extensions'), 'plugin 插件');
    action('transfer', '打开中转站', '文件/剪贴板总线', <Inbox size={16} />, () => setActiveModule('transfer'), 'station 文件');
    action('immersive', immersive ? '退出沉浸模式' : '进入沉浸模式', '界面', immersive ? <Minimize2 size={16} /> : <Maximize2 size={16} />, () => toggleImmersive(), 'immersive 全屏');
    if (onScreenshot) {
      action('screenshot', '截图', '截屏并放入中转站', <Camera size={16} />, () => onScreenshot(), 'screenshot 截图');
    }

    // 笔记（按最近日期，最多 30 条）
    const noteItems = [...notes]
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 30)
      .map<CommandItem>((n) => ({
        id: `note:${n.id}`,
        title: n.title || '未命名',
        subtitle: n.date ? `笔记 · ${n.date}` : '笔记',
        group: groupLabel('notes'),
        groupKey: 'notes',
        icon: <StickyNote size={16} />,
        keywords: `${n.id} ${n.date ?? ''}`,
        navigate: { module: 'notes', entity: n.id },
        run: () => {
          // 导航处理器未注册时的兜底（老版本 / 笔记模块尚未挂载）
          setActiveModule('notes');
          loadNoteContent(n.id);
        },
      }));
    items.push(...noteItems);

    return items;
  }, [pluginRegistry, visibilityTick, notes, immersive, setActiveModule, toggleImmersive, createNote, loadNoteContent, onScreenshot, staticGroups]);

  const scoped = useMemo(
    () => parseScope(query.trim(), providers, staticGroups),
    [query, providers, staticGroups],
  );
  const effectiveQuery = scoped.query.trim();

  // 模块 provider：把各模块自己的实体搜索接进来（音乐、阅读、AI 会话…）。
  // 作用域命中某个 provider 时只查它；否则并行查全部。
  useEffect(() => {
    if (!open) { setProviderItems([]); return; }
    if (!effectiveQuery) { setProviderItems([]); return; }
    const providerPool = scoped.scope?.kind === 'provider'
      ? providers.filter((p) => p.id === scoped.scope!.key)
      : scoped.scope?.kind === 'static'
        ? []
        : providers;
    if (providerPool.length === 0) { setProviderItems([]); return; }
    let cancelled = false;
    const cap = scoped.scope?.kind === 'provider' ? SCOPED_PROVIDER_RESULT_CAP : PROVIDER_RESULT_CAP;
    const timer = window.setTimeout(() => {
      void (async () => {
        const collected: CommandItem[] = [];
        await Promise.all(providerPool.map(async (provider) => {
          try {
            const results = await provider.search(effectiveQuery);
            if (cancelled) return;
            for (const [idx, r] of (results ?? []).slice(0, cap).entries()) {
              collected.push({
                id: `prov:${provider.id}:${r.id}`,
                title: r.title,
                subtitle: [...(r.path ?? []), r.subtitle].filter(Boolean).join(' › '),
                group: provider.label,
                groupKey: `prov:${provider.id}`,
                icon: r.iconName
                  ? <PluginIcon name={r.iconName} size={16} fallback={<Sparkles size={16} />} />
                  : <Sparkles size={16} />,
                keywords: r.subtitle,
                // provider 自己已按分排过序：把名次编进 rank，既保住模块内部顺序，
                // 也让「只命中正文」（标题不含查询）的结果不至于被下面的再打分静默丢掉。
                rank: (r.rank ?? 0) + (cap - idx),
                navigate: r.navigate,
                run: async () => {
                  if (provider.moduleId) setActiveModule(provider.moduleId);
                  // 给被激活的模块一个挂载/注册监听的机会，再执行具体动作
                  await new Promise((resolve) => setTimeout(resolve, 40));
                  if (r.run) await r.run();
                },
              });
            }
          } catch (err) {
            console.warn('[command-palette] provider 搜索失败:', provider.id, err);
          }
        }));
        if (!cancelled) setProviderItems(collected);
      })();
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, effectiveQuery, providers, scoped.scope, setActiveModule]);

  const visibleItems = useMemo(() => {
    const q = effectiveQuery;
    const recentSet = new Set(recent);
    let pool: CommandItem[];
    if (scoped.scope?.kind === 'static') {
      pool = staticItems.filter((item) => item.groupKey === scoped.scope!.key);
    } else if (scoped.scope?.kind === 'provider') {
      pool = providerItems;
    } else {
      pool = q ? [...staticItems, ...providerItems] : staticItems;
    }
    const scored = pool
      .map((item) => {
        const base = q ? scoreFields(item.title, item.subtitle, item.keywords, q) : 1;
        // 模块 provider 的结果是它自己搜过一遍的：正文命中（标题里没有查询词）
        // 不该在这里被 base<=0 静默丢弃，否则「按会话内容搜」这类能力名义上有、实际是哑的。
        if (base <= 0 && !((item.rank ?? 0) > 0 && item.groupKey?.startsWith('prov:'))) return null;
        const usageBoost = Math.min(usage[item.id] ?? 0, 12) * 2;
        return {
          item,
          score: base + (recentSet.has(item.id) ? 18 : 0) + usageBoost + (item.rank ?? 0),
        };
      })
      .filter((x): x is { item: CommandItem; score: number } => !!x)
      .sort((a, b) => b.score - a.score || Number(recentSet.has(b.item.id)) - Number(recentSet.has(a.item.id)))
      .slice(0, MAX_RESULTS);

    // 分组顺序：模块 → 动作 → 笔记 → 各模块 provider（按 priority 降序）
    const providerOrder = [...providers]
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
      .map((p) => ({ key: `prov:${p.id}`, label: p.label }));
    const order = [...staticGroups.map((g) => ({ key: g.key, label: g.label })), ...providerOrder];
    const known = new Set(order.map((g) => g.key));
    const groups = new Map<string, CommandItem[]>();
    for (const { item } of scored) {
      const list = groups.get(item.groupKey) ?? [];
      list.push(item);
      groups.set(item.groupKey, list);
    }
    const ordered = order.flatMap((g) => groups.get(g.key) ?? []);
    for (const [key, list] of groups) {
      if (!known.has(key)) ordered.push(...list);
    }
    return ordered;
  }, [effectiveQuery, scoped.scope, staticItems, providerItems, providers, recent, usage, staticGroups]);

  useEffect(() => {
    setActiveIndex((i) => (visibleItems.length === 0 ? 0 : Math.min(i, visibleItems.length - 1)));
  }, [visibleItems.length]);

  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // 焦点不在输入框时（例如点了列表再点空白）Esc 也能关闭
  useEffect(() => {
    if (!open) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePalette();
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [open, closePalette]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex]);

  const runItem = useCallback(async (item: CommandItem | undefined) => {
    if (!item) return;
    recordUse(item.id);
    closePalette();
    try {
      // 统一导航契约优先；处理器超时/失败再走旧式直接执行。
      if (item.navigate) {
        const handled = await navigateTo(item.navigate);
        if (handled) return;
      }
      await item.run();
    } catch (err) {
      console.error('[command-palette] 执行失败:', item.id, err);
    }
  }, [closePalette, recordUse]);

  const onInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (visibleItems.length ? (i + 1) % visibleItems.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (visibleItems.length ? (i - 1 + visibleItems.length) % visibleItems.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void runItem(visibleItems[activeIndex]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closePalette();
    }
  };

  if (!open) return null;

  let lastGroup: CommandItem['group'] | null = null;
  return createPortal(
    <div
      className="fixed inset-0 z-[var(--layer-palette)] flex items-start justify-center pt-[12vh] px-4 bg-black/35 fade-in"
      onMouseDown={(e) => { if (e.target === e.currentTarget) closePalette(); }}
    >
      <div
        className="w-[min(680px,94vw)] max-h-[62vh] flex flex-col rounded-2xl overflow-hidden border border-white/70 dark:border-stone-600/50 bg-white/95 dark:bg-stone-800/95 shadow-2xl shadow-black/30"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-200/60 dark:border-stone-700/60">
          <Search size={16} className="text-neutral-400 dark:text-stone-500" />
          {scoped.scope && (
            <span className="shrink-0 rounded-full bg-[var(--element-bg)]/12 px-2 py-0.5 text-[11px] text-[var(--element-color-raw)]">
              {scoped.scope.label}
            </span>
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
            onKeyDown={onInputKeyDown}
            placeholder={t('commandPalette.placeholder')}
            className="flex-1 bg-transparent outline-none text-sm text-neutral-700 dark:text-stone-100 placeholder:text-neutral-400 dark:placeholder:text-stone-500"
            spellCheck={false}
          />
          <kbd className="px-1.5 py-0.5 rounded border border-neutral-200/70 dark:border-stone-600/60 text-[10px] text-neutral-400 dark:text-stone-500">{paletteKeys}</kbd>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {visibleItems.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-neutral-400 dark:text-stone-500">
              {query.trim().length >= 1 ? t('commandPalette.noMatch') : t('commandPalette.hint')}
            </div>
          ) : (
            visibleItems.map((item, index) => {
              const showHeader = item.group !== lastGroup;
              lastGroup = item.group;
              const active = index === activeIndex;
              return (
                <div key={item.id}>
                  {showHeader && (
                    <div className="px-4 pt-3 pb-1 text-[10px] uppercase tracking-wider text-neutral-400 dark:text-stone-500">
                      {item.group}
                    </div>
                  )}
                  <button
                    type="button"
                    data-index={index}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => void runItem(item)}
                    className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors ${
                      active
                        ? 'bg-[var(--element-muted)] text-neutral-900 dark:text-stone-50'
                        : 'text-neutral-600 dark:text-stone-300 hover:bg-black/[0.04] dark:hover:bg-white/[0.04]'
                    }`}
                  >
                    <span className="w-6 h-6 rounded-md flex items-center justify-center bg-black/[0.04] dark:bg-white/[0.06] text-neutral-500 dark:text-stone-400 shrink-0">
                      {item.icon ?? <FileText size={16} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm truncate"><Highlighted text={item.title} query={effectiveQuery} /></span>
                      {item.subtitle && (
                        <span className="block text-[11px] text-neutral-400 dark:text-stone-500 truncate">
                          <Highlighted text={item.subtitle} query={effectiveQuery} />
                        </span>
                      )}
                    </span>
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between px-4 py-2 border-t border-neutral-200/60 dark:border-stone-700/60 text-[10px] text-neutral-400 dark:text-stone-500">
          <span className="flex items-center gap-3">
            <span className="flex items-center gap-1"><ArrowUp size={11} /><ArrowDown size={11} /> {t('commandPalette.select')}</span>
            <span className="flex items-center gap-1"><CornerDownLeft size={11} /> {t('commandPalette.open')}</span>
            <span>{t('commandPalette.close')}</span>
          </span>
          <span>{t('commandPalette.count', { n: visibleItems.length })}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
