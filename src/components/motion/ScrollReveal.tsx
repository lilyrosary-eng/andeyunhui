import { useRef, useState, useEffect, type ReactNode, type ElementType } from 'react';

interface ScrollRevealProps {
  children: ReactNode;
  delay?: number;
  className?: string;
  as?: ElementType;
  [key: string]: any;
}

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// 滚动联动 / 错峰进入：进入视口时带延迟上滑淡入（用于分类列表、卡片网格等）。
export function ScrollReveal({
  children,
  delay = 0,
  className = '',
  as = 'div',
  ...rest
}: ScrollRevealProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [visible, setVisible] = useState(prefersReduced());

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReduced()) {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          io.disconnect();
        }
      },
      { threshold: 0.08, rootMargin: '0px 0px -8% 0px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const Tag = as as ElementType;
  const reduce = prefersReduced();
  return (
    <Tag
      ref={ref}
      className={className}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(10px)',
        transition: reduce
          ? 'none'
          : `opacity 0.45s ease ${delay}ms, transform 0.45s ease ${delay}ms`,
        ...(rest.style || {}),
      }}
      {...rest}
    >
      {children}
    </Tag>
  );
}

export default ScrollReveal;
