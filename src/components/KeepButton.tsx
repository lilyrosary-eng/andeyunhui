import React from 'react';

interface KeepButtonProps {
  pinned: boolean;
  onToggle: () => void;
  size?: number;
  title?: string;
}

const GOLD = '#E6C35C';

/**
 * 浮岛「保持」按钮：与「收起」按钮镜像（上箭头 vs 收起的下箭头）。
 * 点击后在保持态下，鼠标离开浮岛也不会自动收起；按下（已保持）时金底高亮以示区别。
 */
export function KeepButton({ pinned, onToggle, size = 28, title }: KeepButtonProps) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      title={title ?? (pinned ? '已保持：鼠标离开不自动收起（点击取消）' : '保持：鼠标离开不自动收起')}
      style={{
        appearance: 'none',
        border: `1px solid ${pinned ? 'rgba(230,195,92,0.65)' : 'rgba(255,255,255,0.12)'}`,
        background: pinned ? 'rgba(230,195,92,0.22)' : 'rgba(255,255,255,0.06)',
        color: pinned ? GOLD : 'rgba(244,244,246,0.7)',
        width: size,
        height: size,
        flex: '0 0 auto',
        borderRadius: 8,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        transition: 'all .15s',
        padding: 0,
      }}
    >
      {/* 上箭头：收起按钮（下箭头）的镜像；保持态金底高亮 */}
      <svg
        width={Math.max(12, size - 12)}
        height={Math.max(12, size - 12)}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6 15l6-6 6 6" />
      </svg>
    </button>
  );
}
