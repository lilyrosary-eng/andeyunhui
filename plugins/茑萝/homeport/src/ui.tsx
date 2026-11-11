/// <reference path="../../../global.d.ts" />
// 凌霄 · 下载中心：通用图标与小部件（不依赖宿主内部组件，保持插件可拆卸）。

import type { ReactNode } from 'react';

type IconProps = { size?: number; className?: string };

function base(size = 16, className = '') {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
  };
}

export const DownloadIcon = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M12 3v12" />
    <path d="m7 10 5 5 5-5" />
    <path d="M4 21h16" />
  </svg>
);

export const PlusIcon = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const RefreshIcon = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 4v7h-7" />
  </svg>
);

export const PauseIcon = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M8 5v14M16 5v14" />
  </svg>
);

export const PlayIcon = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="m8 5 11 7-11 7z" />
  </svg>
);

export const XIcon = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const FolderIcon = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);

export const SettingsIcon = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="8" cy="17" r="2" />
  </svg>
);

export const RetryIcon = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5" />
  </svg>
);

export const AlertIcon = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M12 3 2.5 20h19z" />
    <path d="M12 9v5M12 17h.01" />
  </svg>
);

export const CheckIcon = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="m5 12 5 5L20 6" />
  </svg>
);

export const LinkIcon = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
    <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
  </svg>
);

export const ChevronDownIcon = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <path d="m6 9 6 6 6-6" />
  </svg>
);

export const AnchorIcon = ({ size, className }: IconProps) => (
  <svg {...base(size, className)}>
    <circle cx="12" cy="5" r="2.5" />
    <path d="M12 7.5V21" />
    <path d="M5 13a7 7 0 0 0 14 0" />
    <path d="M3 13h4M17 13h4" />
  </svg>
);

export function IconButton({
  title,
  onClick,
  children,
  danger = false,
  disabled = false,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition-colors ${
        danger
          ? 'text-neutral-400 hover:bg-red-500/10 hover:text-red-500'
          : 'text-neutral-400 hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-stone-200'
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  );
}

const STATUS_TONE: Record<string, string> = {
  queued: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  probing: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  downloading: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  merging: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
  paused: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  completed: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  failed: 'bg-red-500/10 text-red-600 dark:text-red-400',
  canceled: 'bg-neutral-500/10 text-neutral-500 dark:text-stone-400',
};

export function StatusChip({ status, label }: { status: string; label: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_TONE[status] ?? STATUS_TONE.canceled}`}>
      {label}
    </span>
  );
}

export function ProgressBar({
  downloaded,
  total,
  active,
}: {
  downloaded: number;
  total: number;
  active: boolean;
}) {
  const percent = total > 0 ? Math.min(100, Math.max(0, (downloaded / total) * 100)) : 0;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10">
      <div
        className={`h-full rounded-full bg-[var(--element-bg)] transition-[width] duration-300 ${
          active && total === 0 ? 'w-1/3 animate-pulse' : ''
        }`}
        style={active && total === 0 ? undefined : { width: `${percent}%` }}
      />
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline gap-2">
        <span className="text-xs font-medium text-neutral-600 dark:text-stone-300">{label}</span>
        {hint ? <span className="text-[10px] text-neutral-400 dark:text-stone-500">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

export const inputClass =
  'w-full rounded-xl border border-black/10 bg-white/80 px-3 py-2 text-sm text-neutral-800 outline-none transition-colors placeholder:text-neutral-400 focus:border-[var(--element-bg)] dark:border-white/10 dark:bg-stone-900/60 dark:text-stone-100 dark:placeholder:text-stone-600';

export function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-black/10 px-6 py-14 text-center dark:border-white/10">
      <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-black/5 text-neutral-400 dark:bg-white/5 dark:text-stone-500">
        <AnchorIcon size={22} />
      </div>
      <div className="text-sm font-medium text-neutral-600 dark:text-stone-300">{title}</div>
      <div className="max-w-sm text-xs leading-relaxed text-neutral-400 dark:text-stone-500">{hint}</div>
    </div>
  );
}
