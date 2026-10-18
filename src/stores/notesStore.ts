import { create } from 'zustand';
import { api, type NoteInfo } from '@/lib/api';
import { logger } from '@/lib/logger';
import { renderMarkdownPreview } from '@/core/notes/markdown';
import { resolveLocalImagesInHtml } from '@/lib/localImage';
import type { CSSProperties } from 'react';

const AUTO_SAVE_DEBOUNCE_MS = 1000;

/**
 * 笔记域状态：列表、当前编辑、标签、搜索、派生数据。
 *
 * 将原本散落在 App.tsx 的 9 个 useState + 3 个 useCallback + 3 个 useEffect
 * 收敛为单一可信源，消除 prop drilling 与闭包陷阱。
 */
interface FavoriteMeta {
  createdAt: number;
  gradientSeed: number;
}

interface NotesState {
  // 列表
  notes: NoteInfo[];
  // 当前编辑
  currentNoteId: string | null;
  title: string;
  content: string;
  htmlContent: string;
  // 搜索
  searchQuery: string;
  contentSearchResults: Set<string>;
  // 标签
  currentNoteTags: string[];
  allTags: string[];
  noteTagsMap: Record<string, string[]>;
  // 常用笔记
  favoriteIds: Set<string>;
  favoriteMeta: Map<string, FavoriteMeta>;
  summonQueue: string[];

  // ---- actions ----
  setNotes: (notes: NoteInfo[]) => void;
  setSearchQuery: (q: string) => void;
  setTitle: (t: string) => void;
  setContent: (c: string) => void;
  /** 切换当前笔记并加载内容/标签 */
  loadNoteContent: (id: string) => void;
  /** 清空当前编辑（不删除笔记） */
  clearCurrent: () => void;
  /** 外部设置内容时同步标题（如中转站打开可读文件） */
  openExternalContent: (newTitle: string, newContent: string) => void;
  /**
   * 刷新标签映射与所有标签。
   * force=true 跳过 TTL 去重（确实需要看到最新数据时用，如保存标签失败后的重试）。
   * 重复调用会被 in-flight 合并 + TTL 去重，不会每次打穿后端全目录扫描。
   */
  refreshTags: (force?: boolean) => void;
  /** 标签变更（保存到后端并刷新映射） */
  saveTags: (newTags: string[]) => Promise<void>;
  /** 初始化：加载笔记列表 + 标签映射 */
  init: () => void;
  /** 刷新笔记列表数据 */
  refreshNotes: (data: NoteInfo[]) => void;
  /** 内容搜索（防抖）由组件层 useEffect 触发 */
  setContentSearchResults: (s: Set<string>) => void;
  /** 创建新笔记并加载 */
  createNote: () => Promise<void>;
  // 常用笔记 actions
  loadFavorites: () => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  isFavorite: (id: string) => boolean;
  getGradientStyle: (id: string) => CSSProperties;
  getNextFavorite: () => string | null;
  onFavoriteNoteClosed: (id: string, modified: boolean) => void;
}

// 自动保存 timer 句柄（模块级，避免存入 store）
let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
// Markdown 渲染 rAF 句柄（每帧仅渲染最后一次，预览跟手）
let renderFrame: number | undefined;
// Markdown 渲染缓存：content（原始 Markdown）→ HTML。仅缓存最近一次结果；
// 输入未变时跳过 marked.parse（大笔记连续输入场景下，避免每次按键重复全量解析）。
let mdRenderCacheSource: string | undefined;
let mdRenderCacheHtml: string | undefined;

/**
 * 标签数据拉取的治理：in-flight 合并 + TTL 去重。
 *
 * 背景（P1-7「有界缓存 + 轮询治理」）：
 * - refreshTags() 每次调用会打两次后端全目录扫描（getAllNoteTagsMap + getAllTags）。
 *   saveTags() 保存后旧实现直接 refreshTags()，连续改几次标签就重复扫几遍；
 *   init() 也会拉一轮。高频保存时后端被同一份数据反复全量读取。
 * - 轮询治理结论：notesStore 本身**没有任何 setInterval 轮询**（全仓 16 处 setInterval
 *   分别在 Capsule.tsx / FileSearchPanel.tsx / DeskpetPet.tsx / AgentTracePanel.tsx 等
 *   其他模块），所以这里治理的是「事件驱动的重复全量拉取」，不是定时器。
 *
 * 规则：
 * - 同一时刻只允许一次在途请求，后来的调用复用同一个 Promise（in-flight 合并）；
 * - 距上次成功不足 TAGS_TTL_MS 的非 force 调用直接跳过（TTL 去重）；
 * - 失败不清掉 lastDoneAt，让下一次调用仍然放行（避免失败后被 TTL 静默吞掉）。
 */
