import { type ReactNode } from 'react';

export interface IconButtonProps {
  onClick: () => void;
  title: string;
  active?: boolean;
  children: ReactNode;
}

/** 图标按钮：圆形 hover 高亮样式，供所有模块复用 */
export function IconButton({ onClick, title, active, children }: IconButtonProps) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="btn-press p-1.5 rounded-full transition-all duration-150"
      style={{
        color: active ? 'var(--element-bg)' : undefined,
        background: 'transparent',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'var(--element-muted)';
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
      }}
    >
      {children}
    </button>
  );
}

export default IconButton;