/* eslint-disable */
/// <reference path="../../global.d.ts" />
import React from "react";
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
  'full': '完整',
  'vertical': '竖版',
  'horizontal-forward': '横版正',
  'horizontal-reverse': '横版反',
};

const MODES: ViewMode[] = ['full', 'vertical', 'horizontal-forward', 'horizontal-reverse'];

// ========== 主组件 ==========
export function ImageViewer({ folderPath, folderName, onBack, initialPath }: ImageViewerProps) {
  const [images, setImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('full');
  const [currentIndex, setCurrentIndex] = useState(0);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fullImageRef = useRef<HTMLDivElement>(null);
  const wheelLock = useRef(0);

  const goToNext = useCallback(() => {
    setCurrentIndex(i => Math.min(i + 1, images.length - 1));
  }, [images.length]);

  const goToPrev = useCallback(() => {
    setCurrentIndex(i => Math.max(i - 1, 0));
  }, []);

  // 加载图片列表
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setCurrentIndex(0);  // 切换文件夹时重置索引
    hostApi.invoke<string[]>('get_folder_images', { folderPath })
      .then((paths) => {
        if (cancelled) return;
        setImages(paths);
        if (initialPath) {
          const idx = paths.indexOf(initialPath);
          if (idx >= 0) setCurrentIndex(idx);
        }
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error('[ImageViewer] 加载失败:', err);
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [folderPath]);

  // 键盘导航（完整模式）
  useEffect(() => {
    if (viewMode !== 'full') return;
    const onKey = (e: KeyboardEvent) => {
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

  // 滚轮导航（横版/竖版）— 原生滚动行为，不加限制
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    // 横版反：从末尾开始，配合反向滚轮实现"反着翻"（漫画倒序阅读，图片顺序不变）
    if (viewMode === 'horizontal-reverse') {
      el.scrollLeft = el.scrollWidth;
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // 使用即时滚动（非 smooth）：快速滚动时 smooth 动画会排队累积，
      // 导致滚轮越快反而越"翻不动"。即时滚动保证每帧位移与滚轮量成正比。
      if (viewMode === 'vertical') {
        el.scrollTop += e.deltaY * 2.5;
      } else if (viewMode === 'horizontal-reverse') {
        // 反着翻：滚轮方向与横版正相反
        el.scrollLeft -= e.deltaY * 3;
      } else {
        el.scrollLeft += e.deltaY * 3;
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewMode]);

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
    preload(currentIndex - 1);
    preload(currentIndex + 1);
  }, [currentIndex, images, viewMode]);

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
        <p className="text-sm text-neutral-400 dark:text-stone-500">加载中...</p>
      </div>
    );
  }

  if (images.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4">
        <p className="text-sm text-neutral-400 dark:text-stone-500">该文件夹没有图片</p>
        <button onClick={onBack} className="btn-press text-xs text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200">
          ← 返回
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#f5f5f0] dark:bg-[#1c1917]">
      {/* 顶部工具栏 */}
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
              title={ModeLabels[mode]}
            >
              <ModeIcon mode={mode} />
            </button>
          ))}
        </div>

        {/* 右侧：序号 */}
        {viewMode === 'full' && (
          <span className="text-xs text-neutral-400 dark:text-stone-500 tabular-nums">
            {currentIndex + 1}/{images.length}
          </span>
        )}
      </div>

      {/* 查看区域 */}
      <div className="flex-1 min-h-0">
        {viewMode === 'full' && (
          <FullView
            imgUrls={imgUrls}
            imgPaths={images}
            currentIndex={currentIndex}
            setCurrentIndex={setCurrentIndex}
            onWheel={handleWheelFull}
            containerRef={fullImageRef}
          />
        )}
        {viewMode === 'vertical' && (
          <VerticalView
            imgUrls={imgUrls}
            scrollRef={scrollContainerRef}
          />
        )}
        {viewMode === 'horizontal-forward' && (
          <HorizontalView
            imgUrls={imgUrls}
            scrollRef={scrollContainerRef}
          />
        )}
        {viewMode === 'horizontal-reverse' && (
          <HorizontalView
            imgUrls={imgUrls}
            scrollRef={scrollContainerRef}
          />
        )}
      </div>

      {/* 底部缩略图条（仅完整模式） */}
      {viewMode === 'full' && images.length > 1 && (
        <ThumbnailStrip
          imgUrls={imgUrls}
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
}: {
  imgUrls: string[];
  imgPaths: string[];
  currentIndex: number;
  setCurrentIndex: (i: number) => void;
  onWheel: (e: any) => void;
  containerRef: React.RefObject<HTMLDivElement>;
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
      {/* 点击右半区 */}
      {currentIndex < imgUrls.length - 1 && (
        <div className="absolute right-0 top-0 w-1/3 h-full cursor-pointer z-10" onClick={goNext} />
      )}

      {imgError ? (
        <div className="text-neutral-300 dark:text-stone-600 text-sm">图片加载失败</div>
      ) : (
        <img
          src={isCurrentGif ? (gifDataUrl || currentUrl) : currentUrl}
          alt={`${currentIndex + 1}/${imgUrls.length}`}
          key={currentIndex}
          onError={() => setImgError(true)}
          className="max-w-full max-h-full object-contain select-none"
          draggable={false}
        />
      )}
    </div>
  );
}

