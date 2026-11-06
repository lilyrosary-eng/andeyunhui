// 模型选择器（厂商分组 + 粘性厂商标题）——宿主与插件共用的表现层。
//
// 为什么不用原生 `<select>` + `<optgroup>`：`optgroup` 的标题在系统弹出的列表里
// 会不会跟着滚不定，且各家浏览器行为不同。用户要的是「厂商滚过去之后一直钉在最顶部，
// 直到这家的模型看完才换下一家」，只有自己渲染的滚动面板做得到。
//
// 这个文件**不碰任何取数与运行时**（不 import tauri、不读 localStorage）：
// 宿主侧用 `TranslateModelPicker` 包一层真取数，插件侧必须走 `hostApi.invoke`
// 的授权通道，两边共用同一套分组渲染，但取数各走各的 —— 插件直接拿 tauri api
// 会绕过权限闸门，那是绝不能做的事。
import { useEffect, useRef, useState } from 'react';
import type { AiProviderGroup } from '@/lib/aiModelTree';

export interface ModelPickerLabels {
  /** 触发按钮上没选任何东西时的文案 */
  pick: string;
  /** 「跟随默认」那一项 */
  follow: string;
  /** 一家都没有时的提示 */
  empty: string;
}

interface Props {
  tree: AiProviderGroup[];
  /** 当前选中的模型 id；undefined = 跟随默认 */
  value?: string;
  onChange: (id?: string) => void;
  labels: ModelPickerLabels;
  /** 触发按钮上显示的文案（已选好时用它，避免调用方再拼一遍） */
  summary?: string | null;
  /** 取数中 / 取数失败的原文，如实显示，不静默变空列表 */
  note?: string;
  disabled?: boolean;
  buttonClassName?: string;
  panelClassName?: string;
}

export function ModelPicker(props: Props) {
  const { tree, value, onChange, labels, summary, note, disabled } = props;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 点面板外收起：用 capture 之外的普通监听，避免抢走列表项自己的点击
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (id?: string) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={
          props.buttonClassName ||
          'px-2 py-1 text-xs rounded-lg bg-neutral-100 dark:bg-stone-700 text-neutral-700 dark:text-stone-200 border-0 disabled:opacity-50'
        }
      >
        {summary || labels.pick}
        <span className="ml-1 opacity-60">▾</span>
      </button>
      {open && (
        <div
          className={
            props.panelClassName ||
            'absolute left-0 top-full z-50 mt-1 w-[300px] max-h-64 overflow-y-auto rounded-lg border border-neutral-200 dark:border-stone-700 bg-white dark:bg-stone-800 shadow-lg py-1'
          }
        >
          <button
            type="button"
            onClick={() => pick(undefined)}
            className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
              !value
                ? 'text-[var(--element-bg)] bg-[var(--element-muted)]'
                : 'text-neutral-600 dark:text-stone-300 hover:bg-[var(--element-muted)]'
            }`}
          >
            {labels.follow}
          </button>
          {tree.length === 0 ? (
            <div className="px-3 py-2 text-[11px] text-neutral-400 dark:text-stone-500">
              {note ? `${labels.empty}（${note}）` : labels.empty}
            </div>
          ) : (
            tree.map((g) => (
              <div key={g.providerId || g.name}>
                {/* 粘性厂商标题：滚动时一直贴在面板顶部，直到这家的模型看完才换成下一家。
                    底色必须是实的，否则模型行会从标题底下透出来。 */}
                <div className="sticky top-0 z-10 px-3 py-1 text-[10px] font-semibold tracking-wide text-neutral-500 dark:text-stone-400 bg-white dark:bg-stone-800 border-b border-neutral-100 dark:border-stone-700">
                  {g.name}
                  <span className="ml-1 font-normal opacity-60">{g.models.length}</span>
                </div>
                {g.models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => pick(m.id)}
                    title={m.id}
                    className={`w-full text-left px-3 py-1 text-xs break-all transition-colors ${
                      value === m.id
                        ? 'text-[var(--element-bg)] bg-[var(--element-muted)]'
                        : 'text-neutral-600 dark:text-stone-300 hover:bg-[var(--element-muted)]'
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
