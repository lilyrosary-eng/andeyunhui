import { create } from 'zustand';
import { api, type NoteInfo } from '@/lib/api';
import { logger } from '@/lib/logger';
import { marked } from 'marked';
import { resolveLocalImagesInHtml } from '@/lib/localImage';

const AUTO_SAVE_DEBOUNCE_MS = 1000;

/**
 * 笔记域状态：列表、当前编辑、标签、搜索、派生数据。
 *
 * 将原本散落在 App.tsx 的 9 个 useState + 3 个 useCallback + 3 个 useEffect
 * 收敛为单一可信源，消除 prop drilling 与闭包陷阱。
 */
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
  /** 刷新标签映射与所有标签 */
  refreshTags: () => void;
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
}

// 自动保存 timer 句柄（模块级，避免存入 store）
let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;
// Markdown 渲染 rAF 句柄（每帧仅渲染最后一次，预览跟手）
let renderFrame: number | undefined;

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
    api.getAllTags().then(tags => set({ allTags: tags })).catch((err) => logger.notes.loadError('加载所有标签', err));
  },

  clearCurrent: () => {
    logger.notes.clearCurrent();
    set({ title: '', content: '', currentNoteId: null, htmlContent: '' });
  },

  openExternalContent: (newTitle, newContent) => {
    set({ title: newTitle, content: newContent });
    scheduleMarkdownRender(set, get);
  },

  refreshTags: () => {
    api.getAllNoteTagsMap().then(map => set({ noteTagsMap: map }))
      .catch((err) => logger.notes.loadError('刷新标签映射', err));
    api.getAllTags().then(tags => set({ allTags: tags }))
      .catch((err) => logger.notes.loadError('刷新所有标签', err));
  },

  saveTags: async (newTags) => {
    const { currentNoteId } = get();
    set({ currentNoteTags: newTags });
    if (currentNoteId) {
      try {
        await api.setNoteTags(currentNoteId, newTags);
        get().refreshTags();
      } catch (err) {
        logger.notes.loadError('保存标签', err);
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

    api.getAllNoteTagsMap().then(map => set({ noteTagsMap: map }))
      .catch((err) => logger.notes.loadError('加载标签映射', err));
  },

  refreshNotes: (data) => {
    logger.notes.refreshList(data?.length);
    set({ notes: data });
  },

  createNote: async () => {
    const newId = crypto.randomUUID();
    logger.notes.create(newId);
    await api.saveNote(newId, '新建笔记', '');
    const updated = await api.getAllNotes();
    set({ notes: updated });
    get().loadNoteContent(newId);
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

/** Markdown 渲染（rAF 去抖：每帧仅执行最后一次，预览跟手） */
function scheduleMarkdownRender(
  set: (partial: Partial<NotesState>) => void,
  get: () => NotesState,
) {
  if (renderFrame) cancelAnimationFrame(renderFrame);
  renderFrame = requestAnimationFrame(async () => {
    renderFrame = undefined;
    const { content } = get();
    logger.notes.render(content?.length || 0);
    // 保留空行：将连续 2+ 个 \n 按空行数转为等量 <br>，
    // 避免 Markdown 段落折叠导致预览空行数与编辑器不一致。
    const preserved = (content || '').replace(/\n{2,}/g, (match) =>
      '<br>'.repeat(match.length),
    );
    const html = await marked.parse(preserved, { gfm: true, breaks: true });
    // 解析 localimg:// 占位引用为 data URL（图片不内联进笔记文本，渲染时再读取，带缓存）
    const resolved = await resolveLocalImagesInHtml(html);
    set({ htmlContent: resolved });
  });
}
