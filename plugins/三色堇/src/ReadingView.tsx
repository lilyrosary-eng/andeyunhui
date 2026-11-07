/// <reference path="../../global.d.ts" />
// 阅读视图 — CSS 多栏分页 + 三种布局模式
// 横板/双栏：多章滑动窗口动态缓存（当前章前后各若干章），无缝翻页
// 竖版：单章节滚动，到底部自动下一章
// 高亮/批注：分片存储见 readingHighlights.ts；本文件负责「窗口 DOM 重建后按文本节点重放」与
// 「竖版选字 → 工具条创建」。重放只加背景色 <mark>（padding/margin/border 恒 0，不影响页宽测量）。

const React = window.__HOST_REACT__;
import { T, useLang } from '../../_shared/pluginRuntime';
import {
  addHighlights,
  buildChapterIndexMap,
  deleteHighlight,
  emitHighlightsChanged,
  getHighlight,
  HIGHLIGHT_BG,
  HIGHLIGHT_COLORS,
  listHighlights,
  onHighlightsChanged,
  updateHighlight,
  validateHighlightAgainstText,
  type HighlightColor,
  type HighlightRecord,
  type NewHighlight,
} from './readingHighlights';
import {
  getReadingSettings, setReadingSettings, DEFAULT_READING_SETTINGS,
  READING_FONT_MIN, READING_FONT_MAX, READING_LINE_MIN, READING_LINE_MAX,
  type ReadingSettings,
} from './readingSettings';
import {
  listBookmarks, addBookmark, removeBookmark, findBookmarkAt,
  type ReadingBookmark,
} from './readingBookmarks';
const { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } = React;
const hostApi = window.__HOST_API__;

interface ReadingChapter {
  id: string;
  title: string;
  content: string;
}
interface ReadingBook {
  filePath: string;
  title: string;
  author: string | null;
  chapters: ReadingChapter[];
}

interface ReadingViewProps {
  book: ReadingBook;
  onBack: () => void;
  externalChapterIndex?: number;
  onChapterChange?: (index: number) => void;
  onScrollProgress?: (percent: number) => void;
  // 恢复用：竖版章内滚动百分比 / 分页章内页码偏移（由父组件在恢复时一次性下发，apply 后清空）
  externalScrollPercent?: number | null;
  externalPageInChapter?: number | null;
  onPageProgress?: (pageInChapter: number) => void;
  // 一次性外部高亮跳转（侧边栏笔记/命令面板点击）：定位并短暂高亮后回调父组件清空
  externalHighlightId?: string | null;
  onExternalHighlightConsumed?: () => void;
}

// ============ 布局常量 ============
const GAP = 48;
const PAD = 44;
const DRAG_THRESHOLD = 60;
const WHEEL_COOLDOWN = 280;
const BOOK_GUTTER = 24;
// 动态缓存：当前章前后各缓存 WINDOW_RADIUS 章（越大越不易在切章时露白页，
// 但拼接的 DOM 也越多）。共渲染 WINDOW_SIZE 章的滑动窗口。
const WINDOW_RADIUS = 2;
const WINDOW_SIZE = WINDOW_RADIUS * 2 + 1;

type LayoutMode = 'horizontal' | 'vertical' | 'book';

/** 排版设置弹层里的一行「− 值 +」控件 */
function TypoRow({ label, value, canDec, canInc, onDec, onInc }: {
  label: string;
  value: string;
  canDec: boolean;
  canInc: boolean;
  onDec: () => void;
  onInc: () => void;
}) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-neutral-500 dark:text-stone-400">{label}</span>
      <div className="flex items-center gap-1">
        <button
          onClick={onDec}
          disabled={!canDec}
          className="btn-press w-6 h-6 rounded-md bg-black/5 dark:bg-white/10 text-sm leading-none disabled:opacity-30 hover:bg-black/10 dark:hover:bg-white/20"
        >
          −
        </button>
        <span className="w-12 text-center text-xs tabular-nums">{value}</span>
        <button
          onClick={onInc}
          disabled={!canInc}
          className="btn-press w-6 h-6 rounded-md bg-black/5 dark:bg-white/10 text-sm leading-none disabled:opacity-30 hover:bg-black/10 dark:hover:bg-white/20"
        >
          +
        </button>
      </div>
    </div>
  );
}

interface ChapterBoundary {
  index: number;
  startPage: number;
  endPage: number;
}

// ============ 高亮 DOM 工具（重放用） ============
// 约定：高亮偏移量的"章节纯文本"= 章节 .chapter-marker 子树内所有 Text 节点按文档序拼接。
// wrapRange / unwrapMarks 都基于该口径，保证存储偏移与 DOM 重放一致。

const HL_CONTEXT = 30;

/** 创建高亮 mark：只有背景色，padding/margin/border 显式清零 —— 不得参与页宽测量 */
function createMarkEl(id: string, color: HighlightColor): HTMLElement {
  const m = document.createElement('mark');
  m.setAttribute('data-hl-id', id);
  m.setAttribute('data-hl-color', color);
  m.style.cssText =
    `background-color:${HIGHLIGHT_BG[color] || HIGHLIGHT_BG.yellow};` +
    'color:inherit;padding:0;margin:0;border:0;border-radius:0;box-shadow:none;';
  return m;
}

/** 解包全部高亮 mark（还原纯文本 DOM），重放前调用保证幂等 */
function unwrapMarks(root: HTMLElement): void {
  const marks = root.querySelectorAll('mark[data-hl-id]');
  if (marks.length === 0) return;
  const touched = new Set<Node>();
  marks.forEach((mm) => {
    const m = mm as HTMLElement;
    const p = m.parentNode;
    if (!p) return;
    while (m.firstChild) p.insertBefore(m.firstChild, m);
    p.removeChild(m);
    touched.add(p);
  });
  // 合并相邻文本节点，让下次遍历得到的偏移序列稳定
  touched.forEach((n) => {
    try { (n as Node & { normalize?: () => void }).normalize?.(); } catch { /* 忽略 */ }
  });
}

interface TextWalkEntry { node: Text; start: number; end: number }

function walkTextNodes(root: HTMLElement): { text: string; entries: TextWalkEntry[] } {
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const entries: TextWalkEntry[] = [];
  let text = '';
  let n = tw.nextNode();
  while (n) {
    const t = n as Text;
    const len = t.data.length;
    if (len > 0) {
      entries.push({ node: t, start: text.length, end: text.length + len });
      text += t.data;
    }
    n = tw.nextNode();
  }
  return { text, entries };
}

/** 把 [start,end) 覆盖的文本片段各自包进 mark。逐条调用前先按 start 降序，减少 split 影响 */
function wrapRange(root: HTMLElement, start: number, end: number, id: string, color: HighlightColor): void {
  if (end - start <= 0) return;
  const { entries } = walkTextNodes(root);
  const pieces: Text[] = [];
  for (const e of entries) {
    const from = Math.max(start, e.start);
    const to = Math.min(end, e.end);
    if (to - from <= 0) continue;
    if (e.node.parentElement?.closest('mark[data-hl-id]')) continue; // 已着色：首条优先，避免嵌套
    const localFrom = from - e.start;
    const localTo = to - e.start;
    let node = e.node;
    if (localTo < node.data.length) { try { node.splitText(localTo); } catch { continue; } }
    if (localFrom > 0) { try { node = node.splitText(localFrom) as Text; } catch { continue; } }
    pieces.push(node);
  }
  for (const p of pieces) {
    const parent = p.parentNode;
    if (!parent) continue;
    const m = createMarkEl(id, color);
    parent.insertBefore(m, p);
    m.appendChild(p);
  }
}

/** 选区与章节 marker 的交集 → 每章一条片段（跨章选择自动拆分）。偏移口径与 walkTextNodes 一致 */
function buildSelectionSegments(
  container: HTMLElement,
  range: Range,
  chapters: ReadingChapter[],
): NewHighlight[] {
  const out: NewHighlight[] = [];
  const markers = Array.from(container.querySelectorAll<HTMLElement>('[data-chapter-index]'));
  for (const marker of markers) {
    const di = parseInt(marker.getAttribute('data-chapter-index') || '-1', 10);
    if (di < 0) continue;
    const mr = document.createRange();
    try { mr.selectNodeContents(marker); } catch { continue; }
    let s: number;
    let e: number;
    const sCmp = mr.comparePoint(range.startContainer, range.startOffset);
    const eCmp = mr.comparePoint(range.endContainer, range.endOffset);
    if (sCmp === 1) continue;          // 选区起点在本章之后
    if (eCmp === -1) break;            // 选区终点在本章之前（marker 有序，可直接结束）
    const len = mr.toString().length;
    if (sCmp === -1) s = 0;
    else {
      const r2 = mr.cloneRange(); r2.setEnd(range.startContainer, range.startOffset);
      s = r2.toString().length;
    }
    if (eCmp === 1) e = len;
    else {
      const r3 = mr.cloneRange(); r3.setEnd(range.endContainer, range.endOffset);
      e = r3.toString().length;
    }
    if (e - s <= 0) continue;
    const text = mr.toString();
    out.push({
      chapterId: chapters[di]?.id || '',
      chapterIndex: di,
      start: s,
      end: e,
      quote: text.slice(s, e),
      prefix: text.slice(Math.max(0, s - HL_CONTEXT), s),
      suffix: text.slice(e, e + HL_CONTEXT),
      color: 'yellow',
      note: '',
    });
  }
  return out;
}

