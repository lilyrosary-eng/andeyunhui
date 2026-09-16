/* eslint-disable */
/// <reference path="../../global.d.ts" />
import React from "react";
import { T, useLang } from '../../_shared/pluginRuntime';
// 图片查看器 — 四种查看模式
const { useState, useEffect, useRef, useCallback, useMemo } = React;
const hostApi = window.__HOST_API__;

// 判断资源 URL 是否为 GIF（asset:// 协议 URL 仍保留原扩展名）
const isGif = (url: string) => /\.gif($|\?)/i.test(url);

// ========== 类型 ==========
type ViewMode = 'full' | 'vertical' | 'horizontal-forward' | 'horizontal-reverse';

interface ImageViewerProps {
  folderPath: string;
  folderName: string;
  onBack: () => void;
  /** 以安得云荟打开 / 拖入时，定位到指定图片 */
  initialPath?: string;
}

const ModeLabels: Record<ViewMode, string> = {
  'full': 'image.viewer.full',
  'vertical': 'image.viewer.vertical',
  'horizontal-forward': 'image.viewer.hForward',
  'horizontal-reverse': 'image.viewer.hReverse',
};

const MODES: ViewMode[] = ['full', 'vertical', 'horizontal-forward', 'horizontal-reverse'];

// ========== 主组件 ==========
export function ImageViewer({ folderPath, folderName, onBack, initialPath }: ImageViewerProps) {
  useLang();
  const [images, setImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('full');
  const [currentIndex, setCurrentIndex] = useState(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fullImageRef = useRef<HTMLDivElement>(null);
  const viewAreaRef = useRef<HTMLDivElement>(null);
  const wheelLock = useRef(0);

  const goToNext = useCallback(() => {
    setCurrentIndex(i => Math.min(i + 1, images.length - 1));
  }, [images.length]);

  const goToPrev = useCallback(() => {
    setCurrentIndex(i => Math.max(i - 1, 0));
  }, []);

  // ===== 进度记录（模块设置可开关；与视频/阅读同款 localStorage 模式）=====
  // 结构：{ i: 索引, p: 图片路径 }，恢复时优先按路径匹配（抗增删图偏移），失败再按索引 clamp。
  const [restoreIdx, setRestoreIdx] = useState<number | null>(null);
  const curIdxRef = useRef(currentIndex);
  curIdxRef.current = currentIndex;
  const curImgsRef = useRef(images);
  curImgsRef.current = images;

  // 加载图片列表
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setRestoreIdx(null);
    hostApi.invoke<string[]>('get_folder_images', { folderPath })
      .then((paths) => {
        if (cancelled) return;
        setImages(paths);
        let idx = 0;
        if (initialPath) {
          const j = paths.indexOf(initialPath);
          if (j >= 0) idx = j;
        } else if (localStorage.getItem('image.rememberProgress') === '1') {
          try {
            const saved = JSON.parse(localStorage.getItem('image.progress.' + folderPath) || 'null') as { i?: number; p?: string } | null;
            if (saved && typeof saved.i === 'number') {
              const byPath = saved.p ? paths.indexOf(saved.p) : -1;
              idx = byPath >= 0 ? byPath : Math.min(Math.max(Math.floor(saved.i), 0), paths.length - 1);
            }
          } catch { /* 忽略损坏的进度记录 */ }
        }
        setCurrentIndex(idx);
        setRestoreIdx((initialPath || localStorage.getItem('image.rememberProgress') === '1') ? idx : null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error('[ImageViewer] 加载失败:', err);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [folderPath]);  // eslint-disable-line react-hooks/exhaustive-deps

  // 位置变化防抖持久化（仅当「记住浏览进度」开启）
  useEffect(() => {
    if (loading || images.length === 0) return;
    const t = setTimeout(() => {
      try {
        if (localStorage.getItem('image.rememberProgress') === '1') {
          localStorage.setItem('image.progress.' + folderPath, JSON.stringify({ i: currentIndex, p: images[currentIndex] || '' }));
        }
      } catch { /* ignore */ }
    }, 400);
    return () => clearTimeout(t);
  }, [currentIndex, images, folderPath, loading]);

  // 卸载/切换文件夹时立即落盘最后一次位置（防抖的兜底，防最后一步丢失）
  useEffect(() => {
    const fp = folderPath;
    return () => {
      try {
        if (localStorage.getItem('image.rememberProgress') === '1') {
          const imgs = curImgsRef.current;
          const i = curIdxRef.current;
          if (imgs.length > 0) {
            localStorage.setItem('image.progress.' + fp, JSON.stringify({ i, p: imgs[i] || '' }));
          }
        }
      } catch { /* ignore */ }
    };
  }, [folderPath]);

  // 键盘导航（完整模式）
  useEffect(() => {
    if (viewMode !== 'full') return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return; // 页码输入中不抢按键
      if (e.key === 'ArrowLeft') goToPrev();
      else if (e.key === 'ArrowRight') goToNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewMode, goToNext, goToPrev]);

  // 滚轮导航（完整模式）— 仅过滤触摸板微滚动，保持滚轮一次一张
  const handleWheelFull = useCallback((e: React.WheelEvent) => {
    if (viewMode !== 'full') return;
    if (Math.abs(e.deltaY) < 10) return;
    if (e.deltaY > 0) goToNext();
    else goToPrev();
  }, [viewMode, goToNext, goToPrev]);

  // 滚轮驱动滚动（横版/竖版）：即时滚动保证每帧位移与滚轮量成正比
  const scrollByWheel = useCallback((deltaY: number) => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (viewMode === 'vertical') {
      el.scrollTop += deltaY * 2.5;
    } else if (viewMode === 'horizontal-reverse') {
      // 反着翻：滚轮方向与横版正相反
      el.scrollLeft -= deltaY * 3;
    } else {
      el.scrollLeft += deltaY * 3;
    }
  }, [viewMode]);

  // 滚轮导航（横版/竖版）— 原生滚动行为，不加限制
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      scrollByWheel(e.deltaY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewMode, scrollByWheel]);

  // 滚动模式挂载/切模式：定位到恢复进度（无进度时 reverse 从末尾开始，倒序阅读的起点）
  useEffect(() => {
    if (viewMode === 'full' || loading || images.length === 0) return;
    const el = scrollContainerRef.current;
    if (!el) return;
    const kids = (el.children[0] as HTMLElement | undefined)?.children;
    if (!kids || kids.length === 0) return;
    let target = currentIndex;
    if (viewMode === 'horizontal-reverse' && (restoreIdx == null || restoreIdx === 0) && currentIndex === 0) {
      target = kids.length - 1;
    }
    const kid = kids[target] as HTMLElement | undefined;
    if (!kid) return;
    if (viewMode === 'vertical') el.scrollTo({ top: kid.offsetTop });
    else el.scrollTo({ left: kid.offsetLeft });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, loading]);

  // 预加载相邻图片
  useEffect(() => {
    if (viewMode !== 'full' || images.length === 0) return;
    const preload = (idx: number) => {
      if (idx >= 0 && idx < images.length) {
        try {
          const img = new Image();
          img.src = hostApi.convertFileSrc(images[idx]);
        } catch (e) {
          // 预加载失败不影响主流程
        }
      }
    };
    preload(currentIndex - 2);
    preload(currentIndex - 1);
    preload(currentIndex + 1);
    preload(currentIndex + 2);
  }, [currentIndex, images, viewMode]);

  // ===== 中心点击（full=沉浸切换上下条框；滚动模式=唤出跳转菜单）=====
  const [menuOpen, setMenuOpen] = useState(false);
  // 完整模式沉浸：隐藏顶部工具栏与缩略图条（点击中心切换）
  const [chromeHidden, setChromeHidden] = useState(false);

  // 滚动比例（0~1）：按相对位置映射，图片加载把内容撑大后比例自动保持同步
  const readScrollRatio = useCallback((): number => {
    const el = scrollContainerRef.current;
    if (!el) return 0;
    const horiz = viewMode !== 'vertical';
    const total = horiz ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
    if (total <= 0) return 0;
    return Math.min(Math.max((horiz ? el.scrollLeft : el.scrollTop) / total, 0), 1);
  }, [viewMode]);

  // 菜单进度（0~1000）：拖动中锁定（scrubbing），其余时机跟随滚动与内容尺寸变化
  const scrubbingRef = useRef(false);
  const [menuPct, setMenuPct] = useState(0);

  // 菜单进度条跳转：按比例滚动 + 窗口立即对准目标图片（即时缓冲、无感加载）
  const handleMenuScrub = useCallback((ratio: number) => {
    setMenuPct(ratio * 1000);
    const el = scrollContainerRef.current;
    if (!el) return;
    const horiz = viewMode !== 'vertical';
    const total = horiz ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
    const pos = ratio * Math.max(total, 0);
    if (horiz) el.scrollLeft = pos; else el.scrollTop = pos;
    const kids = (el.children[0] as HTMLElement | undefined)?.children;
    if (!kids || kids.length === 0) return;
    let lo = 0, hi = kids.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const node = kids[mid] as HTMLElement;
      const off = horiz ? node.offsetLeft : node.offsetTop;
      if (off <= pos) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    setCurrentIndex(ans);
  }, [viewMode]);

  // 菜单打开期间：比例实时同步（onScroll 即时 + 200ms 轮询兜底内容尺寸变化）
  useEffect(() => {
    if (!menuOpen || viewMode === 'full') return;
    setMenuPct(readScrollRatio() * 1000);
    const t = setInterval(() => {
      if (!scrubbingRef.current) setMenuPct(readScrollRatio() * 1000);
    }, 200);
    return () => clearInterval(t);
  }, [menuOpen, viewMode, readScrollRatio]);

  // 滚动模式（竖版/横版）：滚动位置反推当前索引（rAF 节流 + 二分），驱动窗口化与菜单进度
  useEffect(() => {
    if (viewMode === 'full') return;
    const el = scrollContainerRef.current;
    if (!el) return;
    let raf = 0;
    const update = () => {
      raf = 0;
      const kids = (el.children[0] as HTMLElement | undefined)?.children;
      if (!kids || kids.length === 0) return;
      const horiz = viewMode !== 'vertical';
      const target = (horiz ? el.scrollLeft : el.scrollTop) + (horiz ? el.clientWidth : el.clientHeight) / 2;
      let lo = 0, hi = kids.length - 1, ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const node = kids[mid] as HTMLElement;
        const off = horiz ? node.offsetLeft : node.offsetTop;
        if (off <= target) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      setCurrentIndex(ans);
      if (!scrubbingRef.current) setMenuPct(readScrollRatio() * 1000);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    el.addEventListener('scroll', onScroll, { passive: true });
    update();
    return () => { el.removeEventListener('scroll', onScroll); if (raf) cancelAnimationFrame(raf); };
  }, [viewMode, images.length, readScrollRatio]);

  // 菜单打开期间：浮层挡住滚动容器，滚轮经浮层转发继续滚动
  // （React 合成 onWheel 底层是 passive，preventDefault 无效，须原生监听）
  useEffect(() => {
    if (!menuOpen || viewMode === 'full') return;
    const area = viewAreaRef.current;
    if (!area) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      scrollByWheel(e.deltaY);
    };
    area.addEventListener('wheel', onWheel, { passive: false });
    return () => area.removeEventListener('wheel', onWheel);
  }, [menuOpen, viewMode, scrollByWheel]);

  // 滚动模式：点击屏幕正中心区域（中 30% 宽 × 中 40% 高）唤出/隐藏菜单
  const handleCenterClick = useCallback((e: React.MouseEvent) => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const inX = e.clientX > r.left + r.width * 0.35 && e.clientX < r.right - r.width * 0.35;
    const inY = e.clientY > r.top + r.height * 0.3 && e.clientY < r.bottom - r.height * 0.3;
    if (inX && inY) setMenuOpen(v => !v);
  }, []);

  const imgUrls = useMemo(() => images.map(p => {
    try {
      return hostApi.convertFileSrc(p);
    } catch (e) {
      console.error('[ImageViewer] convertFileSrc 失败:', p, e);
      return '';  // 返回空字符串，由 onError 兜底显示"图片加载失败"
    }
  }), [images]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-neutral-400 dark:text-stone-500">{T('image.viewer.loading')}</p>
      </div>
    );
  }

  if (images.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <p className="text-sm text-neutral-400 dark:text-stone-500">{T('image.viewer.noImages')}</p>
        <button onClick={onBack} className="btn-press text-xs text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200">
          {T('image.back')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#f5f5f0] dark:bg-[#1c1917]">
      {/* 顶部工具栏（完整模式可点击图片中心隐藏，沉浸阅读） */}
      {!(viewMode === 'full' && chromeHidden) && (
      <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-200/30 dark:border-stone-700/30 flex-shrink-0 bg-white/60 dark:bg-stone-800/60 backdrop-blur-sm">
        {/* 左侧：返回 + 标题 */}
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div>
            <h2 className="text-sm font-medium text-neutral-700 dark:text-stone-200">{folderName}</h2>
          </div>
        </div>

        {/* 中间：模式切换 */}
        <div className="flex items-center gap-0.5 bg-black/5 dark:bg-white/5 rounded-lg p-0.5">
          {MODES.map(mode => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={`btn-press p-1.5 rounded-md transition-colors text-xs ${
                viewMode === mode
                  ? 'bg-white dark:bg-stone-700 text-neutral-700 dark:text-stone-200 shadow-sm'
                  : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300'
              }`}
              title={T(ModeLabels[mode])}
            >
              <ModeIcon mode={mode} />
            </button>
          ))}
        </div>

        {/* 右侧：序号（点击可输入页码跳转） */}
        {viewMode === 'full' && (
          <PageIndicator index={currentIndex} total={images.length} onJump={(i) => setCurrentIndex(i)} />
        )}
      </div>
      )}

      {/* 查看区域 */}
      <div ref={viewAreaRef} className="flex-1 min-h-0 relative">
        {viewMode === 'full' && (
          <FullView
            imgUrls={imgUrls}
            imgPaths={images}
            currentIndex={currentIndex}
            setCurrentIndex={setCurrentIndex}
            onWheel={handleWheelFull}
            containerRef={fullImageRef}
            onToggleChrome={() => setChromeHidden(v => !v)}
          />
        )}
        {viewMode === 'vertical' && (
          <VerticalView
            imgUrls={imgUrls}
            scrollRef={scrollContainerRef}
            onCenterClick={handleCenterClick}
            currentIndex={currentIndex}
          />
        )}
        {viewMode === 'horizontal-forward' && (
          <HorizontalView
            imgUrls={imgUrls}
            scrollRef={scrollContainerRef}
            onCenterClick={handleCenterClick}
            currentIndex={currentIndex}
          />
        )}
        {viewMode === 'horizontal-reverse' && (
          <HorizontalView
            imgUrls={imgUrls}
            scrollRef={scrollContainerRef}
            onCenterClick={handleCenterClick}
            currentIndex={currentIndex}
          />
        )}

        {/* 中心唤出的跳转菜单（滚动三模式）：进度按滚动相对比例映射，内容被图片加载撑大时自动同步 */}
        {menuOpen && viewMode !== 'full' && (
          <div className="absolute inset-0 z-30" onClick={() => setMenuOpen(false)}>
            <style>{IMG_JUMP_RANGE_CSS}</style>
            <div
              className="absolute bottom-12 left-1/2 -translate-x-1/2 rounded-2xl pl-4 pr-4 py-3 flex items-center gap-4 shadow-[0_18px_48px_-6px_rgba(0,0,0,0.55),0_6px_18px_rgba(0,0,0,0.35)]"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="text-xs text-white tabular-nums whitespace-nowrap bg-white/10 rounded-full px-3 py-1">
                {Math.min(currentIndex + 1, images.length)}<span className="text-white/50"> / {images.length}</span>
              </span>
              <input
                type="range"
                min={0}
                max={1000}
                value={Math.round(menuPct)}
                onChange={(e) => handleMenuScrub(parseInt(e.target.value, 10) / 1000)}
                onPointerDown={() => { scrubbingRef.current = true; }}
                onPointerUp={() => { scrubbingRef.current = false; }}
                onPointerCancel={() => { scrubbingRef.current = false; }}
                className="imgj-range w-[min(52vw,460px)]"
                style={{ '--fill': `${Math.round(menuPct) / 10}%` } as React.CSSProperties}
              />
            </div>
          </div>
        )}
      </div>

      {/* 底部缩略图条（仅完整模式；沉浸时隐藏） */}
      {viewMode === 'full' && images.length > 1 && !chromeHidden && (
        <ThumbnailStrip
          paths={images}
          currentIndex={currentIndex}
          onSelect={setCurrentIndex}
        />
      )}
    </div>
  );
}

