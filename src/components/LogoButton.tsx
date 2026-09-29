import type { ReactNode } from 'react';
import { CornflowerMark } from '@/components/CornflowerMark';

interface LogoButtonProps {
  onClick: () => void;
  /** 提示文案（调用方负责翻译）；不传则只保留图形反馈 */
  label?: string;
  /** 提示呈现方式。native = 用 title 属性（适用于被 overflow-hidden 裁剪的窄容器） */
  tooltip?: 'custom' | 'native';
  /** 图标主体。默认矢车菊（上栏 / 沉浸悬浮层）；侧栏收起态传入该模块的实时 logo */
  icon?: ReactNode;
  /** 默认矢车菊的尺寸（px）；传入 icon 时不生效 */
  size?: number;
  /** 常态颜色 class（默认沿用上栏的灰绿/暗紫配色） */
  colorClass?: string;
  className?: string;
}

/**
 * logo 样式按钮 — 全应用统一的「图标 + 悬停多重提示」入口。
 * 默认渲染矢车菊，也可传入任意图标（如侧栏收起后的模块实时 logo），交互与提示完全一致。
 *
 * 悬停时同时给出多重提示，确保「看得出这里能点」：
 *   1. 图标放大（矢车菊额外旋转 45°，八瓣对称、旋转后视觉无缝；模块图标不旋转以免歪斜）
 *   2. 图标变为主题强调色
 *   3. 背后柔光光晕浮现
 *   4. 外圈光环描边扩散
 *   5. 底色 chip 浮现
 *   6. 文字标签滑入（native 模式为系统 tooltip）
 */
export function LogoButton({
  onClick,
  label,
  tooltip = 'custom',
  icon,
  size = 18,
  colorClass = 'text-[#8b948a] dark:text-[#9b8fb5]',
  className = '',
}: LogoButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={tooltip === 'native' ? label : undefined}
      className={`group/logo relative flex items-center justify-center rounded-lg p-1 outline-none transition-colors duration-200 hover:bg-[var(--element-muted)] focus-visible:ring-2 focus-visible:ring-[var(--element-bg)] ${className}`}
    >
      {/* 放大与变色放在外层，矢车菊和传入的图标都生效。
          变色同时写 group-hover 与 dark:group-hover —— Tailwind 输出里 dark 变体排在
          group-hover 之后，只写前者会在深色主题下被 dark:text-[#9b8fb5] 压掉。 */}
      <span
        className={`logo-mark relative flex items-center justify-center transition-transform duration-500 ease-out group-hover/logo:scale-110 group-active/logo:scale-95 ${colorClass} group-hover/logo:text-[var(--element-bg)] dark:group-hover/logo:text-[var(--element-bg)]`}
      >
        {/* 柔光光晕 */}
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-1 rounded-full opacity-0 blur-[6px] transition-opacity duration-300 group-hover/logo:opacity-60"
          style={{ background: 'var(--element-bg)' }}
        />
        {/* 外圈光环 */}
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-[3px] scale-75 rounded-full border opacity-0 transition-all duration-300 group-hover/logo:scale-100 group-hover/logo:opacity-100"
          style={{ borderColor: 'var(--element-bg)' }}
        />
        {/* 图标层：relative 保证盖在光晕/光环之上 */}
        <span className="relative flex items-center justify-center">
          {icon ?? (
            <CornflowerMark
              size={size}
              className="logo-mark-rot transition-transform duration-500 ease-out group-hover/logo:rotate-45"
            />
          )}
        </span>
      </span>

      {/* 悬停标签 */}
      {tooltip === 'custom' && label && (
        <span
          role="tooltip"
          className="pointer-events-none absolute left-full top-1/2 z-20 ml-1.5 -translate-x-1 -translate-y-1/2 whitespace-nowrap rounded-md border border-neutral-200/70 bg-white/95 px-2 py-1 text-[11px] font-medium text-neutral-600 opacity-0 shadow-sm backdrop-blur-sm transition-all duration-200 group-hover/logo:translate-x-0 group-hover/logo:opacity-100 dark:border-stone-700/70 dark:bg-stone-800/95 dark:text-stone-300"
        >
          {label}
        </span>
      )}
    </button>
  );
}