// ========== 竖版模式 ==========
function VerticalView({ imgUrls, scrollRef }: { imgUrls: string[]; scrollRef: React.RefObject<HTMLDivElement> }) {
  const [imgErrors, setImgErrors] = useState<Record<number, boolean>>({});

  return (
      <div ref={scrollRef} className="w-full h-full overflow-y-auto overflow-x-hidden" style={{ willChange: 'transform' }}>
      <div className="flex flex-col items-center">
        {imgUrls.map((url, i) => (
          <div key={i} className="w-full flex justify-center" style={isGif(url) ? undefined : { contentVisibility: 'auto', containIntrinsicSize: 'auto 300px' }}>
            {imgErrors[i] ? (
              <div className="w-full h-48 flex items-center justify-center text-neutral-300 dark:text-stone-600 text-sm">图片加载失败</div>
            ) : (
              <img
                src={url}
                alt={`${i + 1}`}
                loading="lazy"
                onError={() => setImgErrors(e => ({ ...e, [i]: true }))}
                className="max-w-full h-auto object-contain"
                draggable={false}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ========== 横版模式 ==========
function HorizontalView({
  imgUrls,
  scrollRef,
}: {
  imgUrls: string[];
  scrollRef: React.RefObject<HTMLDivElement>;
}) {
  const [imgErrors, setImgErrors] = useState<Record<number, boolean>>({});

  return (
    <div
      ref={scrollRef}
      className="w-full h-full overflow-x-auto overflow-y-hidden"
      style={{ willChange: 'transform' }}
    >
      <div className="flex h-full items-center">
        {imgUrls.map((url, i) => (
          <div key={i} className="h-full flex items-center justify-center flex-shrink-0" style={isGif(url) ? { minWidth: '60vw' } : { minWidth: '60vw', contentVisibility: 'auto', containIntrinsicSize: 'auto 60vw 90vh' }}>
            {imgErrors[i] ? (
              <div className="w-60 h-full flex items-center justify-center text-neutral-300 dark:text-stone-600 text-sm">图片加载失败</div>
            ) : (
              <img
                src={url}
                alt={`${i + 1}`}
                loading="lazy"
                onError={() => setImgErrors(e => ({ ...e, [i]: true }))}
                className="max-h-full max-w-full object-contain"
                draggable={false}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ========== 底部缩略图条 ==========
function ThumbnailStrip({
  imgUrls,
  currentIndex,
  onSelect,
}: {
  imgUrls: string[];
  currentIndex: number;
  onSelect: (i: number) => void;
}) {
  const stripRef = useRef<HTMLDivElement>(null);

  // 当前缩略图滚动到可见区域
  useEffect(() => {
    if (!stripRef.current) return;
    const thumb = stripRef.current.children[currentIndex] as HTMLElement | undefined;
    if (thumb) {
      thumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    }
  }, [currentIndex]);

  return (
    <div className="flex-shrink-0 border-t border-neutral-200/30 dark:border-stone-700/30 bg-white/80 dark:bg-stone-800/80 backdrop-blur-sm">
      <div
        ref={stripRef}
        className="flex gap-1.5 p-2 overflow-x-auto"
      >
        {imgUrls.map((url, i) => (
          <button
            key={i}
            onClick={() => onSelect(i)}
            className={`flex-shrink-0 w-12 h-12 rounded-md overflow-hidden border-2 transition-all ${
              i === currentIndex
                ? 'border-[var(--element-bg)] shadow-sm opacity-100'
                : 'border-transparent opacity-50 hover:opacity-80'
            }`}
          >
            <img
              src={url}
              alt={`${i + 1}`}
              loading="lazy"
              className="w-full h-full object-cover"
            />
          </button>
        ))}
      </div>
    </div>
  );
}