// ========== 模式图标组件 ==========
function ModeIcon({ mode }: { mode: ViewMode }) {
  switch (mode) {
    case 'full':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 3 21 3 21 9" />
          <polyline points="9 21 3 21 3 15" />
          <line x1="21" y1="3" x2="14" y2="10" />
          <line x1="3" y1="21" x2="10" y2="14" />
        </svg>
      );
    case 'vertical':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <polyline points="8 10 12 6 16 10" />
        </svg>
      );
    case 'horizontal-forward':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="14 8 18 12 14 16" />
        </svg>
      );
    case 'horizontal-reverse':
      return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="19" y1="12" x2="5" y2="12" />
          <polyline points="10 8 6 12 10 16" />
        </svg>
      );
  }
}

// ========== 完整模式 ==========
function FullView({
  imgUrls,
  imgPaths,
  currentIndex,
  setCurrentIndex,
  onWheel,
  containerRef,
  onToggleChrome,
}: {
  imgUrls: string[];
  imgPaths: string[];
  currentIndex: number;
  setCurrentIndex: (i: number) => void;
  onWheel: (e: any) => void;
  containerRef: React.RefObject<HTMLDivElement>;
  onToggleChrome: () => void;
}) {
  const [imgError, setImgError] = useState(false);
  // GIF 读取为 data URL 渲染（绕过 WebView asset: 协议下动图不播放的问题）
  // 沙箱屏蔽了 fetch，改用后端 read_file_base64 读取原始文件路径为 data URI。
  const [gifDataUrl, setGifDataUrl] = useState<string | null>(null);
  const currentUrl = imgUrls[currentIndex];
  const currentPath = imgPaths[currentIndex];
  const isCurrentGif = isGif(currentUrl);

  useEffect(() => {
    setImgError(false);
    setGifDataUrl(null);
    if (isCurrentGif && currentPath) {
      let cancelled = false;
      hostApi.invoke<string>('read_file_base64', { filePath: currentPath })
        .then((dataUrl) => { if (!cancelled) setGifDataUrl(dataUrl); })
        .catch(() => { if (!cancelled) setImgError(true); });
      return () => { cancelled = true; };
    }
  }, [currentIndex, isCurrentGif, currentPath]);

  const goPrev = () => setCurrentIndex(Math.max(0, currentIndex - 1));
  const goNext = () => setCurrentIndex(Math.min(imgUrls.length - 1, currentIndex + 1));

  return (
    <div
      ref={containerRef}
      className="w-full h-full flex items-center justify-center relative overflow-hidden"
      onWheel={onWheel}
    >
      {/* 点击左半区 */}
      {currentIndex > 0 && (
        <div className="absolute left-0 top-0 w-1/3 h-full cursor-pointer z-10" onClick={goPrev} />
      )}
      {/* 点击中间区：隐藏/唤出顶部工具栏与缩略图条（沉浸切换） */}
      <div className="absolute left-1/3 top-0 w-1/3 h-full z-10" onClick={onToggleChrome} />
      {/* 点击右半区 */}
      {currentIndex < imgUrls.length - 1 && (
        <div className="absolute right-0 top-0 w-1/3 h-full cursor-pointer z-10" onClick={goNext} />
      )}

      {imgError ? (
        <div className="text-neutral-300 dark:text-stone-600 text-sm">{T('image.viewer.loadFailed')}</div>
      ) : (
        <img
          src={isCurrentGif ? (gifDataUrl || currentUrl) : currentUrl}
          alt={`${currentIndex + 1}/${imgUrls.length}`}
          key={currentIndex}
          onError={() => setImgError(true)}
          onLoad={(e) => { e.currentTarget.style.opacity = '1'; }}
          style={{ opacity: 0, transition: 'opacity 0.15s ease' }}
          className="max-w-full max-h-full object-contain select-none"
          decoding="async"
          draggable={false}
        />
      )}
    </div>
  );
}

