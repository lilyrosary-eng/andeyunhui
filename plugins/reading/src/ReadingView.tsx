/// <reference path="../../global.d.ts" />
// 阅读视图 — CSS 多栏分页 + 三种布局模式
// 横板/双栏：所有章节拼接渲染，无缝翻页（拼接+动态缓存）
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
  const [verticalChapter, setVerticalChapter] = useState(0);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const verticalRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef({ startX: 0, active: false, offset: 0 });
  const wheelLock = useRef(0);
  const boundariesRef = useRef<ChapterBoundary[]>([]);
  const pendingJumpRef = useRef<number | null>(null);

  const isBookMode = layoutMode === 'book';
  const pagesPerStep = isBookMode ? 2 : 1;
  const isPaginatedMode = layoutMode !== 'vertical';

  // ============ 拼接 HTML：所有章节合并到一个容器 ============
  const combinedHtml = useMemo(() => {
    if (book.chapters.length === 0) return '';
    return book.chapters.map((ch, idx) =>
      `<div class="chapter-marker" data-chapter-index="${idx}">${ch.content || ''}</div>`
    ).join('');
  }, [book.chapters]);

  const currentChapter = book.chapters[chapterIndex] || book.chapters[0] || { title: '—', content: '' };

  // ============ 测量页数和章节边界 ============
  // offsetLeft 不受 CSS transform 影响，可直接在带 transform 的容器上读取
  const measure = useCallback(() => {
    const vp = viewportRef.current;
    const c = contentRef.current;
    if (!vp || !c) return;
    const vw = vp.clientWidth;
    const colCount = isBookMode ? 2 : 1;
    const colGap = isBookMode ? BOOK_GUTTER : GAP;
    const pw = Math.max(200, (vw - 2 * PAD - (colCount - 1) * colGap) / colCount);
    setPageWidth(pw);

    const step = (pw + colGap) * pagesPerStep;
    const scrollW = Math.max(0, c.scrollWidth - 2 * PAD);
    let pages = Math.max(1, Math.ceil(scrollW / step));
    // 容差：消除浮点误差导致的空白尾页
    if (pages > 1 && (pages - 1) * step >= scrollW - 1) pages -= 1;
    setPageCount(pages);

    // 测量章节边界：通过 offsetLeft 获取每个 chapter-marker 的水平位置
    const markers = c.querySelectorAll('.chapter-marker');
    const boundaries: ChapterBoundary[] = [];
    for (let i = 0; i < markers.length; i++) {
      const m = markers[i] as HTMLElement;
      const startOffset = m.offsetLeft;
      let endOffset: number;
      if (i < markers.length - 1) {
        endOffset = (markers[i + 1] as HTMLElement).offsetLeft;
      } else {
        endOffset = scrollW;
      }
      const startPage = Math.max(0, Math.floor(startOffset / step));
      const endPage = Math.max(startPage, Math.ceil(endOffset / step) - 1);
      const idx = parseInt(m.getAttribute('data-chapter-index') || '0', 10);
      boundaries.push({ index: idx, startPage, endPage });
    }
    boundariesRef.current = boundaries;

    // 处理待跳转
    if (pendingJumpRef.current !== null) {
      const targetIdx = pendingJumpRef.current;
      pendingJumpRef.current = null;
      const b = boundaries.find(x => x.index === targetIdx);
      if (b) {
        setNoTransition(true);
        setAbsolutePage(b.startPage);
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
  useLayoutEffect(() => {
    if (!isPaginatedMode) return;
    measure();
  }, [combinedHtml, isPaginatedMode, measure]);

  // 布局模式切换
  useEffect(() => {
    if (isPaginatedMode) measure();
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
  const reportedChapter = isPaginatedMode ? chapterIndex : verticalChapter;
  useEffect(() => {
    onChapterChange?.(reportedChapter);
  }, [reportedChapter, onChapterChange]);

  // ============ 外部章节索引（侧边栏点击）============
  useEffect(() => {
    if (externalChapterIndex === undefined) return;
    if (isPaginatedMode) {
      if (externalChapterIndex !== chapterIndex) {
        pendingJumpRef.current = externalChapterIndex;
        setNoTransition(true);
        measure();
      }
    } else {
      if (externalChapterIndex !== verticalChapter) {
        setVerticalChapter(externalChapterIndex);
      }
    }
  }, [externalChapterIndex, isPaginatedMode, measure, chapterIndex, verticalChapter]);

  // 书籍切换重置
  useEffect(() => {
    setAbsolutePage(0);
    setChapterIndex(0);
    setVerticalChapter(0);
    pendingJumpRef.current = null;
    if (verticalRef.current) verticalRef.current.scrollTop = 0;
  }, [book.filePath]);

  // ============ 翻页 ============
  const colGapForStep = isBookMode ? BOOK_GUTTER : GAP;
  const step = (pageWidth + colGapForStep) * pagesPerStep;

  const nextPage = useCallback(() => {
    setAbsolutePage((p) => Math.min(p + 1, pageCount - 1));
  }, [pageCount]);

  const prevPage = useCallback(() => {
    setAbsolutePage((p) => Math.max(p - 1, 0));
  }, []);

  const goPrevChapter = useCallback(() => {
    if (!isPaginatedMode) {
      if (verticalChapter > 0) setVerticalChapter(verticalChapter - 1);
      return;
    }
    if (chapterIndex > 0) {
      pendingJumpRef.current = chapterIndex - 1;
      setNoTransition(true);
      measure();
    }
  }, [isPaginatedMode, chapterIndex, verticalChapter, measure]);

  const goNextChapter = useCallback(() => {
    if (!isPaginatedMode) {
      if (verticalChapter < book.chapters.length - 1) setVerticalChapter(verticalChapter + 1);
      return;
    }
    if (chapterIndex < book.chapters.length - 1) {
      pendingJumpRef.current = chapterIndex + 1;
      setNoTransition(true);
      measure();
    }
  }, [isPaginatedMode, chapterIndex, book.chapters.length, verticalChapter, measure]);

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

  // ============ 竖版滚动 ============
  const onVerticalScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    if (atBottom && verticalChapter < book.chapters.length - 1) {
      const now = Date.now();
      if (now < wheelLock.current) return;
      wheelLock.current = now + 600;
      setVerticalChapter(verticalChapter + 1);
      requestAnimationFrame(() => { if (verticalRef.current) verticalRef.current.scrollTop = 0; });
    }
  }, [verticalChapter, book.chapters.length]);

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
  const translate = -absolutePage * step + dragOffset;
  const canPrev = absolutePage > 0;
  const canNext = absolutePage < pageCount - 1;

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

  const verticalChapterData = book.chapters[verticalChapter] || book.chapters[0];
  const emptyVerticalChapter = !verticalChapterData || !verticalChapterData.content;

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
          /* 竖版：单章节滚动 */
          <div ref={verticalRef} className="h-full overflow-y-auto scroll-smooth" onScroll={onVerticalScroll}>
            {emptyVerticalChapter ? (
              <div className="h-full flex items-center justify-center">
                <div className="text-center text-neutral-400 dark:text-stone-500">
                  <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                  <p className="text-xs">正在加载内容...</p>
                </div>
              </div>
            ) : (
              <div className="max-w-2xl mx-auto px-6 py-8">
                <div className="flex items-center gap-3 mb-6">
                  <div className="flex-1 h-px bg-neutral-200 dark:bg-stone-700" />
                  <span className="text-sm text-neutral-500 dark:text-stone-400 flex-shrink-0 font-medium">{verticalChapterData.title}</span>
                  <div className="flex-1 h-px bg-neutral-200 dark:bg-stone-700" />
                </div>
                <div
                  className="prose prose-sm text-neutral-700 dark:text-stone-300 leading-relaxed"
                  style={{ fontSize: '16px', lineHeight: 1.8 } as Record<string, string | number>}
                  dangerouslySetInnerHTML={{ __html: verticalChapterData.content }}
                />
                {verticalChapter < book.chapters.length - 1 && (
                  <div className="pt-8 pb-12 text-center">
                    <button onClick={goNextChapter} className="btn-press px-4 py-2 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                      下一章：{book.chapters[verticalChapter + 1].title} →
                    </button>
                  </div>
                )}
                {verticalChapter === book.chapters.length - 1 && (
                  <div className="pt-8 pb-12 text-center text-xs text-neutral-400 dark:text-stone-500">· 全书完 ·</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 底部栏（横板/双栏）*/}
      {isPaginatedMode && (
        <div className="shrink-0 px-6 py-2.5 border-t border-neutral-200/60 dark:border-stone-700/50 flex items-center justify-between gap-4">
          <button onClick={goPrevChapter} disabled={chapterIndex === 0} className="btn-press px-3 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center gap-1">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            上一章
          </button>
          <div className="flex items-center gap-2 text-xs text-neutral-400 dark:text-stone-500 min-w-0">
            <span className="tabular-nums">{absolutePage + 1} / {pageCount}</span>
            <span className="text-neutral-300 dark:text-stone-600">·</span>
            <span className="truncate">{chapterIndex + 1} / {book.chapters.length} 章</span>
          </div>
          <button onClick={goNextChapter} disabled={chapterIndex === book.chapters.length - 1} className="btn-press px-3 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center gap-1">
            下一章
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          </button>
        </div>
      )}

      {/* 竖版底部状态栏 */}
      {!isPaginatedMode && (
        <div className="shrink-0 px-6 py-2.5 border-t border-neutral-200/60 dark:border-stone-700/50 flex items-center justify-between gap-4">
          <button onClick={goPrevChapter} disabled={verticalChapter === 0} className="btn-press px-3 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center gap-1">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            上一章
          </button>
          <div className="flex items-center gap-2 text-xs text-neutral-400 dark:text-stone-500 min-w-0">
            <span className="truncate">{verticalChapterData?.title || '—'}</span>
            <span className="text-neutral-300 dark:text-stone-600">·</span>
            <span className="tabular-nums flex-shrink-0">{verticalChapter + 1} / {book.chapters.length} 章</span>
          </div>
          <button onClick={goNextChapter} disabled={verticalChapter === book.chapters.length - 1} className="btn-press px-3 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center gap-1">
            下一章
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
          </button>
        </div>
      )}
    </div>
  );
}

export default ReadingView;
