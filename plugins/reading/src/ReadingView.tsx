/// <reference path="../../global.d.ts" />
// 阅读视图 — CSS 多栏分页 + 三种布局模式
// 横板：单页左右翻 | 竖版：章节拼接滚轮上下翻 | 双栏：左右对页仿真书

const React = window.__HOST_REACT__;
const { useState, useRef, useEffect, useLayoutEffect, useCallback } = React;

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
  // 外部章节索引（由侧边栏章节列表点击控制），不传则内部管理
  externalChapterIndex?: number;
}

// ============ 布局常量 ============
const GAP = 48;
const PAD = 44;
const DRAG_THRESHOLD = 60;
const WHEEL_COOLDOWN = 280;
const BOOK_GUTTER = 24; // 双栏中缝

type LayoutMode = 'horizontal' | 'vertical' | 'book';

export function ReadingView({ book, onBack, externalChapterIndex }: ReadingViewProps) {
  const [chapterIndex, setChapterIndex] = useState(0);
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [pageWidth, setPageWidth] = useState(0);
  const [dragOffset, setDragOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [noTransition, setNoTransition] = useState(false);
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('horizontal');

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const verticalRef = useRef<HTMLDivElement | null>(null);
  const dragState = useRef({ startX: 0, active: false, offset: 0 });
  const wheelLock = useRef(0);
  const pendingIntent = useRef<'first' | 'last' | null>(null);
  const landOnLastPage = useRef(false);

  // 书籍切换 → 重置
  useEffect(() => {
    setChapterIndex(0);
    setPage(0);
    // 竖版模式滚到顶部
    if (verticalRef.current) verticalRef.current.scrollTop = 0;
  }, [book.filePath]);

  // 外部章节索引变化（侧边栏点击章节）→ 同步内部状态
  useEffect(() => {
    if (externalChapterIndex !== undefined && externalChapterIndex !== chapterIndex) {
      setChapterIndex(externalChapterIndex);
      setPage(0);
    }
  }, [externalChapterIndex]);

  const safeChapterIndex = Math.max(0, Math.min(chapterIndex, book.chapters.length - 1));
  const chapter = book.chapters[safeChapterIndex];
  const isBookMode = layoutMode === 'book';
  // 双栏模式下每"逻辑页" = 2 个 CSS column
  const pagesPerStep = isBookMode ? 2 : 1;

  // ============ 测量页数 ============
  const measure = useCallback(() => {
    const vp = viewportRef.current;
    const c = contentRef.current;
    if (!vp || !c) return;
    const vw = vp.clientWidth;
    const colCount = isBookMode ? 2 : 1;
    const gutter = isBookMode ? BOOK_GUTTER : 0;
    const raw = colCount * ((vw - 2 * PAD - gutter) / colCount) + gutter;
    const pw = Math.max(200, (vw - 2 * PAD - (isBookMode ? gutter : 0)) / colCount);
    setPageWidth(pw);
    const scrollW = c.scrollWidth;
    const step = pw + GAP;
    const rawPages = Math.max(1, Math.ceil(scrollW / step));
    let pages = rawPages;
    if (pages > 1 && (pages - 1) * step >= scrollW - 1) pages -= 1;
    // 双栏：逻辑页数 = ceil(totalColumns / 2)
    if (isBookMode) pages = Math.max(1, Math.ceil(pages / 2));
    setPageCount(pages);
    const intent = pendingIntent.current;
    pendingIntent.current = null;
    if (intent === 'last') {
      setNoTransition(true);
      setPage(pages - 1);
      requestAnimationFrame(() => setNoTransition(false));
    } else if (intent === 'first') {
      setPage(0);
    } else {
      setPage((p) => Math.min(p, pages - 1));
    }
  }, [isBookMode]);

  useLayoutEffect(() => {
    pendingIntent.current = landOnLastPage.current ? 'last' : 'first';
    landOnLastPage.current = false;
    setDragOffset(0);
    const id = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(id);
  }, [chapterIndex, measure]);

  // 布局模式切换
  useEffect(() => {
    measure();
  }, [layoutMode, measure]);

  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(vp);
    return () => ro.disconnect();
  }, [measure]);

  // ============ 翻页（双栏模式步进 2） ============
  const step = (pageWidth + GAP) * pagesPerStep;

  const nextPage = useCallback(() => {
    setPage((p) => {
      if (p < pageCount - 1) return p + 1;
      if (chapterIndex < book.chapters.length - 1) {
        setChapterIndex(chapterIndex + 1);
        return 0;
      }
      return p;
    });
  }, [pageCount, chapterIndex, book.chapters.length]);

  const prevPage = useCallback(() => {
    setPage((p) => {
      if (p > 0) return p - 1;
      if (chapterIndex > 0) {
        landOnLastPage.current = true;
        setChapterIndex(chapterIndex - 1);
      }
      return p;
    });
  }, [chapterIndex]);

  const goPrevChapter = useCallback(() => {
    if (chapterIndex > 0) {
      landOnLastPage.current = true;
      setChapterIndex(chapterIndex - 1);
    }
  }, [chapterIndex]);

  const goNextChapter = useCallback(() => {
    if (chapterIndex < book.chapters.length - 1) {
      setChapterIndex(chapterIndex + 1);
    }
  }, [chapterIndex, book.chapters.length]);

  // ============ 键盘 ============
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (layoutMode === 'vertical') return;
      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
        case ' ': e.preventDefault(); nextPage(); break;
        case 'ArrowLeft':
        case 'PageUp': e.preventDefault(); prevPage(); break;
        case 'Home': e.preventDefault(); setPage(0); break;
        case 'End': e.preventDefault(); setPage(pageCount - 1); break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [nextPage, prevPage, pageCount, layoutMode]);

  // ============ 滚轮（竖版用原生滚动，横板/双栏翻页）============
  const onWheel = (e: React.WheelEvent) => {
    if (layoutMode === 'vertical') return;
    const now = Date.now();
    if (now < wheelLock.current) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (Math.abs(d) < 8) return;
    wheelLock.current = now + WHEEL_COOLDOWN;
    if (d > 0) nextPage();
    else prevPage();
  };

  // ============ 拖拽 ============
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || layoutMode === 'vertical') return;
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
  const translate = -page * step + dragOffset;
  const canPrev = page > 0 || chapterIndex > 0;
  const canNext = page < pageCount - 1 || chapterIndex < book.chapters.length - 1;

  // 空章节：加载中
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

  // 竖版已加载但内容为空
  const emptyChapter = !chapter || !chapter.content;

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
            {chapter?.title || '—'}
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
        style={{ touchAction: layoutMode === 'vertical' ? 'auto' : 'none' }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={finishDrag}
        onPointerCancel={finishDrag}
      >
        {layoutMode === 'vertical' ? (
          /* 竖版：章节拼接，连贯滚轮 */
          <div ref={verticalRef} className="h-full overflow-y-auto scroll-smooth">
            {book.chapters.length === 0 ? (
              <div className="h-full flex items-center justify-center">
                <div className="text-center text-neutral-400 dark:text-stone-500">
                  <div className="w-5 h-5 border-2 border-current border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                  <p className="text-xs">正在加载内容...</p>
                </div>
              </div>
            ) : (
              <div className="max-w-2xl mx-auto px-6 py-8 space-y-6">
                {book.chapters.map((ch, i) => {
                  const hasContent = ch.content && ch.content.length > 20;
                  return (
                    <div key={ch.id} id={`ch-${ch.id}`}>
                      {i > 0 && (
                        <div className="flex items-center gap-3 mb-4 mt-2">
                          <div className="flex-1 h-px bg-neutral-200 dark:bg-stone-700" />
                          <span className="text-xs text-neutral-400 dark:text-stone-500 flex-shrink-0 font-medium">{ch.title}</span>
                          <div className="flex-1 h-px bg-neutral-200 dark:bg-stone-700" />
                        </div>
                      )}
                      {hasContent ? (
                        <div
                          className="prose prose-sm text-neutral-700 dark:text-stone-300 leading-relaxed"
                          style={{ fontSize: '16px', lineHeight: 1.8 } as Record<string, string | number>}
                          dangerouslySetInnerHTML={{ __html: ch.content }}
                        />
                      ) : (
                        <div className="py-12 text-center">
                          <div className="w-4 h-4 border-2 border-neutral-300 dark:border-stone-600 border-t-transparent rounded-full animate-spin mx-auto mb-2" />
                          <p className="text-xs text-neutral-400 dark:text-stone-500">加载中 ({ch.title})</p>
                        </div>
                      )}
                    </div>
                  );
                })}
                {/* 章节进度 */}
                <div className="pt-6 pb-12 text-center text-xs text-neutral-400 dark:text-stone-500">
                  共 {book.chapters.length} 章 · {book.title}
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
            {/* 翻页热区 */}
            {!dragging && (
              <>
                {canPrev && <button aria-label="上一页" onClick={prevPage} className="absolute left-0 top-0 bottom-0 w-[10%] z-10 cursor-w-resize bg-transparent" />}
                {canNext && <button aria-label="下一页" onClick={nextPage} className="absolute right-0 top-0 bottom-0 w-[10%] z-10 cursor-e-resize bg-transparent" />}
              </>
            )}
            {/* 双栏模式：宽容器显示两个 CSS column，视觉中缝 */}
            {isBookMode ? (
              <div className="h-full flex items-center justify-center overflow-hidden">
                <div
                  className="reader-columns-book h-full"
                  style={{
                    width: `${pageWidth * 2 + BOOK_GUTTER}px`,
                    columnWidth: `${pageWidth}px`,
                    columnGap: `${GAP + BOOK_GUTTER / 2}px`,
                    columnFill: 'auto',
                    padding: `24px ${PAD}px`,
                    transform: `translateX(${-(page * pagesPerStep) * (pageWidth + GAP + BOOK_GUTTER / 4) + dragOffset}px)`,
                    transition: dragging || noTransition ? 'none' : 'transform 0.28s ease',
                    '--reader-font-size': '16px',
                  } as Record<string, string | number>}
                  dangerouslySetInnerHTML={{ __html: chapter?.content || '' }}
                />
              </div>
            ) : (
              /* 横板：单页 */
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
                  dangerouslySetInnerHTML={{ __html: chapter?.content || '' }}
                />
            )}
            {!isBookMode && (
              <>
                <div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-[#f5f5f0] dark:from-[#1c1917] to-transparent" />
                <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-[#f5f5f0] dark:from-[#1c1917] to-transparent" />
              </>
            )}
          </>
        )}
      </div>

      {/* 底部栏（横板/双栏） */}
      {layoutMode !== 'vertical' && (
        <div className="shrink-0 px-6 py-2.5 border-t border-neutral-200/60 dark:border-stone-700/50 flex items-center justify-between gap-4">
          <button onClick={goPrevChapter} disabled={chapterIndex === 0} className="btn-press px-3 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center gap-1">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            上一章
          </button>
          <div className="flex items-center gap-2 text-xs text-neutral-400 dark:text-stone-500 min-w-0">
            <span className="tabular-nums">{page + 1} / {pageCount}</span>
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
      {layoutMode === 'vertical' && (
        <div className="shrink-0 px-6 py-2 border-t border-neutral-200/60 dark:border-stone-700/50 text-center text-xs text-neutral-400 dark:text-stone-500">
          共 {book.chapters.length} 章 · 上下滚动阅读
        </div>
      )}
    </div>
  );
}

export default ReadingView;
