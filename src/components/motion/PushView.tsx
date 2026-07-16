import { useState, useEffect, type ReactNode } from 'react';

interface PushViewProps {
  activeKey: string;
  children: ReactNode;
  className?: string;
}

// 推进滑动：activeKey 变化时，新视图从右侧滑入（用于列表 ↔ 详情 ↔ 设置 的转场）。
export function PushView({ activeKey, children, className = '' }: PushViewProps) {
  const [renderedKey, setRenderedKey] = useState(activeKey);
  const [animating, setAnimating] = useState(false);

  useEffect(() => {
    if (activeKey !== renderedKey) {
      setAnimating(true);
      setRenderedKey(activeKey);
      const t = window.setTimeout(() => setAnimating(false), 300);
      return () => window.clearTimeout(t);
    }
  }, [activeKey, renderedKey]);

  return (
    <div className={`${className} ${animating ? 'slide-in-right' : ''}`}>{children}</div>
  );
}

export default PushView;