const TAGS_TTL_MS = 1500;
let tagsInflight: Promise<void> | null = null;
let tagsLastDoneAt = 0;
// allTags 单独一份 TTL：loadNoteContent 每次切笔记都会读它（编辑器要算"未使用的标签"），
// 旧实现下每切一次笔记就触发一次后端全目录扫描，加 TTL 后同一次会话内只拉一次。
let allTagsInflight: Promise<unknown> | null = null;
let allTagsLastDoneAt = 0;

/** 带 TTL + in-flight 合并的 allTags 拉取（见 TAGS_TTL_MS 注释） */
function loadAllTagsCached(
  set: (partial: Partial<NotesState>) => void,
  force = false,
) {
  if (!force && (Date.now() - allTagsLastDoneAt < TAGS_TTL_MS || allTagsInflight)) return;
  allTagsInflight = api.getAllTags()
    .then((tags) => { set({ allTags: tags }); allTagsLastDoneAt = Date.now(); })
    .catch((err) => logger.notes.loadError('加载所有标签', err))
    .finally(() => { allTagsInflight = null; });
}

/**
 * noteTagsMap 修剪：只保留「当前 notes 列表里存在的笔记」。
 * notes 未加载（length===0）时不修剪——init() 里标签映射可能比笔记列表先返回，
 * 此时求交会把整张表清空。
 */
function pruneTagsMapToLiveNotes(map: Record<string, string[]>, liveIds: Set<string>): Record<string, string[]> {
  if (liveIds.size === 0) return map;
  const pruned: Record<string, string[]> = {};
  for (const [id, tags] of Object.entries(map)) {
    if (liveIds.has(id)) pruned[id] = tags;
  }
  return pruned;
}

