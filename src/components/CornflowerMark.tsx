/** 矢车菊八瓣图形的唯一来源 — 上栏、一级导航、沉浸悬浮层共用，避免多处副本各自漂移 */
const PETAL_D = 'M0,-3 C-3,-10 -4,-22 0,-28 C4,-22 3,-10 0,-3 Z';
const PETAL_ANGLES = [0, 45, 90, 135, 180, 225, 270, 315];

export function CornflowerMark({ size = 18, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 60 60"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <g transform="translate(30,30)">
        {PETAL_ANGLES.map((deg) => (
          <path key={deg} d={PETAL_D} transform={`rotate(${deg})`} />
        ))}
        <circle cx="0" cy="-2" r="5" />
        <circle cx="0" cy="-2" r="2.5" fill="currentColor" opacity=".35" />
      </g>
    </svg>
  );
}