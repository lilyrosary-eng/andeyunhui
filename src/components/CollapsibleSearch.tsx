import { Search } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';

interface CollapsibleSearchProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/** 可收起/展开的搜索框 — 默认只显示图标，点击展开输入框带动画 */
export function CollapsibleSearch({ value, onChange, placeholder = '搜索...' }: CollapsibleSearchProps) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  const handleToggle = () => {
    if (open) {
      if (value) onChange('');
      setOpen(false);
    } else {
      setOpen(true);
    }
  };

  const handleBlur = (e: React.FocusEvent) => {
    if (!value && !e.relatedTarget) {
      setOpen(false);
    }
  };

  return (
    <div className="relative flex items-center">
      <button
        onClick={handleToggle}
        className={`btn-press flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-xl transition-colors ${
          open
            ? 'text-[var(--element-color-raw)]'
            : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300'
        }`}
        title={placeholder}
      >
        <Search size={18} />
      </button>
      <input
        ref={inputRef}
        type="text"
        className={`px-3 py-2 bg-white/50 dark:bg-stone-700/50 border border-white/80 dark:border-stone-600/50 rounded-xl text-sm text-neutral-700 dark:text-stone-200 placeholder:text-neutral-400 dark:placeholder:text-stone-500 focus:outline-none focus:ring-1 focus:ring-[var(--element-border)] transition-all duration-300 ease-out ${
          open
            ? 'w-full opacity-100 ml-2'
            : 'w-0 opacity-0 ml-0 p-0 border-0 overflow-hidden'
        }`}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onChange('');
            setOpen(false);
          }
        }}
      />
    </div>
  );
}

export default CollapsibleSearch;