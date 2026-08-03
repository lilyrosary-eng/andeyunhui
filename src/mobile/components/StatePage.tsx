/**
 * StatePage — 四态模板（§7.9.4 · 🔒 验收硬性要求，缺一不可发布）。
 *
 * 所有异步区域必须实现四态：加载 / 空 / 错误 / 无权限。
 * 每态含图标 + 文案 + 行动按钮，禁止无限空白 / 只有「暂无数据」。
 */

import type { ReactNode } from 'react';
import { Loader2, Inbox, AlertTriangle, ShieldAlert } from 'lucide-react';

type StateKind = 'loading' | 'empty' | 'error' | 'no-permission';

interface StatePageProps {
  state: StateKind;
  /** 主文案（空/错/无权限态的主标题） */
  title?: string;
  /** 解释说明（副文案） */
  description?: string;
  /** 错误态：可诊断清单 */
  checklist?: string[];
  /** 行动按钮文案 */
  actionLabel?: string;
  /** 行动按钮回调 */
  onAction?: () => void;
  /** 次要行动按钮文案（如「去设置」「降级方案」） */
  secondaryActionLabel?: string;
  onSecondaryAction?: () => void;
  /** 自定义图标（覆盖默认） */
  icon?: ReactNode;
}

export function StatePage({
  state,
  title,
  description,
  checklist,
  actionLabel,
  onAction,
  secondaryActionLabel,
  onSecondaryAction,
  icon,
}: StatePageProps) {
  const defaults: Record<StateKind, { icon: ReactNode; title: string; action: string }> = {
    loading: { icon: <Loader2 size={48} className="animate-spin text-[var(--muted-foreground)]" />, title: '加载中…', action: '' },
    empty: { icon: <Inbox size={48} className="text-[var(--muted-foreground)]" />, title: '暂无内容', action: '' },
    error: { icon: <AlertTriangle size={48} className="text-[var(--destructive)]" />, title: '出错了', action: '重试' },
    'no-permission': { icon: <ShieldAlert size={48} className="text-[var(--muted-foreground)]" />, title: '需要权限', action: '去设置' },
  };

  const d = defaults[state];
  const showIcon = icon ?? d.icon;
  const showTitle = title ?? d.title;
  const showAction = actionLabel ?? (state === 'error' || state === 'no-permission' ? d.action : '');

  return (
    <div
      className="flex flex-col items-center justify-center px-6 text-center"
      style={{ minHeight: '60vh', paddingBottom: 'calc(var(--tabbar-total) + 16px)' }}
    >
      {/* 图标 */}
      <div className="mb-4 opacity-80">{showIcon}</div>

      {/* 主文案 */}
      <h2
        className="font-semibold text-[var(--foreground)] mb-2"
        style={{ fontSize: 'var(--m-text-headline)' }}
      >
        {showTitle}
      </h2>

      {/* 副文案 */}
      {description && (
        <p
          className="text-[var(--muted-foreground)] mb-4 max-w-xs"
          style={{ fontSize: 'var(--m-text-body)', lineHeight: 1.5 }}
        >
          {description}
        </p>
      )}

      {/* 错误态：可诊断清单 */}
      {state === 'error' && checklist && checklist.length > 0 && (
        <ul
          className="text-left mb-6 space-y-2 max-w-xs"
          style={{ fontSize: 'var(--m-text-caption)' }}
        >
          {checklist.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-[var(--muted-foreground)]">
              <span className="shrink-0 mt-0.5">○</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}

      {/* 行动按钮 */}
      <div className="flex gap-3">
        {showAction && onAction && (
          <button
            type="button"
            onClick={onAction}
            className="bg-[var(--element-bg)] text-[var(--element-fg)] font-medium active:scale-95 transition-transform"
            style={{
              height: 'var(--touch-min)',
              paddingInline: '24px',
              fontSize: 'var(--m-text-label)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            {showAction}
          </button>
        )}
        {secondaryActionLabel && onSecondaryAction && (
          <button
            type="button"
            onClick={onSecondaryAction}
            className="bg-[var(--muted)] text-[var(--foreground)] font-medium active:scale-95 transition-transform"
            style={{
              height: 'var(--touch-min)',
              paddingInline: '24px',
              fontSize: 'var(--m-text-label)',
              borderRadius: 'var(--radius-lg)',
            }}
          >
            {secondaryActionLabel}
          </button>
        )}
      </div>
    </div>
  );
}
