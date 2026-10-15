// 通用「行内单选下拉」—— 替代原生 `<select>`。
//
// ## 为什么不用原生 `<select>`
// 1. **选项多就难用**：这里要选的模型可能上百个（用户配置里 184 个）。原生 select
//    的下拉面板由浏览器绘制，长度固定、不可搜索，滚起来又卡又不精确。
// 2. **样式不可控**：原生 option 的配色/间距在深浅色主题下不一致，和周围控件对不上。
// 3. **分组表达力弱**：`<optgroup>` 只能给个标签，没法在选项右侧补「所属供应商」这类信息。
//
// ## 为什么不用 radix / headless UI
// 项目只装了 context-menu / slider / switch 三个 Radix 包（没有 dropdown-menu），
// 为一个行内选择器再拉一个依赖不值得。所以按 `GpuPicker` 已验证过的骨架自建：
// 触发按钮 + 浮层 + 点外关闭。
//
// ## 定位用 fixed 而不是 absolute
// 面板常出现在可滚动容器（设置页）里，`absolute` 会被祖先的 `overflow` 裁掉。
// 所以用 `fixed` + 触发按钮的 `getBoundingClientRect()`；同时在滚动/缩放时**直接关闭**
// —— 与其做「跟随滚动」，不如关掉：位置一变就关是零出错的。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

export interface InlineSelectOption {
  value: string;
  label: string;
  /** 右侧的次要说明（如所属供应商）。不上屏到选项文本里，避免与搜索匹配混淆。 */
  hint?: string;
  /** 触发按钮上显示时用这个；缺省用 label。用于「未选 = 模型原生能力」这类语义。 */
  shortLabel?: string;
}

export interface InlineSelectGroup {
  label: string;
  options: InlineSelectOption[];
}

export interface InlineSelectProps {
  value: string;
  onChange: (v: string) => void;
  /** 空前缀组（如「不指定 / 默认」）—— 与 modelGroups 分开传，便于排在最前且不参与搜索过滤之外的分组逻辑。 */
  groups: InlineSelectGroup[];
  /** 空值时的占位文案（即「未选中」那一项）。 */
  placeholder: string;
  /** 悬停提示。 */
  title?: string;
  /** 触发按钮额外样式。 */
  className?: string;
  /** 选项超过该数量时显示搜索框。默认 10。 */
  searchThreshold?: number;
}

const PANEL_MAX_H = 300;

export function InlineSelect({
  value,
  onChange,
  groups,
  placeholder,
  title,
  className = '',
  searchThreshold = 10,
}: InlineSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const flat = useMemo(() => groups.flatMap((g) => g.options), [groups]);
  const total = flat.length;
  const needSearch = total > searchThreshold;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({ ...g, options: g.options.filter((o) => o.label.toLowerCase().includes(q)) }))
      .filter((g) => g.options.length > 0);
  }, [groups, query]);

  const shown = useMemo(() => filtered.flatMap((g) => g.options), [filtered]);
  const current = flat.find((o) => o.value === value);

  // 「值 → 在 shown 里的下标」。用查表而不是在 render 里 ++ 一个可变计数器：
  // 计数器写在渲染函数里是「渲染期间改外部状态」，React 严格模式下会出问题，
  // 且分组顺序一变就容易错位。查表是纯函数，结果与渲染次数无关。
  const indexOf = useMemo(() => {
    const m = new Map<string, number>();
    shown.forEach((o, i) => m.set(o.value, i));
    return m;
  }, [shown]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  const openPanel = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const up = r.bottom + 8 + PANEL_MAX_H > window.innerHeight && r.top > PANEL_MAX_H;
    setPos({ left: r.left, top: up ? r.top - 6 : r.bottom + 6, width: Math.max(r.width, 260), up });
    setHi(0);
    setOpen(true);
  }, []);

  // 点外关闭 + Esc。scroll/resize 直接关（位置会失效，见文件头注释）。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  useEffect(() => {
    if (open && needSearch) searchRef.current?.focus();
  }, [open, needSearch]);

  const pick = (v: string) => {
    onChange(v);
    close();
  };

  const onPanelKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((i) => Math.min(i + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const o = shown[hi]; if (o) pick(o.value); }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={() => (open ? close() : openPanel())}
        title={title}
        className={`inline-flex items-center gap-1 max-w-[240px] px-2 py-0.5 rounded-md text-[11px] border transition-colors ${
          current
            ? 'border-neutral-300 dark:border-stone-600 text-neutral-700 dark:text-stone-200 bg-white dark:bg-stone-900'
            : 'border-dashed border-neutral-300 dark:border-stone-600 text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300'
        } hover:bg-neutral-100 dark:hover:bg-stone-800 ${className}`}
      >
        <span className="truncate">
          {current ? (current.shortLabel ?? current.label) : placeholder}
        </span>
        <ChevronDown size={11} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && pos && (
        <div
          ref={panelRef}
          onKeyDown={onPanelKey}
          style={{
            position: 'fixed',
            left: Math.min(pos.left, Math.max(8, window.innerWidth - pos.width - 8)),
            top: pos.up ? undefined : pos.top,
            bottom: pos.up ? window.innerHeight - pos.top : undefined,
            width: pos.width,
            maxHeight: PANEL_MAX_H,
            zIndex: 9999,
          }}
          className="flex flex-col rounded-xl border border-neutral-200 dark:border-stone-700 bg-white dark:bg-stone-900 shadow-2xl overflow-hidden"
        >
          {needSearch && (
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-neutral-100 dark:border-stone-800">
              <Search size={12} className="shrink-0 text-neutral-400" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => { setQuery(e.target.value); setHi(0); }}
                placeholder="搜索模型…"
                className="w-full bg-transparent text-[12px] outline-none text-neutral-800 dark:text-stone-100 placeholder:text-neutral-400"
              />
              <span className="shrink-0 text-[10px] text-neutral-400 tabular-nums">{total}</span>
            </div>
          )}

          <div className="overflow-y-auto py-1">
            {filtered.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-neutral-400 dark:text-stone-500">没有匹配的模型</div>
            )}
            {filtered.map((g) => (
              <div key={g.label}>
                {g.label && (
                  <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-neutral-400 dark:text-stone-500">
                    {g.label}
                  </div>
                )}
                {g.options.map((o) => {
                  const idx = indexOf.get(o.value) ?? -1;
                  const isSel = o.value === value;
                  const isHi = idx === hi;
                  return (
                    <button
                      key={`${g.label}/${o.value}`}
                      type="button"
                      onClick={() => pick(o.value)}
                      onMouseEnter={() => setHi(idx)}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12px] ${
                        isHi ? 'bg-neutral-100 dark:bg-stone-800' : ''
                      } ${isSel ? 'text-[var(--element-border)] font-medium' : 'text-neutral-700 dark:text-stone-200'}`}
                    >
                      <span className="shrink-0 w-3">
                        {isSel && <Check size={12} />}
                      </span>
                      <span className="truncate flex-1">{o.label}</span>
                      {o.hint && (
                        <span className="shrink-0 text-[10px] text-neutral-400 dark:text-stone-500 truncate max-w-[110px]">
                          {o.hint}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

export default InlineSelect;