// ========== 滚动模式窗口化（竖版/横版共用参数） ==========
// 性能核心：大文件夹（600+）全量挂载 <img> 会卡死 WebView。仅当前索引 ±20 挂载真实 <img>，
// 其余保留占位（已加载过的用学习到的真实尺寸，未加载的用「已学习平均尺寸」估计，越用越准）；
// 滚动时窗口随索引滑动，跳转时窗口立即对准目标（即时缓冲、无感加载）。
const SCROLL_WINDOW = 20;
const VERT_EST_H = 600;
const HORIZ_EST_W = 720;

// 菜单进度条样式：渐变已播放轨道 + 光晕 thumb（--fill 由内联变量驱动）
const IMG_JUMP_RANGE_CSS = `
.imgj-range{-webkit-appearance:none;appearance:none;height:6px;border-radius:9999px;background:linear-gradient(to right,var(--element-bg) var(--fill,0%),rgba(255,255,255,.16) var(--fill,0%));outline:none;cursor:pointer}
.imgj-range::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 0 0 4px rgba(255,255,255,.14),0 2px 8px rgba(0,0,0,.45);transition:transform .12s ease}
.imgj-range:hover::-webkit-slider-thumb{transform:scale(1.15)}
.imgj-range:active::-webkit-slider-thumb{transform:scale(1.25)}
`;

