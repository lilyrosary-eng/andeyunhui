import { useState, useRef, type ReactNode, type ElementType, type MouseEvent } from 'react';

type RippleInst = { key: number; x: number; y: number; size: number };

interface RippleProps {
  as?: ElementType;
  className?: string;
  children?: ReactNode;
  color?: string;
  onClick?: (e: MouseEvent) => void;
  [key: string]: any;
}

// 按压波纹：点击时在落点生成水波扩散。兼容 reduced-motion（CSS 关闭 .ripple-dot）。
export function Ripple({
  as = 'button',
  className = '',
  children,
  color,
  onClick,
  ...rest
}: RippleProps) {
  const [drops, setDrops] = useState<RippleInst[]>([]);
  const hostRef = useRef<HTMLElement | null>(null);

  const handleClick = (e: MouseEvent) => {
    const el = hostRef.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height) * 2;
      const x = (e.clientX ?? rect.left + rect.width / 2) - rect.left - size / 2;
      const y = (e.clientY ?? rect.top + rect.height / 2) - rect.top - size / 2;
      const key = Date.now() + Math.random();
      setDrops((prev) => [...prev, { key, x, y, size }]);
      window.setTimeout(() => {
        setDrops((prev) => prev.filter((d) => d.key !== key));
      }, 600);
    }
    onClick?.(e as any);
  };

  const Tag = as as ElementType;
  return (
    <Tag
      ref={hostRef}
      className={`ripple-host ${className}`}
      onClick={handleClick}
      style={color ? ({ ['--ripple-color' as any]: color } as any) : undefined}
      {...rest}
    >
      {children}
      {drops.map((d) => (
        <span
          key={d.key}
          className="ripple-dot"
          style={{ left: d.x, top: d.y, width: d.size, height: d.size }}
        />
      ))}
    </Tag>
  );
}

export default Ripple;
