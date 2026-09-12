// 在线音乐模块通用 UI 模板（酷狗 / 汽水 / 网易云共享视觉结构）
//
// 设计原则（用户拍板）：
//   - 仅布局外壳：纯展示组件，不含任何业务/接口逻辑。
//   - 数据源各自独立：酷狗/汽水/网易云分别传入自己的数据，逻辑完全分离。
//   - accent 参数化品牌色（网易云 #f44336、酷狗 #f4333c/#00aaff、汽水 #00c2c7 等），
//     用于品牌标签底色、播放按钮、强调色。
//
// 母本取自 NeteaseView.tsx 原创视觉结构（歌单详情头部 / Hero 大卡 / 横向滑动小卡 /
// 搜索栏 / 用户卡），抽离后三端调用同一套，确保布局 100% 对齐。

import React from 'react';

// ============ 工具 ============
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export interface AccentProps {
  accent?: string; // 品牌主色，默认网易云红
}

// ============ 歌单详情头部 ============
export interface PlaylistDetailHeaderProps extends AccentProps {
  coverUrl?: string;
  name: string;
  brandLabel: string; // 例如 "网易云" / "酷狗" / "汽水音乐"
  trackCount: number;
  playCount?: number;
  description?: string;
  subscribed?: boolean;
  canSubscribe?: boolean; // 是否允许收藏（登录态）
  subscribeDisabledHint?: string;
  onPlayAll: () => void;
  onToggleSubscribe?: () => void;
}

export const PlaylistDetailHeader: React.FC<PlaylistDetailHeaderProps> = ({
  coverUrl,
  name,
  brandLabel,
  trackCount,
  playCount,
  description,
  subscribed,
  canSubscribe = true,
  subscribeDisabledHint,
  onPlayAll,
  onToggleSubscribe,
  accent = '#f44336',
}) => (
  <div className="flex gap-5 mb-5 min-w-0">
    <div className="shrink-0 w-32 h-32 sm:w-40 sm:h-40 rounded-2xl overflow-hidden bg-neutral-200 dark:bg-stone-800 shadow-sm">
      {coverUrl ? (
        <img src={coverUrl} alt={name} className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-3xl font-bold text-neutral-400 dark:text-stone-500">
          {name.slice(0, 1)}
        </div>
      )}
    </div>
    <div className="flex-1 min-w-0 flex flex-col justify-center gap-2">
      <div className="flex items-center gap-2 text-xs text-neutral-500 dark:text-stone-400">
        <span className="px-1.5 py-0.5 rounded" style={{ background: hexToRgba(accent, 0.1), color: accent }}>
          {brandLabel}
        </span>
        <span>{trackCount} 首</span>
        {playCount ? <span>· {(playCount / 10000).toFixed(1)} 万次播放</span> : null}
      </div>
      <h2 className="text-xl sm:text-2xl font-bold text-neutral-800 dark:text-stone-100 truncate">{name}</h2>
      {description ? (
        <p className="text-xs text-neutral-500 dark:text-stone-400 line-clamp-2">{description}</p>
      ) : null}
      <div className="flex items-center gap-2 mt-1">
        <button
          onClick={onPlayAll}
          className="btn-press flex items-center gap-1.5 px-4 py-1.5 rounded-full text-white dark:text-stone-900 text-sm font-medium transition-colors"
          style={{ background: accent }}
        >
          <PlayIcon />
          播放全部
        </button>
        {onToggleSubscribe && (
          <button
            onClick={onToggleSubscribe}
            disabled={!canSubscribe}
            className="btn-press flex items-center gap-1.5 px-4 py-1.5 rounded-full border border-neutral-300 dark:border-stone-700 text-neutral-700 dark:text-stone-200 text-sm hover:bg-neutral-100 dark:hover:bg-stone-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            title={canSubscribe ? (subscribed ? '取消收藏歌单' : '收藏歌单') : (subscribeDisabledHint || '请先登录')}
          >
            <HeartIcon filled={!!subscribed} />
            {subscribed ? '已收藏' : '收藏歌单'}
          </button>
        )}
      </div>
    </div>
  </div>
);

// ============ Hero 大卡（首页置顶推荐） ============
export interface HeroBannerProps extends AccentProps {
  coverUrl?: string;
  title: string;
  badge: string; // 例如 "为你精选" / "热门推荐"
  subtitle?: string;
  onClick: () => void;
}

