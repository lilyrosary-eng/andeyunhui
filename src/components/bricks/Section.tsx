// 通用设置分节卡片（积木）：圆角卡片 + 标题 + 内容区。
// 各模块设置面板（AI 记忆 / 伴侣 / 头像等）复用的同一容器，避免每处各写一份。
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-black/10 p-4 dark:border-white/10">
      <div className="mb-3 text-sm font-medium text-neutral-800 dark:text-stone-100">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}