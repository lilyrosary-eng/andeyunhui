// 黄金棋盘浮岛共享常量与静态装饰层（从 Capsule.tsx 抽出）
import type React from 'react';

// 收起态窗口尺寸（逻辑像素）：高 50%、长 75%（相对上一版 320×72）
export const CAPSULE_W = 240;
export const CAPSULE_H = 36;
// 展开态尺寸：比收起态更宽，向左右延展；高度按模式区分
export const EXPANDED_W = 460;
export const EXPANDED_H = 340; // 播放器模式
export const CHAT_H = 460; // 对话模式（更高，容纳消息列表）
export const SEARCH_H = 470;
export const TRANSFER_H = 470; // 搜索模式（容纳结果列表）
export const TOP_Y = 6;

export const GOLD = '#e6c35c';

export const svgProps = {
  width: 20,
  height: 20,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const btnBase: React.CSSProperties = {
  appearance: 'none',
  border: 'none',
  background: 'transparent',
  color: GOLD,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  borderRadius: 10,
  transition: 'background 140ms ease, transform 140ms ease',
};

// 黑白棋盘底纹（深色半透明底叠半透明白格），放大 3 倍、整体倾斜 30°，呼应「黄金棋盘」主题；
// 放大覆盖 (-80%) 确保宽扁的胶囊在 30° 旋转后仍被完整覆盖；整体保持半透明，桌面可透出。
const checkerLayerStyle: React.CSSProperties = {
  position: 'absolute',
  inset: '-80%',
  transform: 'rotate(30deg) translateZ(0)',
  backgroundColor: 'rgba(18,18,20,0.45)',
  backgroundImage: `
    linear-gradient(45deg, rgba(245,245,245,0.16) 25%, transparent 25%),
    linear-gradient(-45deg, rgba(245,245,245,0.16) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgba(245,245,245,0.16) 75%),
    linear-gradient(-45deg, transparent 75%, rgba(245,245,245,0.16) 75%)
  `,
  backgroundSize: '66px 66px',
  backgroundPosition: '0 0, 0 33px, 33px -33px, -33px 0',
  // 提升为独立合成层，避免父级每次重渲染都重新合成这块大渐变（透明浮窗关键性能点）
  willChange: 'transform',
  backfaceVisibility: 'hidden',
};

// 轻暗叠层（与棋盘底纹同为静态装饰，整段抽到模块级常量，渲染时复用同一元素引用，
// React 直接跳过其协调，进一步降低透明浮窗重渲染开销）
const darkOverlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'linear-gradient(160deg, rgba(8,8,8,0.16), rgba(8,8,8,0.26))',
  borderRadius: 'inherit',
  pointerEvents: 'none',
};

export const DECO_LAYERS = (
  <>
    <div style={checkerLayerStyle} />
    <div style={darkOverlayStyle} />
  </>
);
