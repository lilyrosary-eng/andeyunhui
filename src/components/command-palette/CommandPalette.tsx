// 全局命令面板（Ctrl+K）
//
// 设计：Provider 只产出「可执行项」，面板负责搜索/键盘/分组/最近使用。
// 当前内置 4 个 provider：模块、动作、笔记、文件（fs_search）。
// 后续接入中转站、设置子页、AI 会话等只需再产出一组 CommandItem。
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowDown,
  ArrowUp,
  Camera,
  CornerDownLeft,
  FileText,
  Folder,
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
import { requestSettingsTab } from '@/core/settings/settingsNav';

interface CommandItem {
  id: string;
  title: string;
  subtitle?: string;
  group: '模块' | '动作' | '笔记' | '文件';
  icon?: ReactNode;
  keywords?: string;
  run: () => void | Promise<void>;
}

interface SearchResult {
  path: string;
  name: string;
  size: number;
  modified: number;
  is_dir: boolean;
}

const RECENT_KEY = 'andy.cmdk.recent';
const RECENT_MAX = 12;
const MAX_RESULTS = 60;

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

function scoreText(text: string, query: string): number {
  if (!query) return 1;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (t === q) return 120;
  if (t.startsWith(q)) return 100;
  if (t.includes(q)) return 70;
  // 子序列匹配（"dsm" → "Dev Settings Model"）
  let i = 0;
  for (const ch of t) {
    if (ch === q[i]) i += 1;
    if (i >= q.length) return 35;
  }
  return 0;
}

function scoreItem(item: CommandItem, query: string): number {
  return Math.max(
    scoreText(item.title, query),
    item.subtitle ? scoreText(item.subtitle, query) : 0,
    item.keywords ? scoreText(item.keywords, query) : 0,
  );
}

export interface CommandPaletteProps {
  /** 截图等宿主动作（由 App 注入，避免面板直接耦合业务实现） */
  onScreenshot?: () => void;
}