export function ReadingView({ book, onBack, externalChapterIndex, onChapterChange, onScrollProgress, externalScrollPercent, externalPageInChapter, onPageProgress, externalHighlightId, onExternalHighlightConsumed }: ReadingViewProps) {
  useLang();
  // 分页状态（横板/双栏模式）
  const [absolutePage, setAbsolutePage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [pageWidth, setPageWidth] = useState(0);

  // UI 状态
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [noTransition, setNoTransition] = useState(false);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('horizontal');
  // 排版设置（字号 / 行距）：只走 localStorage，不写书文件
  const [readerSettings, setReaderSettingsState] = useState<ReadingSettings>(getReadingSettings);
  const [showTypoPanel, setShowTypoPanel] = useState(false);
  const updateReaderSettings = useCallback((patch: Partial<ReadingSettings>) => {
    setReaderSettingsState(setReadingSettings(patch));
  }, []);

  // 章节追踪
  const [chapterIndex, setChapterIndex] = useState(0);
  // 竖版滚动进度（0-100，表示当前章内的滚动位置）
  const [verticalScrollProgress, setVerticalScrollProgress] = useState(0);
  // 3章滑动窗口中心章节索引（仅渲染 windowCenter±1 三章，避免大书全拼接卡死）
  const [windowCenter, setWindowCenter] = useState(0);
  // 强制重测量 token：外部跳转（恢复进度）时即使窗口未变化也触发 measure，
  // 让 measure() 在边界就绪后消费 pendingJumpRef 完成跳转（修复「进度归零」）
  const [forceMeasureToken, setForceMeasureToken] = useState(0);
  // 竖版当前阅读章节（独立于 windowCenter，随滚动位置实时更新，不影响窗口渲染）
  const [displayedChapter, setDisplayedChapter] = useState(0);
  // 竖版目录跳转触发 token：即使目标章已落在同一渲染窗口内（combinedHtml 未变），
  // 也能让消费 verticalJumpRef 的 layout effect 执行，从而滚动到目标章顶部
  const [vJumpToken, setVJumpToken] = useState(0);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const verticalRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef({ startX: 0, active: false, offset: 0 });
  const wheelLock = useRef(0);
const boundariesRef = useRef<ChapterBoundary[]>([]);
// pendingJumpRef: 窗口滑动/模式切换后恢复阅读位置。
// pageInChapter=-1 表示跳到该章最后一页；useProgress=true 时按竖版进度估算章节内页码
const pendingJumpRef = useRef<{ chapterIndex: number; pageInChapter: number; useProgress?: boolean } | null>(null);
// 竖版滑动窗口后调整 scrollTop：保持视觉连续性
const verticalJumpRef = useRef<{ chapterIndex: number; position: 'top' | 'bottom'; scrollPercent?: number } | null>(null);
// chapterIndexRef / windowCenterRef: 让 externalChapterIndex effect
// 能读取最新值而不需要将其放入依赖数组（避免内部 chapterIndex 变化触发该 effect）
const chapterIndexRef = useRef(0);
const windowCenterRef = useRef(0);
// 记录上一次测量到的页面宽度，用于在"宽度变化"时临时关闭过渡动画
const lastPwRef = useRef(0);
// 记录上一次是否分页模式，用于判断模式切换方向（横版↔双栏 vs 竖版↔分页），
// 以便按正确的章节来源（chapterIndex / displayedChapter）重新定位
const prevPaginatedRef = useRef(true);
// absolutePageRef / verticalScrollProgressRef: 让模式切换 effect 在 measure 前读取最新值
const absolutePageRef = useRef(0);
const verticalScrollProgressRef = useRef(0);
// 过渡锁定时器：模式切换/窗口滑动期间保持 noTransition，避免重算 transform 产生"闪"
const transitionTimerRef = useRef<number | null>(null);
useEffect(() => { chapterIndexRef.current = chapterIndex; }, [chapterIndex]);
useEffect(() => { windowCenterRef.current = windowCenter; }, [windowCenter]);
const displayedChapterRef = useRef(0);
useEffect(() => { displayedChapterRef.current = displayedChapter; }, [displayedChapter]);
useEffect(() => { absolutePageRef.current = absolutePage; }, [absolutePage]);
useEffect(() => { verticalScrollProgressRef.current = verticalScrollProgress; }, [verticalScrollProgress]);
// 锁定过渡动画一段时间（默认 320ms，略大于翻页动画 280ms），
// 覆盖"模式切换可能跨多次提交"的场景，避免中间帧闪屏
const lockTransition = useCallback(() => {
  setNoTransition(true);
  if (transitionTimerRef.current !== null) window.clearTimeout(transitionTimerRef.current);
  transitionTimerRef.current = window.setTimeout(() => setNoTransition(false), 320);
}, []);

  const isBookMode = layoutMode === 'book';
  // 双栏模式改为"连续对页翻页"：始终展示两栏，但每次仅前进一栏
  //（原右栏滑到左栏位置、右栏显示新的一页），因此翻页步长恒为 1 栏。
  const pagesPerStep = 1;

  // 布局切换：竖版→分页时先预滑窗口到当前阅读章，使首帧即渲染正确章节内容，
  // 避免 mode-switch effect 提交后才滑窗导致的单帧旧内容闪烁
  const handleSetLayoutMode = useCallback((mode: LayoutMode) => {
    if (layoutMode === 'vertical' && mode !== 'vertical') {
      setWindowCenter(displayedChapterRef.current);
    }
    setLayoutMode(mode);
  }, [layoutMode]);
  const isPaginatedMode = layoutMode !== 'vertical';

  // ============ 滑动窗口动态缓存 ============
  // 仅渲染 windowCenter±WINDOW_RADIUS 的若干章，避免大书全章节拼接卡死。
  // windowStart 只随 windowCenter 变化，不随 book.chapters.length 变化（流式加载稳定）。
  const windowStart = Math.max(0, windowCenter - WINDOW_RADIUS);
  const windowEnd = Math.min(book.chapters.length, windowStart + WINDOW_SIZE);

  const combinedHtml = useMemo(() => {
    if (book.chapters.length === 0) return '';
    const slice = book.chapters.slice(windowStart, windowEnd);
    return slice.map((ch, i) => {
      const actualIdx = windowStart + i;
      const title = (ch.title || T('reading.chapterN', { n: actualIdx + 1 }))
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      // 首个窗口章不加 break-before（避免开头出现空白栏）；
      // 其余章节强制从新栏顶开始，保证"xx章"标题恒在栏顶、上一章内容不出现在本页上方，
      // 且上一章尾栏允许留白但不能全白（其内容已占据该栏）。
      const breakBefore = i === 0 ? '' : 'break-before: column;';
      return `<div class="chapter-marker" data-chapter-index="${actualIdx}" style="${breakBefore}"><h2 class="chapter-title-display">${title}</h2>${ch.content || ''}</div>`;
    }).join('');
  }, [book.chapters, windowStart, windowEnd]);

  const currentChapter = book.chapters[chapterIndex] || book.chapters[0] || { title: '—', content: '' };

  // ============ 高亮 / 批注 ============
  // 存储是唯一事实源（readingHighlights 分片）；本视图负责：
  // 1) combinedHtml / 布局 / 数据变化后，在当前窗口 DOM 上重放着色（含 quote 漂移校验与回写）；
  // 2) 选字工具条（竖版 / 横版 / 双栏同一套；翻页只走滚轮与键盘，不再抢选择事件）；
  // 3) 外部高亮跳转（一次性 externalHighlightId）。
  interface SelToolbarState {
    x: number;
    y: number;
    mode: 'selection' | 'existing';
    quote: string;
    segments: NewHighlight[];
    existingId?: string;
  }
  const [highlights, setHighlights] = useState<HighlightRecord[]>([]);
  const highlightsRef = useRef<HighlightRecord[]>([]);
  useEffect(() => { highlightsRef.current = highlights; }, [highlights]);
  const [selToolbar, setSelToolbar] = useState<SelToolbarState | null>(null);
  // 书签：列表 + 菜单开关（菜单里可跳转/删除，顶部星标记录当前页）
  const [bookmarks, setBookmarks] = useState<ReadingBookmark[]>(() => listBookmarks(book.filePath));
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  // 划词「问 AI」：菜单开关 + 结果面板（解释/翻译/概括都落在这里）
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const [aiPanel, setAiPanel] = useState<{ quote: string; text: string; loading: boolean } | null>(null);
  const [notePopover, setNotePopover] = useState<{ initial: string } | null>(null);
  const [noteText, setNoteText] = useState('');
  const extHlDeadlineRef = useRef(0);

  // 切书 → 重新加载高亮
  useEffect(() => {
    setHighlights(listHighlights(book.filePath));
    setBookmarks(listBookmarks(book.filePath));
    setSelToolbar(null);
    setNotePopover(null);
    extHlDeadlineRef.current = 0;
  }, [book.filePath]);

  // 外部变更（侧栏删除/编辑/导出）→ 重新加载
  useEffect(() => onHighlightsChanged((fp) => {
    const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
    if (norm(fp) === norm(book.filePath)) setHighlights(listHighlights(book.filePath));
  }), [book.filePath]);

  // —— 重放：窗口 DOM 会随切章/滑窗重建，这里在绘制前把着色补回去 ——
  useLayoutEffect(() => {
    if (book.chapters.length === 0) return;
    const container = isPaginatedMode ? contentRef.current : verticalRef.current;
    if (!container) return;
    const chapterMap = buildChapterIndexMap(highlights);
    const markers = container.querySelectorAll<HTMLElement>('[data-chapter-index]');
    const patches: Array<{ id: string; patch: Partial<HighlightRecord> }> = [];
    markers.forEach((marker) => {
      unwrapMarks(marker);
      const di = parseInt(marker.getAttribute('data-chapter-index') || '-1', 10);
      if (di < 0) return;
      const ch = book.chapters[di];
      const recs = chapterMap.get(ch?.id || '') || chapterMap.get(`idx:${di}`) || [];
      if (recs.length === 0) return;
      const { text } = walkTextNodes(marker);
      const applyList: HighlightRecord[] = [];
      for (const r of recs) {
        const v = validateHighlightAgainstText(r, text);
        if (v.changed) patches.push({ id: r.id, patch: { start: v.record.start, end: v.record.end, stale: v.record.stale } });
        if (!v.stale) applyList.push(v.record);
      }
      // 降序应用：先包裹靠后的片段，减小 split 对前段偏移的影响
      applyList.sort((a, b) => b.start - a.start);
      for (const rec of applyList) wrapRange(marker, rec.start, rec.end, rec.id, rec.color);
    });
    if (patches.length > 0) {
      // 漂移/失效回写（只标 stale，绝不删除）；随后刷新 state 触发重放收敛
      for (const p of patches) updateHighlight(book.filePath, p.id, p.patch, { touch: false });
      setHighlights(listHighlights(book.filePath));
    }
  }, [combinedHtml, isPaginatedMode, layoutMode, highlights, book.chapters, book.filePath]);

  // —— 外部高亮定位（一次性 externalHighlightId）：找到 → 跳转+闪现；找不到 → 等窗口/章节就绪重试，超时放弃 ——
  useEffect(() => {
    if (!externalHighlightId) { extHlDeadlineRef.current = 0; return; }
    const container = isPaginatedMode ? contentRef.current : verticalRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>(`mark[data-hl-id="${externalHighlightId}"]`);
    if (el) {
      if (isPaginatedMode) {
        // 分页模式：按栏偏移把该 mark 所在页翻出来（与 measure 的页码公式一致）
        const colGap = isBookMode ? BOOK_GUTTER : GAP;
        const st = (pageWidth + colGap) * pagesPerStep;
        const tol = Math.max(2, st * 0.05);
        const page = Math.max(0, Math.min(pageCount - 1, Math.floor((el.offsetLeft - PAD + tol) / st)));
        setAbsolutePage(page);
      } else {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      const prevBg = el.style.backgroundColor;
      el.style.backgroundColor = 'rgba(255, 140, 0, 0.65)';
      el.style.outline = '2px solid rgba(255, 140, 0, 0.55)';
      el.style.outlineOffset = '0';
      window.setTimeout(() => {
        el.style.backgroundColor = prevBg;
        el.style.outline = '';
        el.style.outlineOffset = '';
      }, 1600);
      extHlDeadlineRef.current = 0;
      onExternalHighlightConsumed?.();
      return;
    }
    const rec = getHighlight(book.filePath, externalHighlightId);
    // 记录不存在或已失效：没有可定位的目标，直接消费掉一次性 prop
    if (!rec || rec.stale) { onExternalHighlightConsumed?.(); return; }
    // 章节尚未进入渲染窗口（流式加载/滑窗中）：等下一次重放再试，10s 超时兜底
    if (!extHlDeadlineRef.current) extHlDeadlineRef.current = Date.now() + 10000;
    else if (Date.now() > extHlDeadlineRef.current) {
      extHlDeadlineRef.current = 0;
      onExternalHighlightConsumed?.();
    }
  }, [externalHighlightId, highlights, combinedHtml, isPaginatedMode, isBookMode, pageWidth, pageCount, pagesPerStep, book.filePath, onExternalHighlightConsumed]);

  /** 当前选区 → 工具条载荷；没选出字或不在正文里给 null。mouseup 与右键菜单共用这一套计算 */
  const selectionToolbarPayload = useCallback((): SelToolbarState | null => {
    const sel = document.getSelection();
    const container = isPaginatedMode ? contentRef.current : verticalRef.current;
    const vp = viewportRef.current;
    if (!sel || !container || !vp) return null;
    if (sel.isCollapsed || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return null;
    const segments = buildSelectionSegments(container, range, book.chapters);
    if (segments.length === 0) return null;
    const vpRect = vp.getBoundingClientRect();
    const r = range.getBoundingClientRect();
    return {
      x: Math.max(60, Math.min(vpRect.width - 60, r.left + r.width / 2 - vpRect.left)),
      y: Math.max(48, r.top - vpRect.top),
      mode: 'selection',
      quote: sel.toString(),
      segments,
    };
  }, [isPaginatedMode, book.chapters]);

  // —— 选字 → 工具条（竖版与横版/双栏同一套；容器按模式取）——
  const handleSelectionMouseUp = useCallback(() => {
    // 延后一拍：mouseup 时 selection 可能尚未 finalize
    window.setTimeout(() => {
      const payload = selectionToolbarPayload();
      if (payload) {
        setNotePopover(null);
        setSelToolbar(payload);
        return;
      }
      const sel = document.getSelection();
      const vp = viewportRef.current;
      if (!sel || !vp) return;
      // 无选区：可能是点击了已有高亮 → 管理工具条（复制/批注/删除）
      const node = sel.anchorNode;
      const markEl = (node instanceof Element
        ? node.closest('mark[data-hl-id]')
        : node?.parentElement?.closest('mark[data-hl-id]')) as HTMLElement | null;
      if (markEl) {
        const id = markEl.getAttribute('data-hl-id') || '';
        const rec = highlightsRef.current.find((h) => h.id === id) || getHighlight(book.filePath, id);
        if (rec) {
          const vpRect = vp.getBoundingClientRect();
          const r = markEl.getBoundingClientRect();
          setNotePopover(null);
          setSelToolbar({
            x: Math.max(60, Math.min(vpRect.width - 60, r.left + r.width / 2 - vpRect.left)),
            y: Math.max(48, r.top - vpRect.top),
            mode: 'existing',
            quote: rec.quote,
            segments: [],
            existingId: rec.id,
          });
          return;
        }
      }
      setSelToolbar(null);
      setNotePopover(null);
    }, 0);
  }, [selectionToolbarPayload, book.filePath]);

  // —— 划词问 AI（走后端 ai_quick_ask：单轮、非流式、不落会话）——
  const askAiAboutSelection = useCallback(async (mode: 'explain' | 'translate' | 'summarize') => {
    if (!selToolbar || selToolbar.mode !== 'selection') return;
    const quote = selToolbar.quote.trim();
    if (!quote) return;
    const prompts: Record<typeof mode, string> = {
      explain: `请用简洁的中文解释下面这段文字的含义；涉及术语时顺带说明。\n\n${quote}`,
      translate: `请把下面这段文字翻译成另一种语言（中文↔英文互译）。只输出译文，不要解释。\n\n${quote}`,
      summarize: `请用两三句话概括下面这段文字的要点。\n\n${quote}`,
    };
    setAiPanel({ quote, text: '', loading: true });
    setAiMenuOpen(false);
    setSelToolbar(null);
    document.getSelection()?.removeAllRanges();
    try {
      const text = await hostApi.invoke<string>('ai_quick_ask', {
        prompt: prompts[mode],
        system: '你是阅读助手：回答简洁准确，不复述原文。',
      });
      setAiPanel({ quote, text: String(text ?? ''), loading: false });
    } catch (e) {
      setAiPanel({ quote, text: `⚠ ${String(e).slice(0, 160)}`, loading: false });
    }
  }, [selToolbar]);

  // —— 工具条动作 ——
  const refreshHighlights = useCallback(() => {
    setHighlights(listHighlights(book.filePath));
    setSelToolbar(null);
    setAiMenuOpen(false);
    setNotePopover(null);
    document.getSelection()?.removeAllRanges();
  }, [book.filePath]);

  const createFromSelection = useCallback((color: HighlightColor, note?: string) => {
    if (!selToolbar || selToolbar.mode !== 'selection') return;
    addHighlights(book.filePath, selToolbar.segments.map((s) => ({ ...s, color, note: note || '' })));
    emitHighlightsChanged(book.filePath);
    refreshHighlights();
  }, [selToolbar, book.filePath, refreshHighlights]);

  const saveNoteAction = useCallback(() => {
    if (!selToolbar) return;
    if (selToolbar.mode === 'existing' && selToolbar.existingId) {
      updateHighlight(book.filePath, selToolbar.existingId, { note: noteText });
    } else if (selToolbar.mode === 'selection') {
      // 「加批注」直接以黄色建档（工具条上再点其他颜色会另行创建纯色高亮）
      addHighlights(book.filePath, selToolbar.segments.map((s) => ({ ...s, color: 'yellow' as HighlightColor, note: noteText })));
    } else {
      return;
    }
    emitHighlightsChanged(book.filePath);
    refreshHighlights();
  }, [selToolbar, noteText, book.filePath, refreshHighlights]);

  const deleteExistingHighlight = useCallback(() => {
    if (!selToolbar?.existingId) return;
    deleteHighlight(book.filePath, selToolbar.existingId);
    emitHighlightsChanged(book.filePath);
    refreshHighlights();
  }, [selToolbar, book.filePath, refreshHighlights]);

  const copySelectionText = useCallback(() => {
    const text = selToolbar?.quote || '';
    const done = () => refreshHighlights();
    try {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done, () => {
          try {
            const ta = document.createElement('textarea');
            ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
            document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
          } catch { /* 忽略 */ }
          done();
        });
        return;
      }
    } catch { /* 走兜底 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    } catch { /* 忽略 */ }
    done();
  }, [selToolbar, refreshHighlights]);

  const openNotePopover = useCallback(() => {
    const initial = selToolbar?.mode === 'existing' && selToolbar.existingId
      ? (highlightsRef.current.find((h) => h.id === selToolbar.existingId)?.note || '')
      : '';
    setNoteText(initial);
    setNotePopover({ initial });
  }, [selToolbar]);

  // —— 右键菜单：选中正文 → 四色高亮 / 批注 / 复制原文 ——
  // 与选字工具条走同一条链：build 时用同一个函数把选区算成 selToolbar，
  // 条目执行时调的就是点工具条那三个动作 —— 不另开一套落盘逻辑，两边才不会哪天不同步。
  const menuActionsRef = useRef<{
    create: (color: HighlightColor) => void;
    note: () => void;
    copy: () => void;
  }>({ create: () => {}, note: () => {}, copy: () => {} });
  useEffect(() => {
    menuActionsRef.current = { create: createFromSelection, note: openNotePopover, copy: copySelectionText };
  }, [createFromSelection, openNotePopover, copySelectionText]);

  useEffect(() => {
    const register = hostApi?.registerContextMenuProvider;
    if (typeof register !== 'function') return;
    return register({
      id: 'selection',
      build: (info) => {
        if (!String(info?.selectionText || '').trim()) return [];
        const payload = selectionToolbarPayload();
        // 选区不在正文里（比如右键的是侧栏列表）就别贡献条目，免得给出去高不了
        if (!payload) return [];
        setSelToolbar(payload);
        const items: ContextMenuItem[] = HIGHLIGHT_COLORS.map((c) => ({
          label: T(`reading.hl.color${c.charAt(0).toUpperCase()}${c.slice(1)}`),
          run: () => menuActionsRef.current.create(c),
        }));
        items.push({ label: T('reading.hl.note'), separatorBefore: true, run: () => menuActionsRef.current.note() });
        items.push({ label: T('reading.hl.copy'), run: () => menuActionsRef.current.copy() });
        return items;
      },
    });
  }, [selectionToolbarPayload]);

  // ============ 测量页数和章节边界 ============
  // 章节标记已强制 break-before: column（首章除外），故"xx章"标题恒在栏顶，
  // 标记 offsetLeft 所在栏即为该章第一页，无需再做 titleAtTop 二次修正。
  const measure = useCallback(() => {
    const vp = viewportRef.current;
    const c = contentRef.current;
    if (!vp || !c) return;
    const vw = vp.clientWidth;
    const colCount = isBookMode ? 2 : 1;
    const colGap = isBookMode ? BOOK_GUTTER : GAP;
    const pw = Math.floor(Math.max(200, (vw - 2 * PAD - (colCount - 1) * colGap) / colCount));
    const pwChanged = pw !== lastPwRef.current;
    if (pwChanged) lastPwRef.current = pw;
    setPageWidth(pw);

    const step = (pw + colGap) * pagesPerStep;
    const scrollW = Math.max(0, c.scrollWidth - 2 * PAD);
    const TOLERANCE = Math.max(2, step * 0.05);
    let pages = Math.max(1, Math.ceil((scrollW - TOLERANCE) / step));

    // ===== 章节边界检测：标记已顶格，offsetLeft 所在栏即章首页 =====
    const markers = c.querySelectorAll('.chapter-marker');
    const rawStartPages: number[] = [];
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i] as HTMLElement;
      const startOffset = m.offsetLeft - PAD;
      const rawPage = Math.max(0, Math.floor((startOffset + TOLERANCE) / step));
      rawStartPages.push(rawPage);
    }

    const boundaries: ChapterBoundary[] = [];
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i] as HTMLElement;
      const idx = parseInt(m.getAttribute('data-chapter-index') || '0', 10);
      const startPage = rawStartPages[i];
      const endPage = i < markers.length - 1
        ? Math.max(startPage, rawStartPages[i + 1] - 1)
        : pages - 1;
      boundaries.push({ index: idx, startPage, endPage });
    }
    // 末尾空白页裁剪：scrollWidth 可能因 sub-pixel/列尾余量略大，
    // 用末章内容右边缘反推真实末页，裁掉其后纯白页
    const lastMarker = markers[markers.length - 1] as HTMLElement | null;
    if (lastMarker) {
      const lastContentRight = lastMarker.offsetLeft + lastMarker.offsetWidth;
      const lastContentPage = Math.max(0, Math.floor((lastContentRight - PAD + TOLERANCE) / step));
      if (pages - 1 > lastContentPage) {
        pages = lastContentPage + 1;
      }
    }
    setPageCount(pages);
    boundariesRef.current = boundaries;

    // 处理待跳转（窗口滑动 / 模式切换 / 恢复进度后定位）
    // 关键：只有「目标章边界确实就绪」才清空并应用；否则保留 pendingJumpRef，
    // 跳过下方钳制，等下一次 measure()（章节流式到达 / 窗口滑动后）再消费。
    // 否则在章节还在流式加载、目标章尚未进入渲染窗口时就提前清空 pendingJump，
    // 跳转会被永久丢弃（表现为「恢复进度永远停在第1章 / 进度归零」）。
    if (pendingJumpRef.current !== null) {
      const { chapterIndex: targetIdx, pageInChapter, useProgress } = pendingJumpRef.current;
      const b = boundaries.find(x => x.index === targetIdx);
      if (b) {
        pendingJumpRef.current = null;
        let page: number;
        if (pageInChapter === -1) {
          page = b.endPage;
        } else if (useProgress && verticalScrollProgressRef.current > 0) {
          // 竖版→分页：用竖版章节内进度近似映射到新布局的章节内页码
          const chapPages = Math.max(1, b.endPage - b.startPage + 1);
          page = Math.min(b.endPage, b.startPage + Math.round((verticalScrollProgressRef.current / 100) * (chapPages - 1)));
        } else {
          page = Math.min(b.startPage + pageInChapter, b.endPage);
        }
        setAbsolutePage(page);
        setChapterIndex(targetIdx);
        lockTransition();
        return;
      }
      // 目标章边界尚未就绪：保留 pendingJumpRef，本次不做钳制（避免错钳到旧章节），
      // 待章节到达 / 窗口滑入目标章后由后续 measure() 完成跳转。
      return;
    }

    // 没有待跳转时：复测可能让总页数收缩（字体/图片加载完重排）。
    // 把阅读位置钳制在「当前章节」范围内，避免落到其他章或全局末页导致跳动。
    setAbsolutePage((p) => {
      const cur = boundaries.find(b => b.index === chapterIndexRef.current);
      if (cur) return Math.min(Math.max(p, cur.startPage), cur.endPage);
      return Math.min(p, pages - 1);
    });

    // 页面宽度变化（布局切换 / 窗口尺寸变化）时临时关闭 transform 过渡，
    // 避免 contentRef 因 pageWidth 改变重算 translate 而产生滑动动画（视觉"闪"）
    if (pwChanged) {
      lockTransition();
    }
  }, [isBookMode, pagesPerStep, lockTransition]);

  // ============ 同步测量：在 useLayoutEffect 中直接调用（消除弹簧动画）============
  // useLayoutEffect 在 DOM 变更后、浏览器绘制前同步执行
  // 在此设置状态，用户永远看不到中间帧 → 无弹簧动画
  // combinedHtml 变化（3章窗口滑动）时自动触发重新测量
  useLayoutEffect(() => {
    if (!isPaginatedMode) return;
    measure();
  }, [combinedHtml, isPaginatedMode, measure, forceMeasureToken]);

  // 异步布局稳定后重新测量：网页字体（阅读字体）与章节内图片是异步加载的，
  // 首测横/双栏时它们可能尚未就绪，内容用回退字体/无图排版导致 scrollWidth 偏大 → 页码偏多。
  // 加载完成的重排不会改变视口尺寸，ResizeObserver 不会触发，故需在此显式复测，
  // 否则要等到用户切模式才纠正（表现为「切一下模式就正常」）。
  useEffect(() => {
    if (!isPaginatedMode) return;
    const c = contentRef.current;
    if (!c) return;
    let cancelled = false;
    const remeasure = () => { if (!cancelled) measure(); };
    const cleanups: Array<() => void> = [];

    // 1) 字体全部就绪后复测
    const fontsApi = (document as any).fonts;
    if (fontsApi && typeof fontsApi.ready?.then === 'function') {
      fontsApi.ready.then(remeasure);
    }
    // 2) 内容图片加载完后复测（视口尺寸不变，ResizeObserver 不触发）
    const imgs = Array.from(c.querySelectorAll('img')) as HTMLImageElement[];
    imgs.forEach((img) => {
      if (!img.complete) {
        const onLoad = () => remeasure();
        img.addEventListener('load', onLoad);
        img.addEventListener('error', onLoad);
        cleanups.push(() => {
          img.removeEventListener('load', onLoad);
          img.removeEventListener('error', onLoad);
        });
      }
    });
    // 3) 双 rAF 兜底：捕捉首帧绘制后才稳定的重排
    const raf1 = requestAnimationFrame(() => {
      const raf2 = requestAnimationFrame(remeasure);
      cleanups.push(() => cancelAnimationFrame(raf2));
    });
    cleanups.push(() => cancelAnimationFrame(raf1));

    return () => {
      cancelled = true;
      cleanups.forEach((fn) => fn());
    };
  }, [combinedHtml, isPaginatedMode, measure]);

  // 布局模式切换 — 用 useLayoutEffect 在绘制前同步状态，避免切换闪烁
  useLayoutEffect(() => {
    // 锁定过渡（覆盖可能跨多次提交的场景：如竖版→分页需先滑窗口再 measure）
    lockTransition();
    const wasPaginated = prevPaginatedRef.current;
    if (isPaginatedMode) {
      // 切到分页模式：pageWidth / 栏数变化导致同一 absolutePage 对应不同章节，
      // 必须按当前阅读章节重新定位，否则章节会跳到错误位置
      const targetChapter = wasPaginated ? chapterIndexRef.current : displayedChapterRef.current;
      // 分页↔分页：保留章节内相对位置（按当前页推算 pageInChapter）
      // 竖版→分页：用竖版进度估算（useProgress）
      let pageInChapter = 0;
      let useProgress = false;
      if (wasPaginated) {
        const cur = boundariesRef.current.find(b => b.index === chapterIndexRef.current);
        if (cur) {
          pageInChapter = Math.min(
            Math.max(0, absolutePageRef.current - cur.startPage),
            cur.endPage - cur.startPage,
          );
        }
      } else {
        useProgress = true;
      }
      pendingJumpRef.current = { chapterIndex: targetChapter, pageInChapter, useProgress };
      // 窗口已由点击处理器预滑到目标章（竖版→分页），或本就不变（分页↔分页），
      // 此处直接 measure 即可用正确窗口的 boundaries 准确定位
      measure();
    } else {
      // 切换到竖版时同步 windowCenter 和 displayedChapter 到当前 chapterIndex，
      // 避免用户在横板读到第N章切竖版后内容跳回第1章导致闪烁
      setWindowCenter(chapterIndexRef.current);
      setDisplayedChapter(chapterIndexRef.current);
    }
    prevPaginatedRef.current = isPaginatedMode;
  }, [layoutMode, measure, isPaginatedMode, lockTransition]);

  // 字号/行距变化 → 重新分页测量。
  // measure() 按实际 DOM 的 scrollWidth 算页数与章节边界；字号不改就会沿用旧页数，
  // 表现为「字变大了一页装不下，但翻页仍按旧页数走」。
  useEffect(() => {
    const id = requestAnimationFrame(() => measure());
    return () => cancelAnimationFrame(id);
  }, [readerSettings.fontSize, readerSettings.lineHeight, measure]);

  // —— 书签：记录 / 取消当前位置，或跳回某个书签 ——
  const toggleCurrentBookmark = useCallback(() => {
    const ch = chapterIndexRef.current;
    const b = boundariesRef.current.find((x) => x.index === ch);
    const pageInChapter = Math.max(0, absolutePageRef.current - (b?.startPage ?? 0));
    const useProgress = !isPaginatedMode;
    const existing = findBookmarkAt(book.filePath, ch, pageInChapter, useProgress);
    if (existing) {
      setBookmarks(removeBookmark(book.filePath, existing.id));
      return;
    }
    const title = book.chapters[ch]?.title || `第 ${ch + 1} 章`;
    setBookmarks(addBookmark(book.filePath, {
      chapterIndex: ch,
      pageInChapter,
      useProgress,
      label: useProgress ? title : `${title} · 第 ${pageInChapter + 1} 页`,
    }));
  }, [book.filePath, book.chapters, isPaginatedMode]);

  const jumpToBookmark = useCallback((bm: ReadingBookmark) => {
    // 复用外部跳转同一条通道：设 pendingJump → 把窗口滑到目标章 → 下一帧 measure 消费
    pendingJumpRef.current = { chapterIndex: bm.chapterIndex, pageInChapter: bm.pageInChapter, useProgress: bm.useProgress };
    setWindowCenter(bm.chapterIndex);
    setDisplayedChapter(bm.chapterIndex);
    requestAnimationFrame(() => measure());
    setBookmarksOpen(false);
  }, [measure]);

  // 尺寸变化
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { if (isPaginatedMode) measure(); });
    ro.observe(vp);
    return () => ro.disconnect();
  }, [measure, isPaginatedMode]);

  // ============ 从 absolutePage 推导 chapterIndex ============
  useEffect(() => {
    if (!isPaginatedMode) return;
    const boundaries = boundariesRef.current;
    if (boundaries.length === 0) return;
    const current = boundaries.find(b => absolutePage >= b.startPage && absolutePage <= b.endPage);
    if (current && current.index !== chapterIndex) {
      setChapterIndex(current.index);
    }
  }, [absolutePage, isPaginatedMode, chapterIndex]);

  // 跳过上报标记：仅在「书籍切换重置」时置位（详见下方重置 effect）。
  // 这是修复「恢复进度永远停在第 1 章」的关键：挂载重置会把内部 chapterIndex 设为 0，
  // 若把 0 上报给父组件 setSelectedChapterIndex，会覆盖掉 restore 设回的章节，
  // 形成「restore 设 3 → 重置上报 0 → 覆盖回 0 → jump-effect 永远看到 extCh:0」的振荡归零。
  // 外部跳转（jump-effect）上报的值与父组件 restore 设的值相同，无害，无需抑制。
  const skipReportRef = useRef(false);
  // 通知父组件章节变化（仅用户真实翻章时上报，供持久化）
  const reportedChapter = isPaginatedMode ? chapterIndex : displayedChapter;
  useEffect(() => {
    if (skipReportRef.current) {
      skipReportRef.current = false;
      return;
    }
    onChapterChange?.(reportedChapter);
  }, [reportedChapter, onChapterChange]);

  // ============ 外部章节索引（侧边栏点击）============
  // 关键：依赖数组只含 externalChapterIndex，不含 chapterIndex/verticalChapter
  // 否则内部 chapterIndex 变化时会重新触发此 effect，导致"跳到新章 → 弹回旧章 → 再跳新章"的弹簧动画
  useEffect(() => {
    if (externalChapterIndex === undefined) return;
    // [DIAG] 阅读跳转诊断
    console.log('[reading-diag] jump-effect', { mode: isPaginatedMode ? 'page' : 'v', extCh: externalChapterIndex, scrollPct: externalScrollPercent, pageInCh: externalPageInChapter, winCenter: windowCenterRef.current });
    if (isPaginatedMode) {
      // 用 ref 读取最新 chapterIndex，避免将其放入依赖数组
      // 恢复期间（携带 pageInChapter）即使章节等于当前章节也强制应用，确保章内页码被恢复
      if (externalChapterIndex !== chapterIndexRef.current || externalPageInChapter != null) {
        const b = boundariesRef.current?.find((x) => x.index === externalChapterIndex);
        const ws = Math.max(0, windowCenterRef.current - WINDOW_RADIUS);
        const we = Math.min(book.chapters.length, ws + WINDOW_SIZE);
        const inWindow = externalChapterIndex >= ws && externalChapterIndex < we;
        if (inWindow && b) {
          // 目标章已在渲染窗口内且边界已知 → 直接跳（恢复时携带章内页码）
          setAbsolutePage(Math.min(b.startPage + (externalPageInChapter ?? 0), b.endPage));
          setChapterIndex(externalChapterIndex);
          lockTransition();
        } else {
          // 否则登记待跳转并滑动窗口到目标章：章节进入渲染窗口后 measure() 会消费
          // pendingJumpRef 完成跳转。即使此刻边界尚未算出（章节流式到达前），measure
          // 完成后也会补跳；forceMeasureToken 兜底，确保窗口未变化时也能重测消费。
          // 这是修复「进度归零」的核心：原实现在边界查不到时直接放弃且无重试。
          pendingJumpRef.current = { chapterIndex: externalChapterIndex, pageInChapter: externalPageInChapter ?? 0 };
          setWindowCenter(externalChapterIndex);
          setForceMeasureToken((t) => t + 1);
          lockTransition();
        }
      }
    } else {
      // 竖版：滑动窗口到目标章节，跳到该章顶部
      // 恢复期间（携带 scrollPercent）即使章节恰好等于当前章节也强制跳转，确保章内滚动位置被应用
      if (externalChapterIndex !== displayedChapterRef.current || externalScrollPercent != null) {
        verticalJumpRef.current = { chapterIndex: externalChapterIndex, position: 'top', scrollPercent: externalScrollPercent ?? undefined };
        setWindowCenter(externalChapterIndex);
        setDisplayedChapter(externalChapterIndex);
        // 触发竖版跳转消费：即使目标章已落在同一渲染窗口内、combinedHtml 未变化，
        // 也能让消费 verticalJumpRef 的 layout effect 执行并滚动到目标章顶部
        setVJumpToken((t) => t + 1);
      }
    }
  }, [externalChapterIndex, isPaginatedMode, book.chapters.length, lockTransition]);

  // 分页/双栏模式：随页面变化上报「章内页码偏移」，供父组件持久化（恢复时回放）
  useEffect(() => {
    if (!isPaginatedMode || !onPageProgress) return;
    const b = boundariesRef.current.find(x => x.index === chapterIndex);
    if (b) {
      const chapterPages = Math.max(1, b.endPage - b.startPage);
      const pageInChapter = Math.min(chapterPages - 1, Math.max(0, absolutePage - b.startPage));
      onPageProgress(pageInChapter);
    }
  }, [absolutePage, chapterIndex, isPaginatedMode, onPageProgress]);

  // 书籍切换重置
  useEffect(() => {
    setAbsolutePage(0);
    setChapterIndex(0);
    setVerticalScrollProgress(0);
    setWindowCenter(0);
    setDisplayedChapter(0);
    // 标记本次重置引发的章节变化无需上报，避免把 0 回写父组件覆盖 restore 的章节
    skipReportRef.current = true;
    pendingJumpRef.current = null;
    verticalJumpRef.current = null;
    if (verticalRef.current) verticalRef.current.scrollTop = 0;
  }, [book.filePath]);

  // ============ 翻页 ============
  const colGapForStep = isBookMode ? BOOK_GUTTER : GAP;
  const step = (pageWidth + colGapForStep) * pagesPerStep;

  const nextPage = useCallback(() => {
    if (absolutePage < pageCount - 1) {
      setAbsolutePage(absolutePage + 1);
    } else if (chapterIndex < book.chapters.length - 1) {
      // 已到窗口最后一页 → 滑动窗口到下一章
      pendingJumpRef.current = { chapterIndex: chapterIndex + 1, pageInChapter: 0 };
      setWindowCenter(chapterIndex + 1);
      lockTransition();
    }
  }, [absolutePage, pageCount, chapterIndex, book.chapters.length, lockTransition]);

  const prevPage = useCallback(() => {
    if (absolutePage > 0) {
      setAbsolutePage(absolutePage - 1);
    } else if (windowStart > 0) {
      // 已到窗口第一页 → 滑动窗口到上一章，跳到该章最后一页
      pendingJumpRef.current = { chapterIndex: windowStart - 1, pageInChapter: -1 };
      setWindowCenter(windowStart - 1);
      lockTransition();
    }
  }, [absolutePage, windowStart, lockTransition]);

  const goPrevChapter = useCallback(() => {
    if (!isPaginatedMode) {
      // 竖版：上一章（基于实际阅读章节 displayedChapter，而非窗口中心）
      const prevIdx = displayedChapter - 1;
      if (prevIdx < 0) return;
      if (prevIdx >= windowStart) {
        // 上一章在当前窗口内 → 平滑滚动到该章顶部
        const marker = verticalRef.current?.querySelector(`[data-chapter-index="${prevIdx}"]`) as HTMLElement | null;
        if (marker && verticalRef.current) {
          verticalRef.current.scrollTo({ top: marker.offsetTop, behavior: 'smooth' });
          return;
        }
      }
      // 不在窗口内 → 滑动窗口
      verticalJumpRef.current = { chapterIndex: prevIdx, position: 'top' };
      setWindowCenter(prevIdx);
      setDisplayedChapter(prevIdx);
      return;
    }
    const prevIdx = chapterIndex - 1;
    if (prevIdx < 0) return;
    if (prevIdx >= windowStart) {
      // 上一章在窗口内 → 直接跳到该章最后一页
      const b = boundariesRef.current.find(x => x.index === prevIdx);
      if (b) {
        setAbsolutePage(b.endPage);
        lockTransition();
        return;
      }
    }
    // 上一章不在窗口内 → 滑动窗口，跳到该章最后一页
    pendingJumpRef.current = { chapterIndex: prevIdx, pageInChapter: -1 };
    setWindowCenter(prevIdx);
    lockTransition();
  }, [isPaginatedMode, chapterIndex, displayedChapter, windowStart, lockTransition]);

  const goNextChapter = useCallback(() => {
    if (!isPaginatedMode) {
      // 竖版：下一章（基于实际阅读章节 displayedChapter，而非窗口中心）
      const nextIdx = displayedChapter + 1;
      if (nextIdx >= book.chapters.length) return;
      if (nextIdx < windowEnd) {
        // 下一章在当前窗口内 → 平滑滚动到该章顶部
        const marker = verticalRef.current?.querySelector(`[data-chapter-index="${nextIdx}"]`) as HTMLElement | null;
        if (marker && verticalRef.current) {
          verticalRef.current.scrollTo({ top: marker.offsetTop, behavior: 'smooth' });
          return;
        }
      }
      // 不在窗口内 → 滑动窗口
      verticalJumpRef.current = { chapterIndex: nextIdx, position: 'top' };
      setWindowCenter(nextIdx);
      setDisplayedChapter(nextIdx);
      return;
    }
    const nextIdx = chapterIndex + 1;
    if (nextIdx >= book.chapters.length) return;
    if (nextIdx < windowEnd) {
      // 下一章在窗口内 → 直接跳到该章首页
      const b = boundariesRef.current.find(x => x.index === nextIdx);
      if (b) {
        setAbsolutePage(b.startPage);
        lockTransition();
        return;
      }
    }
    // 下一章不在窗口内 → 滑动窗口
    pendingJumpRef.current = { chapterIndex: nextIdx, pageInChapter: 0 };
    setWindowCenter(nextIdx);
    lockTransition();
  }, [isPaginatedMode, chapterIndex, displayedChapter, book.chapters.length, windowEnd, lockTransition]);

  // ============ 键盘 ============
  useEffect(() => {
    if (!isPaginatedMode) return;
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
        case ' ': e.preventDefault(); nextPage(); break;
        case 'ArrowLeft':
        case 'PageUp': e.preventDefault(); prevPage(); break;
        case 'Home': e.preventDefault(); setAbsolutePage(0); break;
        case 'End': e.preventDefault(); setAbsolutePage(pageCount - 1); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nextPage, prevPage, pageCount, isPaginatedMode]);

  // ============ 滚轮 ============
  const onWheel = (e: React.WheelEvent) => {
    if (!isPaginatedMode) return;
    const now = Date.now();
    if (now < wheelLock.current) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(d) < 8) return;
    wheelLock.current = now + WHEEL_COOLDOWN;
    if (d > 0) nextPage();
    else prevPage();
  };

  // ============ 竖版：combinedHtml 变化（窗口滑动）后调整 scrollTop 保持视觉连续性 ============
  // useLayoutEffect 在 DOM 变更后、浏览器绘制前同步执行
  // 窗口滑动时内容会变化（前一章移除/后一章添加），通过 verticalJumpRef 调整 scrollTop
  // 让用户看到的位置保持不变（在目标章节的顶部或底部）
  useLayoutEffect(() => {
    if (isPaginatedMode) return;
    if (!verticalRef.current) return;

    if (verticalJumpRef.current) {
      const { chapterIndex, position, scrollPercent } = verticalJumpRef.current;
      verticalJumpRef.current = null;
      // 找到目标章节的 chapter-marker，调整 scrollTop 保持视觉位置
      const marker = verticalRef.current.querySelector(`[data-chapter-index="${chapterIndex}"]`) as HTMLElement | null;
      if (marker) {
        const el = verticalRef.current;
        if (position === 'top') {
          // 恢复时携带章内滚动百分比，则滚动到该章内对应位置；否则回到章首
          if (scrollPercent != null && marker.offsetHeight > el.clientHeight) {
            el.scrollTop = marker.offsetTop + (scrollPercent / 100) * (marker.offsetHeight - el.clientHeight);
          } else {
            el.scrollTop = marker.offsetTop;
          }
        } else {
          el.scrollTop = marker.offsetTop + marker.offsetHeight - el.clientHeight;
        }
        // 同步 displayedChapter（窗口滑动后立即更新，不等 scroll 事件）
        setDisplayedChapter(chapterIndex);
      }
    }
  }, [combinedHtml, vJumpToken, isPaginatedMode]);

  // ============ 竖版滚动 ============
  // 通过 chapter-marker 的 offsetTop 检测当前阅读章节，计算章节内进度（非整个窗口的进度）
  const onVerticalScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // 滚动即收起选字工具条：它的坐标锚在选区上，滚动后会漂移
    setSelToolbar(null);
    const markers = el.querySelectorAll('[data-chapter-index]');
    if (markers.length === 0) return;

    // 检测当前章节：找到最后一个 offsetTop <= 阅读中线（scrollTop + clientHeight/2）的标记
    const centerLine = el.scrollTop + el.clientHeight / 2;
    let currentIdx = parseInt(markers[0].getAttribute('data-chapter-index') || '0', 10);
    let currentMarker = markers[0] as HTMLElement;
    let nextMarkerTop: number | null = null;
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i] as HTMLElement;
      if (m.offsetTop <= centerLine) {
        currentIdx = parseInt(m.getAttribute('data-chapter-index') || '0', 10);
        currentMarker = m;
        nextMarkerTop = (i < markers.length - 1)
          ? (markers[i + 1] as HTMLElement).offsetTop
          : null;
      } else {
        break;
      }
    }

    // 计算章节内进度（0-100）：基于当前章在视口中的可滚动范围
    const chapterStart = currentMarker.offsetTop;
    const chapterEnd = nextMarkerTop ?? el.scrollHeight;
    const chapterScrollable = chapterEnd - chapterStart - el.clientHeight;
    const progress = chapterScrollable > 0
      ? Math.round(Math.max(0, Math.min(100, ((el.scrollTop - chapterStart) / chapterScrollable) * 100)))
      : 100;

    setDisplayedChapter(currentIdx);
    setVerticalScrollProgress(progress);
    onScrollProgress?.(progress);

    // 滑动窗口（仅在顶/底边界时触发，不干扰中间阅读）
    const scrollable = el.scrollHeight - el.clientHeight;
    if (scrollable <= 0) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    if (atBottom && windowEnd < book.chapters.length) {
      const now = Date.now();
      if (now < wheelLock.current) return;
      wheelLock.current = now + 600;
      verticalJumpRef.current = { chapterIndex: windowEnd - 1, position: 'bottom' };
      setWindowCenter(windowCenter + 1);
      return;
    }
    const atTop = el.scrollTop <= 0;
    if (atTop && windowStart > 0) {
      const now = Date.now();
      if (now < wheelLock.current) return;
      wheelLock.current = now + 600;
      verticalJumpRef.current = { chapterIndex: windowStart, position: 'top' };
      setWindowCenter(windowCenter - 1);
    }
  }, [windowStart, windowEnd, windowCenter, book.chapters.length]);

  // ============ 拖拽（只留给触摸）============
  // 桌面端**不再有拖动翻页**：按下就 setPointerCapture 会把指针从浏览器的选字流程里整个抢走，
  // 于是「拖动选字」必然变成「拖动翻页」。翻页改由滚轮（横版/双栏）与键盘负责，三个模式行为一致。
  // 触摸端仍要能划：Android 上没有滚轮，而 touchAction:none 又关掉了原生滚动，
  // 所以这里按 pointerType 只放行触摸手势。
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !isPaginatedMode || e.pointerType === 'mouse') return;
    dragState.current = { startX: e.clientX, active: true, offset: 0 };
    setDragging(true);
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragState.current.active) return;
    dragState.current.offset = e.clientX - dragState.current.startX;
    setDragOffset(dragState.current.offset);
  };
  const finishDrag = (e: React.PointerEvent) => {
    if (!dragState.current.active) return;
    const offset = dragState.current.offset;
    dragState.current.active = false;
    setDragging(false);
    setDragOffset(0);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
    if (offset <= -DRAG_THRESHOLD) nextPage();
    else if (offset >= DRAG_THRESHOLD) prevPage();
  };

  // ============ 渲染 ============
  // 整数化 translate 避免子像素渲染导致相邻页内容露出几px
  const translate = Math.round(-absolutePage * step + dragOffset);
  // 热区可用性：窗口内有更多页，或窗口外有更多章节
  const canPrev = absolutePage > 0 || windowStart > 0;
  const canNext = absolutePage < pageCount - 1 || chapterIndex < book.chapters.length - 1;
  // 章节内页码（用于底部栏显示：当前页/本章总页数）
  // 优先用 absolutePage 从 boundariesRef 直接查找当前章节边界，
  // 兜底 chapterIndex state（大跨度跳章节时 state 可能未及时更新，导致页码 1/1 或负数）
  const currentBoundary = boundariesRef.current.find(b => absolutePage >= b.startPage && absolutePage <= b.endPage)
    || boundariesRef.current.find(b => b.index === chapterIndex)
    || null;
  const renderChapterIndex = currentBoundary ? currentBoundary.index : chapterIndex;
  const chapterPageCount = currentBoundary ? currentBoundary.endPage - currentBoundary.startPage + 1 : 1;
  const pageInChapterDisplay = currentBoundary ? absolutePage - currentBoundary.startPage + 1 : 1;
  // 当前位置是否已有书签（顶部星标据此点亮）
  const bookmarkPage = Math.max(0, absolutePage - (currentBoundary?.startPage ?? 0));
  const atBookmark = !!findBookmarkAt(book.filePath, chapterIndex, bookmarkPage, !isPaginatedMode);

  if (book.chapters.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-[#f5f5f0] dark:bg-[#1c1917]">
        <div className="text-center text-neutral-400 dark:text-stone-500">
          <div className="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin mx-auto mb-2" />
          <p className="text-sm">{T('reading.loadingChapters')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col relative bg-[#f5f5f0] dark:bg-[#1c1917] immersive-safe-top">
      {/* 顶部栏 */}
      <div className="shrink-0 px-6 py-3 border-b border-neutral-200/60 dark:border-stone-700/50 flex items-center gap-3">
        <button onClick={onBack}
          className="btn-press w-9 h-9 flex items-center justify-center rounded-xl text-neutral-400 dark:text-stone-500 hover:text-[var(--element-color-raw)] hover:bg-[var(--element-muted)] transition-colors flex-shrink-0"
          title={T('reading.backToList')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold truncate text-neutral-800 dark:text-stone-100">{book.title}</h1>
          <p className="text-xs text-neutral-400 dark:text-stone-500 truncate">
            {currentChapter?.title || '—'}
            {book.author ? ` · ${book.author}` : ''}
            {book.chapters.length > 0 ? T('reading.chapterCountSuffix', { n: book.chapters.length }) : ''}
          </p>
        </div>
        {/* 布局切换 */}
        <div className="flex items-center gap-0.5 rounded-lg bg-black/5 dark:bg-white/10 p-0.5 flex-shrink-0">
          <button onClick={() => handleSetLayoutMode('horizontal')} className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${layoutMode === 'horizontal' ? 'bg-white dark:bg-stone-700 text-neutral-800 dark:text-stone-100 shadow-sm' : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300'}`} title={T('reading.layoutHorizontal')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/></svg>
          </button>
          <button onClick={() => handleSetLayoutMode('vertical')} className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${layoutMode === 'vertical' ? 'bg-white dark:bg-stone-700 text-neutral-800 dark:text-stone-100 shadow-sm' : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300'}`} title={T('reading.layoutVertical')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 2v20"/><path d="M16 2v20"/><line x1="2" y1="6" x2="22" y2="6"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="18" x2="22" y2="18"/></svg>
          </button>
          <button onClick={() => handleSetLayoutMode('book')} className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${layoutMode === 'book' ? 'bg-white dark:bg-stone-700 text-neutral-800 dark:text-stone-100 shadow-sm' : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300'}`} title={T('reading.layoutBook')}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          </button>
        </div>
        {/* 排版设置：字号 / 行距。此前字号写死在组件内联样式里，读者无法调节 */}
        <button
          onClick={() => setShowTypoPanel((v) => !v)}
          className={`btn-press w-8 h-8 flex items-center justify-center rounded-lg text-xs font-semibold transition-colors flex-shrink-0 ${showTypoPanel ? 'bg-white dark:bg-stone-700 text-neutral-800 dark:text-stone-100 shadow-sm' : 'bg-black/5 dark:bg-white/10 text-neutral-500 dark:text-stone-400 hover:text-neutral-700 dark:hover:text-stone-200'}`}
          title="字号与行距"
        >
          Aa
        </button>
        {/* 书签：星标记录/取消当前位置；旁边的按钮展开已存书签列表 */}
        <button
          onClick={toggleCurrentBookmark}
          className={`btn-press w-8 h-8 flex items-center justify-center rounded-lg transition-colors flex-shrink-0 ${
            atBookmark
              ? 'text-amber-500 bg-amber-50 dark:bg-amber-900/30'
              : 'bg-black/5 dark:bg-white/10 text-neutral-500 dark:text-stone-400 hover:text-amber-500'
          }`}
          title={atBookmark ? '取消当前页书签' : '收藏当前页'}
          aria-pressed={atBookmark}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill={atBookmark ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7-6.2-3.7-6.2 3.7 1.6-7L2 9.2l7.1-.6z" />
          </svg>
        </button>
        <button
          onClick={() => setBookmarksOpen((v) => !v)}
          className={`btn-press h-8 px-2 flex items-center gap-1 rounded-lg text-[11px] transition-colors flex-shrink-0 ${
            bookmarksOpen
              ? 'bg-white dark:bg-stone-700 text-neutral-800 dark:text-stone-100 shadow-sm'
              : 'bg-black/5 dark:bg-white/10 text-neutral-500 dark:text-stone-400 hover:text-neutral-700 dark:hover:text-stone-200'
          }`}
          title="书签列表"
        >
          {bookmarks.length}
        </button>
      </div>

      {/* 书签列表弹层：跳转 / 删除 */}
      {bookmarksOpen && (
        <div className="absolute right-6 top-16 z-40 w-72 max-h-[50vh] overflow-y-auto rounded-2xl bg-white dark:bg-stone-800 shadow-xl border border-black/10 dark:border-white/10 p-2">
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-xs font-semibold text-neutral-700 dark:text-stone-200">书签</span>
            <button
              onClick={() => setBookmarksOpen(false)}
              className="text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-300"
            >
              关闭
            </button>
          </div>
          {bookmarks.length === 0 ? (
            <p className="px-1 py-2 text-[11px] text-neutral-400 dark:text-stone-500">还没有书签：点顶部星标记录当前页。</p>
          ) : bookmarks.map((bm) => (
            <div key={bm.id} className="flex items-center gap-1 rounded-lg px-1 py-1 hover:bg-black/5 dark:hover:bg-white/10">
              <button
                onClick={() => jumpToBookmark(bm)}
                className="min-w-0 flex-1 truncate text-left text-xs text-neutral-600 dark:text-stone-300"
                title={bm.label}
              >
                {bm.label}
              </button>
              <button
                onClick={() => setBookmarks(removeBookmark(book.filePath, bm.id))}
                className="shrink-0 text-[11px] text-neutral-400 hover:text-rose-500"
                title="删除书签"
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 排版设置弹层：改字号/行距后重新分页（见 measure 相关 effect） */}
      {showTypoPanel && (
        <div className="absolute right-6 top-16 z-40 w-64 rounded-2xl bg-white dark:bg-stone-800 shadow-xl border border-black/10 dark:border-white/10 p-3 text-neutral-700 dark:text-stone-200">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold">排版</span>
            <button onClick={() => setShowTypoPanel(false)} className="text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-300">关闭</button>
          </div>
          <TypoRow
            label="字号"
            value={`${readerSettings.fontSize}px`}
            canDec={readerSettings.fontSize > READING_FONT_MIN}
            canInc={readerSettings.fontSize < READING_FONT_MAX}
            onDec={() => updateReaderSettings({ fontSize: readerSettings.fontSize - 1 })}
            onInc={() => updateReaderSettings({ fontSize: readerSettings.fontSize + 1 })}
          />
          <TypoRow
            label="行距"
            value={readerSettings.lineHeight.toFixed(2)}
            canDec={readerSettings.lineHeight > READING_LINE_MIN + 0.001}
            canInc={readerSettings.lineHeight < READING_LINE_MAX - 0.001}
            onDec={() => updateReaderSettings({ lineHeight: Number((readerSettings.lineHeight - 0.05).toFixed(2)) })}
            onInc={() => updateReaderSettings({ lineHeight: Number((readerSettings.lineHeight + 0.05).toFixed(2)) })}
          />
          <button
            onClick={() => updateReaderSettings(DEFAULT_READING_SETTINGS)}
            className="btn-press mt-2 w-full rounded-lg bg-black/5 dark:bg-white/10 py-1.5 text-xs hover:bg-black/10 dark:hover:bg-white/20 transition-colors"
          >
            恢复默认
          </button>
        </div>
      )}

      {/* 划词问 AI 的结果面板：固定右下角，可复制/关闭 */}
      {aiPanel && (
        <div className="absolute right-6 bottom-6 z-40 w-80 max-h-[45vh] overflow-y-auto rounded-2xl bg-white dark:bg-stone-800 shadow-xl border border-black/10 dark:border-white/10 p-3">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs font-semibold text-neutral-700 dark:text-stone-200">AI</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { try { void navigator.clipboard?.writeText(aiPanel.text); } catch { /* 忽略 */ } }}
                className="text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-300"
              >
                复制
              </button>
              <button
                onClick={() => setAiPanel(null)}
                className="text-[11px] text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-300"
              >
                关闭
              </button>
            </div>
          </div>
          <div className="mb-2 max-h-24 overflow-y-auto rounded-lg bg-black/5 dark:bg-white/10 px-2 py-1 text-[11px] whitespace-pre-wrap text-neutral-500 dark:text-stone-400">
            {aiPanel.quote}
          </div>
          <div className="text-xs leading-relaxed whitespace-pre-wrap text-neutral-700 dark:text-stone-200">
            {aiPanel.loading ? '思考中…' : aiPanel.text}
          </div>
        </div>
      )}

      {/* 阅读区 */}
      <div
        ref={viewportRef}
        className="flex-1 overflow-hidden relative"
        style={{ touchAction: isPaginatedMode ? 'none' : 'auto' }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
        onMouseUp={handleSelectionMouseUp}
      >
        {isPaginatedMode ? (
          <>
            {/* 翻页热区 */}
            {!dragging && (
              <>
                {canPrev && <button aria-label={T('reading.prevPage')} onClick={prevPage} className="absolute left-0 top-0 bottom-0 w-[10%] z-10 cursor-w-resize bg-transparent" />}
                {canNext && <button aria-label={T('reading.nextPage')} onClick={nextPage} className="absolute right-0 top-0 bottom-0 w-[10%] z-10 cursor-e-resize bg-transparent" />}
              </>
            )}
            {/* 双栏模式：所有章节拼接渲染 */}
            {isBookMode ? (
              <div className="h-full overflow-hidden relative">
                <div
                  ref={contentRef}
                  className="reader-columns-book h-full"
                  style={{
                    position: 'relative',
                    width: '100%',
                    columnWidth: `${pageWidth}px`,
                    columnGap: `${BOOK_GUTTER}px`,
                    columnFill: 'auto',
                    columnRule: '1px solid rgba(128,128,128,0.25)',
                    padding: `24px ${PAD}px`,
                    transform: `translateX(${translate}px)`,
                    transition: dragging || noTransition ? 'none' : 'transform 0.28s ease',
                    '--reader-font-size': `${readerSettings.fontSize}px`,
                    '--reader-line-height': String(readerSettings.lineHeight),
                  } as Record<string, string | number>}
                  dangerouslySetInnerHTML={{ __html: combinedHtml }}
                />
                {/* 书脊阴影 */}
                <div className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 w-16 z-20 flex justify-center">
                  <div className="w-8 h-full" style={{ background: 'linear-gradient(to right, transparent, rgba(0,0,0,0.04))' }} />
                  <div className="w-px h-full bg-neutral-400/20 dark:bg-stone-500/30" />
                  <div className="w-8 h-full" style={{ background: 'linear-gradient(to left, transparent, rgba(0,0,0,0.04))' }} />
                </div>
              </div>
            ) : (
              /* 横板：所有章节拼接渲染 */
              <div
                ref={contentRef}
                className="reader-columns h-full"
                style={{
                  position: 'relative',
                  columnWidth: `${pageWidth}px`,
                  columnGap: `${GAP}px`,
                  columnFill: 'auto',
                  padding: `24px ${PAD}px`,
                  transform: `translateX(${translate}px)`,
                  transition: dragging || noTransition ? 'none' : 'transform 0.28s ease',
                  '--reader-font-size': `${readerSettings.fontSize}px`,
                  '--reader-line-height': String(readerSettings.lineHeight),
                } as Record<string, string | number>}
                dangerouslySetInnerHTML={{ __html: combinedHtml }}
              />
            )}
            {!isBookMode && (
              <>
                <div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-[#f5f5f0] dark:from-[#1c1917] to-transparent" />
                <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[#f5f5f0] dark:from-[#1c1917] to-transparent" />
              </>
            )}
          </>
        ) : (
          /* 竖版：多章拼接滚动（与横板共用 combinedHtml，切换模式不闪烁）*/
          <div ref={verticalRef} className="h-full overflow-y-auto relative" onScroll={onVerticalScroll}>
            <div
              className="reader-vertical max-w-2xl mx-auto"
              style={{
                padding: `24px ${PAD}px`,
                '--reader-font-size': `${readerSettings.fontSize}px`,
                '--reader-line-height': String(readerSettings.lineHeight),
              } as Record<string, string | number>}
              dangerouslySetInnerHTML={{ __html: combinedHtml }}
            />
          </div>
        )}

        {/* 选字工具条（三个模式同一套）：着色 / 批注 / 复制 / 删除。挂在 viewport 层（不随正文滚动），
            stopPropagation 避免容器 mouseup 重新计算选区时把自己关掉 */}
        {selToolbar && (
          <div
            className="absolute z-30"
            style={{ left: `${selToolbar.x}px`, top: `${selToolbar.y}px`, transform: 'translate(-50%, -110%)' }}
            onMouseUp={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1 rounded-xl bg-white dark:bg-stone-800 shadow-lg border border-black/10 dark:border-white/10 px-2 py-1.5 whitespace-nowrap">
              {selToolbar.mode === 'selection' && HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c}
                  title={T(`reading.hl.color${c.charAt(0).toUpperCase()}${c.slice(1)}`)}
                  onClick={() => createFromSelection(c)}
                  className="w-5 h-5 rounded-full border border-black/15 dark:border-white/20 hover:scale-110 transition-transform"
                  style={{ backgroundColor: HIGHLIGHT_BG[c] }}
                />
              ))}
              {selToolbar.mode === 'selection' && <div className="w-px h-4 bg-black/10 dark:bg-white/10 mx-0.5" />}
              {/* AI：选中段落解释 / 翻译 / 概括。菜单小，避免直接误触发一次模型调用 */}
              {selToolbar.mode === 'selection' && (
                <div className="relative">
                  <button
                    onClick={() => setAiMenuOpen((v) => !v)}
                    title="问 AI"
                    className="w-6 h-6 flex items-center justify-center rounded-md text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/10 transition-colors text-[11px] font-semibold"
                  >
                    AI
                  </button>
                  {aiMenuOpen && (
                    <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 z-40 w-28 rounded-lg bg-white dark:bg-stone-800 shadow-lg border border-black/10 dark:border-white/10 py-1">
                      {([
                        ['explain', '解释'],
                        ['translate', '翻译'],
                        ['summarize', '概括'],
                      ] as const).map(([mode, label]) => (
                        <button
                          key={mode}
                          onClick={() => void askAiAboutSelection(mode)}
                          className="block w-full px-3 py-1.5 text-left text-xs text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/10"
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <button onClick={openNotePopover} title={T('reading.hl.note')}
                className="w-6 h-6 flex items-center justify-center rounded-md text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
              </button>
              <button onClick={copySelectionText} title={T('reading.hl.copy')}
                className="w-6 h-6 flex items-center justify-center rounded-md text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
              {selToolbar.mode === 'existing' && (
                <button onClick={deleteExistingHighlight} title={T('reading.hl.delete')}
                  className="w-6 h-6 flex items-center justify-center rounded-md text-neutral-500 dark:text-stone-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              )}
            </div>
            {notePopover && (
              <div className="absolute left-1/2 -translate-x-1/2 top-full mt-2 w-64 rounded-xl bg-white dark:bg-stone-800 shadow-lg border border-black/10 dark:border-white/10 p-2">
                <textarea
                  autoFocus
                  rows={3}
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder={T('reading.notes.notePlaceholder')}
                  className="w-full text-xs rounded-lg border border-black/10 dark:border-white/10 bg-transparent px-2 py-1.5 resize-none outline-none focus:border-[var(--element-bg)] text-neutral-700 dark:text-stone-200"
                />
                <div className="flex items-center justify-end gap-1.5 mt-1.5">
                  <button onClick={() => setNotePopover(null)}
                    className="px-2 py-1 rounded-md text-xs text-neutral-400 dark:text-stone-500 hover:bg-black/5 dark:hover:bg-white/10 transition-colors">
                    {T('reading.notes.cancel')}
                  </button>
                  <button onClick={saveNoteAction}
                    className="px-2.5 py-1 rounded-md text-xs bg-[var(--element-bg)] text-white hover:opacity-90 transition-opacity">
                    {T('reading.notes.save')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部栏（横板/双栏）*/}
      {isPaginatedMode && (
        <div className="shrink-0 px-6 py-2.5 border-t border-neutral-200/60 dark:border-stone-700/50 flex items-center justify-between gap-4">
          <button onClick={goPrevChapter} disabled={renderChapterIndex === 0} className="btn-press px-3 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center gap-1">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            {T('reading.prevChapter')}
          </button>
          <div className="flex items-center gap-2 text-xs text-neutral-400 dark:text-stone-500 min-w-0">
            <span className="tabular-nums">{pageInChapterDisplay} / {chapterPageCount}</span>
            <span className="text-neutral-300 dark:text-stone-600">·</span>
            <span className="truncate">{T('reading.chapterPos', { c: renderChapterIndex + 1, total: book.chapters.length })}</span>
          </div>
          <button onClick={goNextChapter} disabled={renderChapterIndex === book.chapters.length - 1} className="btn-press px-3 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center gap-1">
            {T('reading.nextChapter')}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          </button>
        </div>
      )}

      {/* 竖版底部状态栏 — 与横板/双栏一致：显示本章进度 + 章节进度 */}
      {!isPaginatedMode && (
        <div className="shrink-0 px-6 py-2.5 border-t border-neutral-200/60 dark:border-stone-700/50 flex items-center justify-between gap-4">
          <button onClick={goPrevChapter} disabled={displayedChapter === 0} className="btn-press px-3 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center gap-1">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            {T('reading.prevChapter')}
          </button>
          <div className="flex items-center gap-2 text-xs text-neutral-400 dark:text-stone-500 min-w-0">
            <span className="tabular-nums">{verticalScrollProgress}%</span>
            <span className="text-neutral-300 dark:text-stone-600">·</span>
            <span className="tabular-nums flex-shrink-0">{T('reading.chapterPos', { c: displayedChapter + 1, total: book.chapters.length })}</span>
          </div>
          <button onClick={goNextChapter} disabled={displayedChapter >= book.chapters.length - 1} className="btn-press px-3 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center gap-1">
            {T('reading.nextChapter')}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          </button>
        </div>
      )}
    </div>
  );
}

export default ReadingView;
