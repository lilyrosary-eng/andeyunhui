import { useRef, useState, useLayoutEffect, type ReactNode } from 'react';

export interface SlidingTabItem {
  id: string;
  label?: string;
  icon?: ReactNode;
}

interface SlidingTabsProps {
  tabs: SlidingTabItem[];
  value: string;
  onChange: (id: string) => void;
  className?: string;
}

// 滑动 tab：选中项下方有滑块背景随选中项平移（translateX + width 实测）。
export function SlidingTabs({ tabs, value, onChange, className = '' }: SlidingTabsProps) {
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });

  useLayoutEffect(() => {
    const idx = Math.max(0, tabs.findIndex((t) => t.id === value));
    const el = btnRefs.current[idx];
    if (el) setIndicator({ left: el.offsetLeft, width: el.offsetWidth });
  }, [value, tabs]);

  return (
    <div className={`relative flex items-center gap-1 ${className}`}>
      <span
        className="absolute top-1 bottom-1 z-0 rounded-lg bg-white dark:bg-stone-700 shadow-sm shadow-black/5 dark:shadow-black/20 transition-all duration-300 ease-out"
        style={{ left: indicator.left, width: indicator.width }}
      />
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => (btnRefs.current[i] = el)}
          onClick={() => onChange(t.id)}
          className={`relative z-10 flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            value === t.id
              ? 'text-neutral-800 dark:text-stone-100'
              : 'text-neutral-500 dark:text-stone-400 hover:text-neutral-700 dark:hover:text-stone-200'
          }`}
        >
          {t.icon}
          {t.label}
        </button>
      ))}
    </div>
  );
}

export default SlidingTabs;
