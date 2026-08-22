// 通用表单样式工具（积木）：全局统一输入框样式 + label 字段封装。
// 各模块设置面板复用同一份，避免每处各写一份 inputCls / Field。
export const inputCls =
  'w-full rounded-lg border border-black/10 bg-white/70 px-3 py-2 text-sm text-neutral-800 outline-none focus:border-sky-400 dark:border-white/10 dark:bg-stone-800/70 dark:text-stone-100';

/** 表单字段：label 文字 + 控件。 */
export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs text-neutral-500 dark:text-stone-400">{label}</div>
      {children}
    </label>
  );
}