export const HeroBanner: React.FC<HeroBannerProps> = ({
  coverUrl,
  title,
  badge,
  subtitle,
  onClick,
  accent = '#f44336',
}) => (
  <button
    onClick={onClick}
    className="btn-press group relative w-full max-w-full h-44 sm:h-52 rounded-2xl overflow-hidden text-left"
  >
    {coverUrl ? (
      <img src={coverUrl} alt={title} className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
    ) : (
      <div className="absolute inset-0 flex items-center justify-center text-4xl font-bold text-white/80" style={{ background: `linear-gradient(135deg, ${hexToRgba(accent, 0.7)}, ${hexToRgba('#3b82f6', 0.7)})` }}>
        {title.slice(0, 1)}
      </div>
    )}
    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
    <div className="absolute bottom-0 left-0 right-0 p-4">
      <div className="text-xs font-medium mb-1" style={{ color: hexToRgba(accent, 1) }}>
        {badge}
      </div>
      <div className="text-lg font-bold text-white truncate">{title}</div>
      {subtitle ? <div className="text-xs text-white/70">{subtitle}</div> : null}
    </div>
  </button>
);

// ============ 横向滑动小卡片行 ============
export interface GridCardItem {
  id: string | number;
  name: string;
  coverUrl?: string;
  subtitle?: string; // 例如 "12 首"
}
export interface PlaylistGridRowProps extends AccentProps {
  items: GridCardItem[];
  onOpen: (id: string | number, name: string) => void;
  emptyText?: string;
  loadingText?: string;
}

export const PlaylistGridRow: React.FC<PlaylistGridRowProps> = ({
  items,
  onOpen,
  emptyText = '暂无内容',
  loadingText = '加载中…',
  accent = '#f44336',
}) => {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const page = (dir: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir === 'left' ? -el.clientWidth * 0.8 : el.clientWidth * 0.8, behavior: 'smooth' });
  };
  if (items.length === 0) return <div className="text-xs text-neutral-500 dark:text-stone-400">{emptyText}</div>;
  return (
    <div className="relative w-full min-w-0">
      <button type="button" onClick={() => page('left')} className="absolute left-0 top-[calc(50%-12px)] z-10 flex h-7 w-7 -ml-1 items-center justify-center rounded-full bg-background/90 text-foreground shadow hover:bg-background border border-border/40 opacity-80 hover:opacity-100 transition-opacity" aria-label="向左翻页">
        <ChevronLeft />
      </button>
      <button type="button" onClick={() => page('right')} className="absolute right-0 top-[calc(50%-12px)] z-10 flex h-7 w-7 -mr-1 items-center justify-center rounded-full bg-background/90 text-foreground shadow hover:bg-background border border-border/40 opacity-80 hover:opacity-100 transition-opacity" aria-label="向右翻页">
        <ChevronRight />
      </button>
      <div ref={scrollRef} className="flex gap-3 overflow-x-auto min-w-0 pb-2 scrollbar-thin scroll-smooth">
        {items.map((p) => (
          <button key={p.id} onClick={() => onOpen(p.id, p.name)} className="btn-press group flex-shrink-0 flex flex-col text-left w-28 sm:w-32" title={p.name}>
            <div className="relative aspect-square rounded-xl overflow-hidden bg-neutral-200/60 dark:bg-stone-800/60 mb-2">
              {p.coverUrl ? (
                <img src={p.coverUrl} alt={p.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xl font-bold text-white/80" style={{ background: `linear-gradient(135deg, ${hexToRgba(accent, 0.7)}, ${hexToRgba('#3b82f6', 0.7)})` }}>
                  {p.name.slice(0, 1)}
                </div>
              )}
            </div>
            <div className="text-xs font-medium text-neutral-800 dark:text-stone-100 line-clamp-2">{p.name}</div>
            {p.subtitle ? <div className="text-[10px] text-neutral-500 dark:text-stone-400 truncate">{p.subtitle}</div> : null}
          </button>
        ))}
      </div>
    </div>
  );
};

// ============ 搜索栏 ============
export interface SearchBarProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

export const SearchBar: React.FC<SearchBarProps> = ({ value, onChange, placeholder, autoFocus }) => (
  <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
    <SearchIcon />
    <input
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="flex-1 bg-transparent outline-none text-sm text-neutral-800 dark:text-stone-100 placeholder:text-neutral-400 dark:placeholder:text-stone-500"
    />
  </div>
);