export const useNotesStore = create<NotesState>((set, get) => ({
  notes: [],
  currentNoteId: null,
  title: '',
  content: '',
  htmlContent: '',
  searchQuery: '',
  contentSearchResults: new Set(),
  currentNoteTags: [],
  allTags: [],
  noteTagsMap: {},
  favoriteIds: new Set(),
  favoriteMeta: new Map(),
  summonQueue: [],

  setNotes: (notes) => set({ notes }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setTitle: (title) => {
    set({ title });
    scheduleAutoSave(get, set);
  },
  setContent: (content) => {
    set({ content });
    scheduleAutoSave(get, set);
    scheduleMarkdownRender(set, get);
  },
  setContentSearchResults: (contentSearchResults) => set({ contentSearchResults }),

  loadNoteContent: (id) => {
    const { currentNoteId } = get();
    if (id === currentNoteId) {
      logger.notes.skipLoad(id);
      return;
    }
    logger.notes.switchNote(id);
    set({ currentNoteId: id });
    api.getNoteContent(id).then((data) => {
      logger.notes.contentLoaded(id, data.title);
      // 去掉内容首行 # 大标题（标题输入框已显示，编辑区和预览区无需重复）
      const c = (data.content || '').replace(/^#\s+[^\n]*\n?/, '').trimStart();
      set({ title: data.title || '无标题笔记', content: c });
      // 触发 markdown 重渲染
      scheduleMarkdownRender(set, get);
    }).catch(err => logger.notes.loadError('加载笔记内容', err));
    api.getNoteTags(id).then(tags => set({ currentNoteTags: tags })).catch((err) => {
      logger.notes.loadError('加载笔记标签', err);
      set({ currentNoteTags: [] });
    });
    // 带 TTL 的 allTags（编辑器要算"未使用的标签"），不要每切一次笔记就打一次全目录扫描
    loadAllTagsCached(set);
  },

  clearCurrent: () => {
    logger.notes.clearCurrent();
    set({ title: '', content: '', currentNoteId: null, htmlContent: '' });
  },

  openExternalContent: (newTitle, newContent) => {
    set({ title: newTitle, content: newContent });
    scheduleMarkdownRender(set, get);
  },

  refreshTags: (force = false) => {
    // TTL 去重：非 force 且刚拉过 → 直接复用上次结果
    if (!force && Date.now() - tagsLastDoneAt < TAGS_TTL_MS) return;
    // in-flight 合并：已有在途请求 → 复用，不再发起第二次全目录扫描
    if (tagsInflight) return;
    const p = (async () => {
      const [map, tags] = await Promise.all([
        api.getAllNoteTagsMap(),
        api.getAllTags(),
      ]);
      // 有界化：删掉的笔记不要永久留在映射里（refreshTags 只覆盖不清除，
      // 旧实现下已删除笔记的标签条目会一直残留到进程结束）
      const liveIds = new Set(get().notes.map(n => n.id));
      set({ noteTagsMap: pruneTagsMapToLiveNotes(map, liveIds), allTags: tags });
      tagsLastDoneAt = Date.now();
    })().catch((err) => {
      logger.notes.loadError('刷新标签映射', err);
    }).finally(() => {
      tagsInflight = null;
    });
    tagsInflight = p;
  },

  saveTags: async (newTags) => {
    const { currentNoteId } = get();
    set({ currentNoteTags: newTags });
    if (currentNoteId) {
      try {
        await api.setNoteTags(currentNoteId, newTags);
        // 本地增量修补，而不是 refreshTags()：保存一次标签只需要改这一条映射，
        // 旧实现会为此触发两次后端全目录扫描（高频编辑标签时重复打）。
        // allTags 是「所有笔记标签的并集」，本地合并新标签即可保持正确。
        const { noteTagsMap, allTags } = get();
        const nextMap = { ...noteTagsMap, [currentNoteId]: newTags };
        const nextAllTags = [...allTags];
        for (const t of newTags) {
          if (t && !nextAllTags.includes(t)) nextAllTags.push(t);
        }
        set({ noteTagsMap: nextMap, allTags: nextAllTags });
      } catch (err) {
        logger.notes.loadError('保存标签', err);
        // 保存失败才回退到全量刷新（force 跳过 TTL，确保拿到真实状态）
        get().refreshTags(true);
      }
    }
  },

  init: () => {
    logger.notes.init();
    api.getAllNotes().then((data) => {
      logger.notes.listLoaded(data.length);
      set({ notes: data });
      const { currentNoteId } = get();
      if (data && data.length > 0 && !currentNoteId) {
        logger.notes.autoLoadFirst(data[0].id);
        get().loadNoteContent(data[0].id);
      }
    }).catch(err => logger.notes.loadError('加载笔记列表', err));

    // 走 refreshTags() 而不是直接 invoke：让 TTL/in-flight 治理覆盖初始化路径
    // （init 与后续 refreshTags 若撞车，旧实现会并发打两次全目录扫描）
    get().refreshTags(true);

    get().loadFavorites();
  },

  refreshNotes: (data) => {
    logger.notes.refreshList(data?.length);
    // 同步修剪标签映射：删除笔记后映射里残留的条目只靠 refreshTags 覆盖，
    // 在两次 refreshTags 之间会一直占内存（有界化到活笔记集合）。
    const { noteTagsMap } = get();
    const pruned = pruneTagsMapToLiveNotes(noteTagsMap, new Set((data ?? []).map(n => n.id)));
    set({ notes: data, noteTagsMap: pruned });
  },

  createNote: async () => {
    const newId = crypto.randomUUID();
    logger.notes.create(newId);
    await api.saveNote(newId, '新建笔记', '');
    const updated = await api.getAllNotes();
    set({ notes: updated });
    get().loadNoteContent(newId);
  },

  loadFavorites: async () => {
    try {
      const ids = await api.getAllFavorites();
      const metaMap = new Map<string, FavoriteMeta>();
      for (const id of ids) {
        const note = get().notes.find(n => n.id === id);
        if (note) {
          metaMap.set(id, {
            createdAt: new Date(note.date).getTime(),
            gradientSeed: Math.random(),
          });
        }
      }
      const queue = [...ids].sort((a, b) => {
        const noteA = get().notes.find(n => n.id === a);
        const noteB = get().notes.find(n => n.id === b);
        return (noteB?.date.localeCompare(noteA?.date ?? '') ?? 0);
      });
      set({ favoriteIds: new Set(ids), favoriteMeta: metaMap, summonQueue: queue });
    } catch (e) {
      console.error('[Notes] 加载常用笔记失败:', e);
    }
  },

  toggleFavorite: async (id: string) => {
    try {
      const isFav = await api.toggleFavoriteNote(id);
      const { favoriteIds, favoriteMeta, summonQueue } = get();
      const newIds = new Set(favoriteIds);
      const newMeta = new Map(favoriteMeta);
      const newQueue = [...summonQueue];

      if (isFav) {
        newIds.add(id);
        newMeta.set(id, {
          createdAt: Date.now(),
          gradientSeed: Math.random(),
        });
        newQueue.push(id);
      } else {
        newIds.delete(id);
        newMeta.delete(id);
        const idx = newQueue.indexOf(id);
        if (idx >= 0) newQueue.splice(idx, 1);
      }

      set({ favoriteIds: newIds, favoriteMeta: newMeta, summonQueue: newQueue });
    } catch (e) {
      console.error('[Notes] 切换常用笔记失败:', e);
    }
  },

  isFavorite: (id: string) => {
    return get().favoriteIds.has(id);
  },

  getGradientStyle: (id: string) => {
    const meta = get().favoriteMeta.get(id);
    if (!meta) return {};
    const angle = Math.round(meta.gradientSeed * 360);
    return {
      background: `linear-gradient(${angle}deg, rgba(187,222,251,0.4), rgba(252,228,236,0.4))`,
    };
  },

  getNextFavorite: () => {
    const { summonQueue, favoriteIds } = get();
    for (const id of summonQueue) {
      if (favoriteIds.has(id)) {
        // 召唤后轮转到队尾（不等待关闭，立即轮转）
        const newQueue = summonQueue.filter(x => x !== id);
        newQueue.push(id);
        set({ summonQueue: newQueue });
        return id;
      }
    }
    return null;
  },

  onFavoriteNoteClosed: (id: string, modified: boolean) => {
    if (!modified) {
      const { summonQueue } = get();
      const newQueue = summonQueue.filter(x => x !== id);
      newQueue.push(id);
      set({ summonQueue: newQueue });
    }
  },
}));

/** 防抖自动保存（保存后刷新列表，标题修改同步） */
function scheduleAutoSave(
  get: () => NotesState,
  set: (partial: Partial<NotesState>) => void,
) {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    const { currentNoteId, title, content } = get();
    if (currentNoteId && title) {
      logger.notes.autoSaveTrigger(currentNoteId, title);
      api.saveNote(currentNoteId, title, content)
        .then(() => api.getAllNotes())
        .then((notes) => set({ notes }))
        .catch(err => logger.notes.loadError('自动保存', err));
      // 同时生成存档快照（设置「中转站 / 存档」：笔记一变动即生成快照，可恢复/删除）
      try {
        const b64 = btoa(unescape(encodeURIComponent(content)));
        api.archiveSnapshot('note', currentNoteId, title, b64, 'md').catch(() => {});
      } catch {
        /* base64 编码失败则跳过，不影响主流程 */
      }
    }
  }, AUTO_SAVE_DEBOUNCE_MS);
}

