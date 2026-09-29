import { CornflowerMark } from '@/components/CornflowerMark';

interface LogoButtonProps {
  onClick: () => void;
  /** 悬停标签文案（调用方负责翻译）；不传则只保留图形反馈 */
  label?: string;
  /** 图形尺寸（px），默认 18 */
  size?: number;
  /** 花瓣颜色 class（默认沿用上栏的灰绿/暗紫配色） */
  colorClass?: string;
  /** 额外容器 class */
  className?: string;
}

/**
 * 矢车菊 logo 按钮 — 全应用统一的 logo 交互入口（上栏 / 沉浸悬浮层共用）。
 *
 * 悬停时同时给出多重提示，确保「看得出这里能点」：
 *   1. 花瓣放大并旋转 45°（八瓣对称，旋转后视觉无缝）
 *   2. 花瓣由灰绿/暗紫变为主题强调色
 *   3. 背后柔光光晕浮现
 *   4. 外圈光环描边扩散
 *   5. 底色 chip 浮现
 *   6. 右侧文字标签滑入
 */
export function LogoButton({ onClick, label, size = 18, colorClass = 'text-[#8b948a] dark:text-[#9b8fb5]', className = '' }: LogoButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`group/logo relative flex items-center justify-center rounded-lg p-1 outline-none transition-colors duration-200 hover:bg-[var(--element-muted)] focus-visible:ring-2 focus-visible:ring-[var(--element-bg)] ${className}`}
    >
      <span className="relative flex items-center justify-center" style={{ width: size, height: size }}>
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
        {/* 花瓣本体。悬停色同时写 `group-hover/logo:` 与 `dark:group-hover/logo:`：
            Tailwind 输出的规则顺序里 dark 变体排在 group-hover 之后，只写前者会在深色主题下被
            `dark:text-[#9b8fb5]` 压掉；补上 dark 版把特异性抬到 3 个 class，确保两种主题都变色。 */}
        <CornflowerMark
          className={`logo-mark relative transition-transform duration-500 ease-out group-hover/logo:rotate-45 group-hover/logo:scale-110 group-active/logo:scale-95 ${colorClass} group-hover/logo:text-[var(--element-bg)] dark:group-hover/logo:text-[var(--element-bg)]`}
          size={size}
        />
      </span>

      {/* 悬停标签 */}
      {label && (
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