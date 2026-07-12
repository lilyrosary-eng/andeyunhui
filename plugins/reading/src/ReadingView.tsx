/// <reference path="../../global.d.ts" />
// 阅读视图 — CSS 多栏分页 + 三种布局模式
// 横板/双栏：3章滑动窗口动态缓存（前一章+当前章+后一章），无缝翻页
// 竖版：单章节滚动，到底部自动下一章

const React = window.__HOST_REACT__;
const { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } = React;

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
}

// ============ 布局常量 ============
const GAP = 48;
const PAD = 44;
const DRAG_THRESHOLD = 60;
const WHEEL_COOLDOWN = 280;
const BOOK_GUTTER = 24;

type LayoutMode = 'horizontal' | 'vertical' | 'book';

interface ChapterBoundary {
  index: number;
  startPage: number;
  endPage: number;
}

export function ReadingView({ book, onBack, externalChapterIndex, onChapterChange }: ReadingViewProps) {
  // 分页状态（横板/双栏模式）
  const [absolutePage, setAbsolutePage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [pageWidth, setPageWidth] = useState(0);

  // UI 状态
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [noTransition, setNoTransition] = useState(false);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('horizontal');

  // 章节追踪
  const [chapterIndex, setChapterIndex] = useState(0);
  // 竖版滚动进度（0-100，表示当前章内的滚动位置）
  const [verticalScrollProgress, setVerticalScrollProgress] = useState(0);
  // 3章滑动窗口中心章节索引（仅渲染 windowCenter±1 三章，避免大书全拼接卡死）
  const [windowCenter, setWindowCenter] = useState(0);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const verticalRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef({ startX: 0, active: false, offset: 0 });
  const wheelLock = useRef(0);
  const boundariesRef = useRef<ChapterBoundary[]>([]);
  // pendingJumpRef: 窗口滑动后恢复阅读位置。pageInChapter=-1 表示跳到该章最后一页
  const pendingJumpRef = useRef<{ chapterIndex: number; pageInChapter: number } | null>(null);
  // 竖版滑动窗口后调整 scrollTop：保持视觉连续性
  const verticalJumpRef = useRef<{ chapterIndex: number; position: 'top' | 'bottom' } | null>(null);
  // chapterIndexRef / windowCenterRef: 让 externalChapterIndex effect
  // 能读取最新值而不需要将其放入依赖数组（避免内部 chapterIndex 变化触发该 effect）
  const chapterIndexRef = useRef(0);
  const windowCenterRef = useRef(0);
  useEffect(() => { chapterIndexRef.current = chapterIndex; }, [chapterIndex]);
  useEffect(() => { windowCenterRef.current = windowCenter; }, [windowCenter]);

  const isBookMode = layoutMode === 'book';
  const pagesPerStep = isBookMode ? 2 : 1;
  const isPaginatedMode = layoutMode !== 'vertical';

  // ============ 3章滑动窗口动态缓存 ============
  // 仅渲染 windowCenter±1（前一章、当前章、后一章），避免大书全章节拼接卡死。
  // windowStart 只随 windowCenter 变化，不随 book.chapters.length 变化（流式加载稳定）。
  const windowStart = Math.max(0, windowCenter - 1);
  const windowEnd = Math.min(book.chapters.length, windowStart + 3);

  const combinedHtml = useMemo(() => {
    if (book.chapters.length === 0) return '';
    const slice = book.chapters.slice(windowStart, windowEnd);
    return slice.map((ch, i) => {
      const actualIdx = windowStart + i;
      const title = (ch.title || `第 ${actualIdx + 1} 章`)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<div class="chapter-marker" data-chapter-index="${actualIdx}"><h2 class="chapter-title-display">${title}</h2>${ch.content || ''}</div>`;
    }).join('');
  }, [book.chapters, windowStart, windowEnd]);

  const currentChapter = book.chapters[chapterIndex] || book.chapters[0] || { title: '—', content: '' };

  // ============ 测量页数和章节边界 ============
  // offsetLeft 不受 CSS transform 影响，可直接在带 transform 的容器上读取
  // 注意：offsetLeft 包含容器 padding，需减去 PAD 与 scrollW 对齐
  const measure = useCallback(() => {
    const vp = viewportRef.current;
    const c = contentRef.current;
    if (!vp || !c) return;
    const vw = vp.clientWidth;
    const colCount = isBookMode ? 2 : 1;
    const colGap = isBookMode ? BOOK_GUTTER : GAP;
    const pw = Math.floor(Math.max(200, (vw - 2 * PAD - (colCount - 1) * colGap) / colCount));
    setPageWidth(pw);

    const step = (pw + colGap) * pagesPerStep;
    const scrollW = Math.max(0, c.scrollWidth - 2 * PAD);
    // 容差：5% of step，消除 CSS multicol 子像素误差 + break-before:column 产生的空白尾页
    const TOLERANCE = Math.max(2, step * 0.05);
    let pages = Math.max(1, Math.ceil((scrollW - TOLERANCE) / step));
    // 二次校验：最后一页内容极少则视为空白尾页
    if (pages > 1 && (pages - 1) * step >= scrollW - TOLERANCE) pages -= 1;
    setPageCount(pages);

    // 测量章节边界：通过 offsetLeft 获取每个 chapter-marker 的水平位置
    const markers = c.querySelectorAll('.chapter-marker');
    const boundaries: ChapterBoundary[] = [];
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i] as HTMLElement;
      // offsetLeft 包含 padding-left，减去 PAD 与 scrollW 对齐
      const startOffset = m.offsetLeft - PAD;
      let endOffset: number;
      if (i < markers.length - 1) {
        endOffset = (markers[i + 1] as HTMLElement).offsetLeft - PAD;
      } else {
        endOffset = scrollW;
      }
      const startPage = Math.max(0, Math.floor((startOffset + TOLERANCE) / step));
      const endPage = Math.max(startPage, Math.ceil((endOffset - TOLERANCE) / step) - 1);
      const idx = parseInt(m.getAttribute('data-chapter-index') || '0', 10);
      boundaries.push({ index: idx, startPage, endPage });
    }
    boundariesRef.current = boundaries;

    // 处理待跳转（3章窗口滑动后恢复阅读位置）
    if (pendingJumpRef.current !== null) {
      const { chapterIndex: targetIdx, pageInChapter } = pendingJumpRef.current;
      pendingJumpRef.current = null;
      const b = boundaries.find(x => x.index === targetIdx);
      if (b) {
        setNoTransition(true);
        // pageInChapter=-1 表示跳到该章最后一页
        const page = pageInChapter === -1 ? b.endPage : Math.min(b.startPage + pageInChapter, b.endPage);
        setAbsolutePage(page);
        // 同步更新 chapterIndex，避免渲染时用旧 chapterIndex 导致页码显示错误（1/1 或 -13/11）
        setChapterIndex(targetIdx);
        requestAnimationFrame(() => setNoTransition(false));
        return;
      }
    }

    // 限制当前页在有效范围内
    setAbsolutePage((p) => Math.min(p, pages - 1));
  }, [isBookMode, pagesPerStep]);

  // ============ 同步测量：在 useLayoutEffect 中直接调用（消除弹簧动画）============
  // useLayoutEffect 在 DOM 变更后、浏览器绘制前同步执行
  // 在此设置状态，用户永远看不到中间帧 → 无弹簧动画
  // combinedHtml 变化（3章窗口滑动）时自动触发重新测量
  useLayoutEffect(() => {
    if (!isPaginatedMode) return;
    measure();
  }, [combinedHtml, isPaginatedMode, measure]);

  // 布局模式切换
  useEffect(() => {
    if (isPaginatedMode) {
      measure();
    } else {
      // 切换到竖版时同步 windowCenter 到当前 chapterIndex，
      // 避免用户在横板读到第N章切竖版后内容跳回第1章导致闪烁
      setWindowCenter(chapterIndexRef.current);
    }
  }, [layoutMode, measure, isPaginatedMode]);

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

  // 通知父组件章节变化
  const reportedChapter = isPaginatedMode ? chapterIndex : windowCenter;
  useEffect(() => {
    onChapterChange?.(reportedChapter);
  }, [reportedChapter, onChapterChange]);

  // ============ 外部章节索引（侧边栏点击）============
  // 关键：依赖数组只含 externalChapterIndex，不含 chapterIndex/verticalChapter
  // 否则内部 chapterIndex 变化时会重新触发此 effect，导致"跳到新章 → 弹回旧章 → 再跳新章"的弹簧动画
  useEffect(() => {
    if (externalChapterIndex === undefined) return;
    if (isPaginatedMode) {
      // 用 ref 读取最新 chapterIndex，避免将其放入依赖数组
      if (externalChapterIndex !== chapterIndexRef.current) {
        // 检查目标章是否在当前窗口内
        const ws = Math.max(0, windowCenterRef.current - 1);
        const we = Math.min(book.chapters.length, ws + 3);
        if (externalChapterIndex >= ws && externalChapterIndex < we) {
          // 在窗口内 → 直接跳到该章首页
          const b = boundariesRef.current.find(x => x.index === externalChapterIndex);
          if (b) {
            setNoTransition(true);
            setAbsolutePage(b.startPage);
            // 同步更新 chapterIndex，避免渲染时用旧值导致页码错误
            setChapterIndex(externalChapterIndex);
            requestAnimationFrame(() => setNoTransition(false));
            return;
          }
        }
        // 不在窗口内 → 滑动窗口
        pendingJumpRef.current = { chapterIndex: externalChapterIndex, pageInChapter: 0 };
        setNoTransition(true);
        setWindowCenter(externalChapterIndex);
      }
    } else {
      // 竖版：滑动窗口到目标章节，跳到该章顶部
      if (externalChapterIndex !== windowCenterRef.current) {
        verticalJumpRef.current = { chapterIndex: externalChapterIndex, position: 'top' };
        setWindowCenter(externalChapterIndex);
      }
    }
  }, [externalChapterIndex, isPaginatedMode, book.chapters.length]);

  // 书籍切换重置
  useEffect(() => {
    setAbsolutePage(0);
    setChapterIndex(0);
    setVerticalScrollProgress(0);
    setWindowCenter(0);
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
      setNoTransition(true);
      setWindowCenter(chapterIndex + 1);
    }
  }, [absolutePage, pageCount, chapterIndex, book.chapters.length]);

  const prevPage = useCallback(() => {
    if (absolutePage > 0) {
      setAbsolutePage(absolutePage - 1);
    } else if (windowStart > 0) {
      // 已到窗口第一页 → 滑动窗口到上一章，跳到该章最后一页
      pendingJumpRef.current = { chapterIndex: windowStart - 1, pageInChapter: -1 };
      setNoTransition(true);
      setWindowCenter(windowStart - 1);
    }
  }, [absolutePage, windowStart]);

  const goPrevChapter = useCallback(() => {
    if (!isPaginatedMode) {
      // 竖版：滑动窗口到上一章，跳到该章顶部
      if (windowStart > 0) {
        verticalJumpRef.current = { chapterIndex: windowStart - 1, position: 'top' };
        setWindowCenter(windowStart - 1);
      }
      return;
    }
    const prevIdx = chapterIndex - 1;
    if (prevIdx < 0) return;
    if (prevIdx >= windowStart) {
      // 上一章在窗口内 → 直接跳到该章最后一页
      const b = boundariesRef.current.find(x => x.index === prevIdx);
      if (b) {
        setNoTransition(true);
        setAbsolutePage(b.endPage);
        requestAnimationFrame(() => setNoTransition(false));
        return;
      }
    }
    // 上一章不在窗口内 → 滑动窗口，跳到该章最后一页
    pendingJumpRef.current = { chapterIndex: prevIdx, pageInChapter: -1 };
    setNoTransition(true);
    setWindowCenter(prevIdx);
  }, [isPaginatedMode, chapterIndex, windowStart]);

  const goNextChapter = useCallback(() => {
    if (!isPaginatedMode) {
      // 竖版：滑动窗口到下一章，跳到该章顶部
      if (windowEnd < book.chapters.length) {
        verticalJumpRef.current = { chapterIndex: windowEnd, position: 'top' };
        setWindowCenter(windowEnd);
      }
      return;
    }
    const nextIdx = chapterIndex + 1;
    if (nextIdx >= book.chapters.length) return;
    if (nextIdx < windowEnd) {
      // 下一章在窗口内 → 直接跳到该章首页
      const b = boundariesRef.current.find(x => x.index === nextIdx);
      if (b) {
        setNoTransition(true);
        setAbsolutePage(b.startPage);
        requestAnimationFrame(() => setNoTransition(false));
        return;
      }
    }
    // 下一章不在窗口内 → 滑动窗口
    pendingJumpRef.current = { chapterIndex: nextIdx, pageInChapter: 0 };
    setNoTransition(true);
    setWindowCenter(nextIdx);
  }, [isPaginatedMode, chapterIndex, book.chapters.length, windowEnd]);

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
      const { chapterIndex, position } = verticalJumpRef.current;
      verticalJumpRef.current = null;
      // 找到目标章节的 chapter-marker，调整 scrollTop 保持视觉位置
      const marker = verticalRef.current.querySelector(`[data-chapter-index="${chapterIndex}"]`) as HTMLElement | null;
      if (marker) {
        if (position === 'top') {
          verticalRef.current.scrollTop = marker.offsetTop;
        } else {
          verticalRef.current.scrollTop = marker.offsetTop + marker.offsetHeight - verticalRef.current.clientHeight;
        }
      }
    }
  }, [combinedHtml, isPaginatedMode]);

  // ============ 竖版滚动 ============
  const onVerticalScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // 计算当前滚动进度（0-100）
    const scrollable = el.scrollHeight - el.clientHeight;
    const progress = scrollable > 0 ? Math.round((el.scrollTop / scrollable) * 100) : 0;
    setVerticalScrollProgress(progress);
    if (scrollable <= 0) return;
    // 到底 → 滑动窗口向下（保持当前最后一章在视口底部）
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    if (atBottom && windowEnd < book.chapters.length) {
      const now = Date.now();
      if (now < wheelLock.current) return;
      wheelLock.current = now + 600;
      verticalJumpRef.current = { chapterIndex: windowEnd - 1, position: 'bottom' };
      setWindowCenter(windowCenter + 1);
      return;
    }
    // 到顶 → 滑动窗口向上（保持当前第一章在视口顶部）
    const atTop = el.scrollTop <= 0;
    if (atTop && windowStart > 0) {
      const now = Date.now();
      if (now < wheelLock.current) return;
      wheelLock.current = now + 600;
      verticalJumpRef.current = { chapterIndex: windowStart, position: 'top' };
      setWindowCenter(windowCenter - 1);
    }
  }, [windowStart, windowEnd, windowCenter, book.chapters.length]);

  // ============ 拖拽 ============
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !isPaginatedMode) return;
    dragState.current = { startX: e.clientX, active: true, offset: 0 };
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
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
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch {}
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

  if (book.chapters.length === 0) {
    return (
      <div className="h-full flex items-center justify-center bg-[#f5f5f0] dark:bg-[#1c1917]">
        <div className="text-center text-neutral-400 dark:text-stone-500">
          <div className="w-6 h-6 border-2 border-current border-t-transparent rounded-full animate-spin mx-auto mb-2" />
          <p className="text-sm">正在加载章节...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-[#f5f5f0] dark:bg-[#1c1917]">
      {/* 顶部栏 */}
      <div className="shrink-0 px-6 py-3 border-b border-neutral-200/60 dark:border-stone-700/50 flex items-center gap-3">
        <button onClick={onBack}
          className="btn-press w-9 h-9 flex items-center justify-center rounded-xl text-neutral-400 dark:text-stone-500 hover:text-[var(--element-color-raw)] hover:bg-[var(--element-muted)] transition-colors flex-shrink-0"
          title="返回书列表">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold truncate text-neutral-800 dark:text-stone-100">{book.title}</h1>
          <p className="text-xs text-neutral-400 dark:text-stone-500 truncate">
            {currentChapter?.title || '—'}
            {book.author ? ` · ${book.author}` : ''}
            {book.chapters.length > 0 ? ` · ${book.chapters.length} 章` : ''}
          </p>
        </div>
        {/* 布局切换 */}
        <div className="flex items-center gap-0.5 rounded-lg bg-black/5 dark:bg-white/10 p-0.5 flex-shrink-0">
          <button onClick={() => setLayoutMode('horizontal')} className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${layoutMode === 'horizontal' ? 'bg-white dark:bg-stone-700 text-neutral-800 dark:text-stone-100 shadow-sm' : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300'}`} title="横板：单页左右翻">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/></svg>
          </button>
          <button onClick={() => setLayoutMode('vertical')} className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${layoutMode === 'vertical' ? 'bg-white dark:bg-stone-700 text-neutral-800 dark:text-stone-100 shadow-sm' : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300'}`} title="竖版：连贯滚轮上下翻">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 2v20"/><path d="M16 2v20"/><line x1="2" y1="6" x2="22" y2="6"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="18" x2="22" y2="18"/></svg>
          </button>
          <button onClick={() => setLayoutMode('book')} className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${layoutMode === 'book' ? 'bg-white dark:bg-stone-700 text-neutral-800 dark:text-stone-100 shadow-sm' : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300'}`} title="双栏：仿真书左右对页">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          </button>
        </div>
      </div>

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
      >
        {isPaginatedMode ? (
          <>
            {/* 翻页热区 */}
            {!dragging && (
              <>
                {canPrev && <button aria-label="上一页" onClick={prevPage} className="absolute left-0 top-0 bottom-0 w-[10%] z-10 cursor-w-resize bg-transparent" />}
                {canNext && <button aria-label="下一页" onClick={nextPage} className="absolute right-0 top-0 bottom-0 w-[10%] z-10 cursor-e-resize bg-transparent" />}
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
                    '--reader-font-size': '16px',
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
                  '--reader-font-size': '17px',
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
          /* 竖版：3章拼接滚动（与横板共用 combinedHtml，切换模式不闪烁）*/
          <div ref={verticalRef} className="h-full overflow-y-auto relative" onScroll={onVerticalScroll}>
            <div
              className="reader-vertical max-w-2xl mx-auto"
              style={{
                padding: `24px ${PAD}px`,
                '--reader-font-size': '17px',
              } as Record<string, string | number>}
              dangerouslySetInnerHTML={{ __html: combinedHtml }}
            />
          </div>
        )}
      </div>

      {/* 底部栏（横板/双栏）*/}
      {isPaginatedMode && (
        <div className="shrink-0 px-6 py-2.5 border-t border-neutral-200/60 dark:border-stone-700/50 flex items-center justify-between gap-4">
          <button onClick={goPrevChapter} disabled={renderChapterIndex === 0} className="btn-press px-3 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center gap-1">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            上一章
          </button>
          <div className="flex items-center gap-2 text-xs text-neutral-400 dark:text-stone-500 min-w-0">
            <span className="tabular-nums">{pageInChapterDisplay} / {chapterPageCount}</span>
            <span className="text-neutral-300 dark:text-stone-600">·</span>
            <span className="truncate">{renderChapterIndex + 1} / {book.chapters.length} 章</span>
          </div>
          <button onClick={goNextChapter} disabled={renderChapterIndex === book.chapters.length - 1} className="btn-press px-3 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center gap-1">
            下一章
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          </button>
        </div>
      )}

      {/* 竖版底部状态栏 — 与横板/双栏一致：显示本章进度 + 章节进度 */}
      {!isPaginatedMode && (
        <div className="shrink-0 px-6 py-2.5 border-t border-neutral-200/60 dark:border-stone-700/50 flex items-center justify-between gap-4">
          <button onClick={goPrevChapter} disabled={windowCenter === 0} className="btn-press px-3 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center gap-1">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            上一章
          </button>
          <div className="flex items-center gap-2 text-xs text-neutral-400 dark:text-stone-500 min-w-0">
            <span className="tabular-nums">{verticalScrollProgress}%</span>
            <span className="text-neutral-300 dark:text-stone-600">·</span>
            <span className="tabular-nums flex-shrink-0">{windowCenter + 1} / {book.chapters.length} 章</span>
          </div>
          <button onClick={goNextChapter} disabled={windowCenter >= book.chapters.length - 1} className="btn-press px-3 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center gap-1">
            下一章
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          </button>
        </div>
      )}
    </div>
  );
}

export default ReadingView;