export function CommandPalette({ onScreenshot }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [fileItems, setFileItems] = useState<CommandItem[]>([]);
  const [recent, setRecent] = useState<string[]>(() => loadRecent());
  const openRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const setActiveModule = useAppStore((s) => s.setActiveModule);
  const toggleImmersive = useAppStore((s) => s.toggleImmersive);
  const immersive = useAppStore((s) => s.immersive);
  const pluginRegistry = useAppStore((s) => s.pluginRegistry);

  const notes = useNotesStore((s) => s.notes);
  const loadNoteContent = useNotesStore((s) => s.loadNoteContent);
  const createNote = useNotesStore((s) => s.createNote);

  const openPalette = useCallback(() => {
    if (openRef.current) return;
    setQuery('');
    setFileItems([]);
    setActiveIndex(0);
    setOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
    setFileItems([]);
  }, []);

  useEffect(() => { openRef.current = open; }, [open]);

  // 全局快捷键：Ctrl/Cmd+K；在输入框/可编辑区里默认让位（笔记的 Ctrl+K 是插入链接），
  // 需要强制打开时用 Ctrl/Cmd+Shift+K。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || e.key.toLowerCase() !== 'k') return;
      if (openRef.current) {
        e.preventDefault();
        inputRef.current?.select();
        return;
      }
      const target = e.target as HTMLElement | null;
      const editable = !!target && (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      );
      if (editable && !e.shiftKey) return;
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
  }, [openPalette]);

  const recordRecent = useCallback((id: string) => {
    setRecent((prev) => {
      const next = [id, ...prev.filter((x) => x !== id)].slice(0, RECENT_MAX);
      saveRecent(next);
      return next;
    });
  }, []);

  // 静态 provider：模块 / 动作 / 笔记
  const staticItems = useMemo<CommandItem[]>(() => {
    const items: CommandItem[] = [];
    const seen = new Set<string>();

    const moduleItem = (id: string, title: string, subtitle: string, iconName?: string): CommandItem => ({
      id: `module:${id}`,
      title,
      subtitle,
      group: '模块',
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
    ) => items.push({ id: `action:${id}`, title, subtitle, group: '动作', icon, run, keywords });

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
        group: '笔记',
        icon: <StickyNote size={16} />,
        keywords: `${n.id} ${n.date ?? ''}`,
        run: () => {
          setActiveModule('notes');
          loadNoteContent(n.id);
        },
      }));
    items.push(...noteItems);

    return items;
  }, [pluginRegistry, notes, immersive, setActiveModule, toggleImmersive, createNote, loadNoteContent, onScreenshot]);

  // 文件搜索（fs_search）：查询 ≥2 字时防抖调用；结果作为独立 provider
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) {
      setFileItems([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      invoke<SearchResult[]>('fs_search', { query: q, limit: 20 })
        .then((rows) => {
          if (cancelled) return;
          setFileItems((rows || []).map((r) => ({
            id: `file:${r.path}`,
            title: r.name || r.path,
            subtitle: r.path,
            group: '文件' as const,
            icon: r.is_dir ? <Folder size={16} /> : <FileText size={16} />,
            keywords: r.path,
            run: () => { void invoke('fs_open_path', { path: r.path }); },
          })));
        })
        .catch(() => { if (!cancelled) setFileItems([]); });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const visibleItems = useMemo(() => {
    const q = query.trim();
    const recentSet = new Set(recent);
    const all = q ? [...staticItems, ...fileItems] : staticItems;
    const scored = all
      .map((item) => {
        const base = q ? scoreItem(item, q) : 1;
        if (base <= 0) return null;
        return { item, score: base + (recentSet.has(item.id) ? 20 : 0) };
      })
      .filter((x): x is { item: CommandItem; score: number } => !!x)
      .sort((a, b) => b.score - a.score || Number(recentSet.has(b.item.id)) - Number(recentSet.has(a.item.id)))
      .slice(0, MAX_RESULTS);
    // 分组顺序固定：模块 → 动作 → 笔记 → 文件
    const order: CommandItem['group'][] = ['模块', '动作', '笔记', '文件'];
    const groups = new Map<CommandItem['group'], CommandItem[]>();
    for (const { item } of scored) {
      const list = groups.get(item.group) ?? [];
      list.push(item);
      groups.set(item.group, list);
    }
    return order.flatMap((g) => groups.get(g) ?? []);
  }, [query, staticItems, fileItems, recent]);

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
    recordRecent(item.id);
    closePalette();
    try {
      await item.run();
    } catch (err) {
      console.error('[command-palette] 执行失败:', item.id, err);
    }
  }, [closePalette, recordRecent]);

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
      className="fixed inset-0 z-[9998] flex items-start justify-center pt-[12vh] px-4 bg-black/35 backdrop-blur-[2px] fade-in"
      onMouseDown={(e) => { if (e.target === e.currentTarget) closePalette(); }}
    >
      <div
        className="w-[min(680px,94vw)] max-h-[62vh] flex flex-col rounded-2xl overflow-hidden border border-white/70 dark:border-stone-600/50 bg-white/95 dark:bg-stone-800/95 shadow-2xl shadow-black/30"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-200/60 dark:border-stone-700/60">
          <Search size={16} className="text-neutral-400 dark:text-stone-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
            onKeyDown={onInputKeyDown}
            placeholder="搜索模块、笔记、文件或动作…"
            className="flex-1 bg-transparent outline-none text-sm text-neutral-700 dark:text-stone-100 placeholder:text-neutral-400 dark:placeholder:text-stone-500"
            spellCheck={false}
          />
          <kbd className="px-1.5 py-0.5 rounded border border-neutral-200/70 dark:border-stone-600/60 text-[10px] text-neutral-400 dark:text-stone-500">Ctrl K</kbd>
        </div>

        <div ref={listRef} className="flex-1 overflow-y-auto py-1">
          {visibleItems.length === 0 ? (
            <div className="px-4 py-10 text-center text-xs text-neutral-400 dark:text-stone-500">
              {query.trim().length >= 2 ? '没有匹配项' : '输入关键字开始搜索'}
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
                      <span className="block text-sm truncate">{item.title}</span>
                      {item.subtitle && (
                        <span className="block text-[11px] text-neutral-400 dark:text-stone-500 truncate">
                          {item.subtitle}
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
            <span className="flex items-center gap-1"><ArrowUp size={11} /><ArrowDown size={11} /> 选择</span>
            <span className="flex items-center gap-1"><CornerDownLeft size={11} /> 打开</span>
            <span>Esc 关闭</span>
          </span>
          <span>{visibleItems.length} 项</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