// ========== 竖版模式 ==========
function VerticalView({ imgUrls, scrollRef, onCenterClick, currentIndex }: {
  imgUrls: string[];
  scrollRef: React.RefObject<HTMLDivElement>;
  onCenterClick: (e: React.MouseEvent) => void;
  currentIndex: number;
}) {
  const [imgErrors, setImgErrors] = useState<Record<number, boolean>>({});
  const [, bumpHeights] = useState(0);
  const heightsRef = useRef<Map<number, number>>(new Map());

  let estH = VERT_EST_H;
  if (heightsRef.current.size > 0) {
    let sum = 0;
    heightsRef.current.forEach((v) => { sum += v; });
    estH = Math.min(Math.max(Math.round(sum / heightsRef.current.size), 200), 2400);
  }

  return (
    <div ref={scrollRef} onClick={onCenterClick} className="w-full h-full overflow-y-auto overflow-x-hidden relative" style={{ willChange: 'transform' }}>
      <div className="flex flex-col items-center">
        {imgUrls.map((url, i) => {
          const inWin = i >= currentIndex - SCROLL_WINDOW && i <= currentIndex + SCROLL_WINDOW;
          const h = heightsRef.current.get(i);
          return (
            <div key={i} className="w-full flex items-center justify-center" style={{ minHeight: h != null ? h : estH }}>
              {inWin && !imgErrors[i] ? (
                <img
                  src={url}
                  alt={`${i + 1}`}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  className="max-w-full h-auto object-contain"
                  onLoad={(e) => {
                    const real = (e.currentTarget.parentElement as HTMLElement | null)?.offsetHeight;
                    if (real && real > 0 && Math.abs((heightsRef.current.get(i) ?? 0) - real) > 2) {
                      heightsRef.current.set(i, real);
                      bumpHeights((t) => t + 1);
                    }
                  }}
                  onError={() => setImgErrors((er) => ({ ...er, [i]: true }))}
                />
              ) : imgErrors[i] ? (
                <div className="w-full flex items-center justify-center text-neutral-300 dark:text-stone-600 text-sm">{T('image.viewer.loadFailed')}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ========== 横版模式 ==========
function HorizontalView({
  imgUrls,
  scrollRef,
  onCenterClick,
  currentIndex,
}: {
  imgUrls: string[];
  scrollRef: React.RefObject<HTMLDivElement>;
  onCenterClick: (e: React.MouseEvent) => void;
  currentIndex: number;
}) {
  const [imgErrors, setImgErrors] = useState<Record<number, boolean>>({});
  const [, bumpWidths] = useState(0);
  const widthsRef = useRef<Map<number, number>>(new Map());

  let estW = HORIZ_EST_W;
  if (widthsRef.current.size > 0) {
    let sum = 0;
    widthsRef.current.forEach((v) => { sum += v; });
    estW = Math.min(Math.max(Math.round(sum / widthsRef.current.size), 240), 2400);
  }

  return (
    <div
      ref={scrollRef}
      onClick={onCenterClick}
      className="w-full h-full overflow-x-auto overflow-y-hidden relative"
      style={{ willChange: 'transform' }}
    >
      <div className="flex h-full items-center">
        {imgUrls.map((url, i) => {
          const inWin = i >= currentIndex - SCROLL_WINDOW && i <= currentIndex + SCROLL_WINDOW;
          const w = widthsRef.current.get(i);
          return (
            <div key={i} className="h-full flex items-center justify-center flex-shrink-0" style={{ minWidth: w != null ? w : estW }}>
              {inWin && !imgErrors[i] ? (
                <img
                  src={url}
                  alt={`${i + 1}`}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  className="max-h-full max-w-full object-contain"
                  onLoad={(e) => {
                    const real = (e.currentTarget.parentElement as HTMLElement | null)?.offsetWidth;
                    if (real && real > 0 && Math.abs((widthsRef.current.get(i) ?? 0) - real) > 2) {
                      widthsRef.current.set(i, real);
                      bumpWidths((t) => t + 1);
                    }
                  }}
                  onError={() => setImgErrors((er) => ({ ...er, [i]: true }))}
                />
              ) : imgErrors[i] ? (
                <div className="w-60 h-full flex items-center justify-center text-neutral-300 dark:text-stone-600 text-sm">{T('image.viewer.loadFailed')}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ========== 右上角页码（点击可输入页码跳转） ==========
function PageIndicator({ index, total, onJump }: { index: number; total: number; onJump: (i: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState('');
  const commit = () => {
    const n = parseInt(val, 10);
    if (!Number.isNaN(n)) onJump(Math.min(Math.max(n, 1), total) - 1);
    setEditing(false);
  };
  if (!editing) {
    return (
      <button
        onClick={() => { setVal(String(index + 1)); setEditing(true); }}
        className="text-xs text-neutral-400 dark:text-stone-500 tabular-nums hover:text-neutral-600 dark:hover:text-stone-300 transition-colors"
        title={T('image.viewer.jumpHint')}
      >
        {index + 1}/{total}
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-neutral-400 dark:text-stone-500 tabular-nums">
      <input
        autoFocus
        value={val}
        onChange={(e) => setVal(e.target.value.replace(/\D/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') setEditing(false); }}
        className="w-10 text-center bg-black/5 dark:bg-white/10 rounded text-neutral-600 dark:text-stone-300 focus:outline-none"
      />
      <span>/ {total}</span>
    </span>
  );
}

// ========== 底部缩略图条 ==========
// 性能三件套（600 张文件夹卡死的根治）：
//   ① 窗口化渲染：仅挂载当前 ±40 张的缩略图节点，两侧 spacer 撑起总宽保持滚动条稳定
//   ② 缩略图不再用原图：走后端 generate_thumbnail（200px JPEG，磁盘缓存复用），解码开销降数十倍
//   ③ 全局限并发 4：批量首次生成时不挤爆 CPU/主线程
const THUMB_WINDOW = 40;
const THUMB_ITEM_W = 48; // w-12
const THUMB_GAP = 6;     // gap-1.5

const thumbQueue: Array<() => void> = [];
let thumbActive = 0;
function pumpThumbQueue() {
  while (thumbActive < 4 && thumbQueue.length > 0) {
    thumbActive++;
    thumbQueue.shift()!();
  }
}
function scheduleThumb(task: () => void) {
  thumbQueue.push(task);
  pumpThumbQueue();
}
function thumbSettled() {
  thumbActive--;
  pumpThumbQueue();
}

function ThumbImg({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    scheduleThumb(() => {
      hostApi.invoke<string>('generate_thumbnail', { imagePath: path, width: 200 })
        .then((p) => {
          if (!cancelled && p) {
            try { setSrc(hostApi.convertFileSrc(p)); } catch { /* ignore */ }
          }
        })
        .catch(() => {})
        .finally(() => thumbSettled());
    });
    return () => { cancelled = true; };
  }, [path]);
  return src ? (
    <img src={src} alt="" className="w-full h-full object-cover" decoding="async" draggable={false} />
  ) : null;
}

function ThumbnailStrip({
  paths,
  currentIndex,
  onSelect,
}: {
  paths: string[];
  currentIndex: number;
  onSelect: (i: number) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);

  // 当前缩略图滚动到可见区域（窗口化渲染后按 data-i 定位）
  useEffect(() => {
    const thumb = stripRef.current?.querySelector<HTMLElement>(`[data-i="${currentIndex}"]`);
    thumb?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [currentIndex]);

  const start = Math.max(0, currentIndex - THUMB_WINDOW);
  const end = Math.min(paths.length, currentIndex + THUMB_WINDOW + 1);
  const items: React.ReactNode[] = [];
  if (start > 0) {
    items.push(<div key="head" style={{ width: start * (THUMB_ITEM_W + THUMB_GAP), flex: '0 0 auto' }} />);
  }
  for (let i = start; i < end; i++) {
    items.push(
      <button
        key={i}
        data-i={i}
        onClick={() => onSelect(i)}
        className={`flex-shrink-0 w-12 h-12 rounded-md overflow-hidden border-2 transition-all ${
          i === currentIndex
            ? 'border-[var(--element-bg)] shadow-sm opacity-100'
            : 'border-transparent opacity-50 hover:opacity-80'
        }`}
      >
        <ThumbImg path={paths[i]} />
      </button>
    );
  }
  if (end < paths.length) {
    items.push(<div key="tail" style={{ width: (paths.length - end) * (THUMB_ITEM_W + THUMB_GAP), flex: '0 0 auto' }} />);
  }

  return (
    <div className="flex-shrink-0 border-t border-neutral-200/30 dark:border-stone-700/30 bg-white/80 dark:bg-stone-800/80 backdrop-blur-sm">
      <div
        ref={stripRef}
        className="flex gap-1.5 p-2 overflow-x-auto"
      >
        {items}
      </div>
    </div>
  );
}