/** Markdown 渲染（rAF 去抖：每帧仅执行最后一次，预览跟手）
 *  渲染规则见 renderMarkdownPreview：源码原样交给 marked，不再对连续空行做 <br> 预处理
 *  （旧做法删掉了真实换行，导致空行之后的 `##`/列表/引用/围栏代码全部失效）。
 *  缓存：对原始 Markdown 源码做比较，源码未变则直接复用上次 HTML，
 *  跳过 marked.parse 全量解析（大笔记连续输入时避免每次按键都重算）。
 */
function scheduleMarkdownRender(
  set: (partial: Partial<NotesState>) => void,
  get: () => NotesState,
) {
  if (renderFrame) cancelAnimationFrame(renderFrame);
  renderFrame = requestAnimationFrame(async () => {
    renderFrame = undefined;
    const { content } = get();
    logger.notes.render(content?.length || 0);
    // 缓存命中：源码未变，跳过 marked.parse（仅仍需 resolve 图片——图片有独立 LRU 缓存）
    let html: string;
    if (content === mdRenderCacheSource) {
      html = mdRenderCacheHtml ?? '';
    } else {
      html = renderMarkdownPreview(content || '');
      mdRenderCacheSource = content;
      mdRenderCacheHtml = html;
    }
    // 解析 localimg:// 占位引用为 data URL（图片不内联进笔记文本，渲染时再读取，带缓存）
    const resolved = await resolveLocalImagesInHtml(html);
    set({ htmlContent: resolved });
  });
}