// ============ 区块标题 ============
export interface SectionTitleProps extends AccentProps {
  title: string;
  icon?: React.ReactNode;
  rightAction?: { label: string; onClick: () => void; icon?: React.ReactNode };
}

export const SectionTitle: React.FC<SectionTitleProps> = ({ title, icon, rightAction, accent = '#f44336' }) => (
  <div className="flex items-center justify-between min-w-0 mb-3">
    <div className="flex items-center gap-1.5 min-w-0">
      {icon}
      <h3 className="text-base font-semibold text-neutral-800 dark:text-stone-100 truncate min-w-0">{title}</h3>
    </div>
    {rightAction && (
      <button onClick={rightAction.onClick} className="btn-press flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm transition-colors" style={{ background: hexToRgba(accent, 0.15), color: accent }}>
        {rightAction.icon}
        {rightAction.label}
      </button>
    )}
  </div>
);

// ============ 用户卡（登录页） ============
export interface UserCardProps extends AccentProps {
  loggedIn: boolean;
  avatarUrl?: string;
  initial?: string; // 未登录时的占位字，如 "云" / "酷" / "汽"
  name?: string;
  vipLabel?: string; // 如 "VIP"
  signature?: string;
  userId?: string | number;
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}

export const UserCard: React.FC<UserCardProps> = ({
  loggedIn,
  avatarUrl,
  initial = '云',
  name,
  vipLabel,
  signature,
  userId,
  loading,
  error,
  onRetry,
  accent = '#f44336',
}) => (
  <div className="max-w-md mx-auto flex flex-col gap-5">
    {loggedIn && name ? (
      <div className="flex flex-col items-center gap-3 p-5 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="w-20 h-20 rounded-full object-cover border-2 border-white dark:border-stone-700 shadow-sm" />
        ) : (
          <div className="w-20 h-20 rounded-full flex items-center justify-center text-2xl font-bold" style={{ background: hexToRgba(accent, 0.15), color: accent }}>{initial}</div>
        )}
        <div className="text-center">
          <div className="flex items-center justify-center gap-2">
            <span className="text-lg font-semibold text-neutral-800 dark:text-stone-100">{name}</span>
            {vipLabel && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20">{vipLabel}</span>
            )}
          </div>
          {signature ? <div className="mt-1 text-xs text-neutral-500 dark:text-stone-400 max-w-[260px] truncate">{signature}</div> : null}
          {userId != null && <div className="mt-2 text-[10px] text-neutral-400 dark:text-stone-500">ID: {userId}</div>}
        </div>
      </div>
    ) : (
      <div className="flex flex-col items-center gap-3 p-5 rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60">
        <div className="w-20 h-20 rounded-full flex items-center justify-center text-2xl font-bold" style={{ background: hexToRgba(accent, 0.15), color: accent }}>{initial}</div>
        {error ? (
          <div className="text-center">
            <div className="text-sm text-red-600 dark:text-red-400 max-w-[240px]">{error}</div>
            {onRetry && (
              <button onClick={onRetry} disabled={loading} className="btn-press mt-2 px-3 py-1 rounded-lg text-xs transition-colors" style={{ background: hexToRgba(accent, 0.1), color: accent }}>
                {loading ? '获取中…' : '重新获取'}
              </button>
            )}
          </div>
        ) : (
          <div className="text-sm text-neutral-500 dark:text-stone-400">{loading ? '正在获取用户信息…' : '未能读取用户信息'}</div>
        )}
      </div>
    )}
  </div>
);

// ============ 内联图标（避免外部依赖耦合） ============
const PlayIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
);
const HeartIcon: React.FC<{ filled?: boolean }> = ({ filled }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2"><path d="M12 21s-7-4.5-9.5-9C1 9 2.5 5.5 6 5.5c2 0 3.2 1.2 4 2.3.8-1.1 2-2.3 4-2.3 3.5 0 5 3.5 3.5 6.5C19 16.5 12 21 12 21z" /></svg>
);
const SearchIcon: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
);
const ChevronLeft: React.FC = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M15 18l-6-6 6-6" /></svg>
);
const ChevronRight: React.FC = () => (
  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 18l6-6-6-6" /></svg>
);
