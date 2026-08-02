// 黄金棋盘浮岛共享图标与小型组件（从 Capsule.tsx 抽出，内联 SVG 避免额外依赖）
import { memo, useEffect, useState } from 'react';
import { svgProps, GOLD } from './constants';
import { fmtTime } from './helpers';

export const IconScreenshot = () => (
  <svg {...svgProps}>
    <path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="12.5" r="3.2" />
  </svg>
);
export const IconRecord = () => (
  <svg {...svgProps}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none" />
  </svg>
);
export const IconDropzone = () => (
  <svg {...svgProps}>
    <path d="M4 13l3-7h10l3 7" />
    <path d="M4 13h4l1.5 3h5L16 13h4v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
  </svg>
);
export const IconClipboard = () => (
  <svg {...svgProps}>
    <rect x="6" y="4" width="12" height="17" rx="2" />
    <path d="M9 4a3 3 0 0 1 6 0" />
    <path d="M9 11h6M9 15h6" />
  </svg>
);
export const IconPlay = () => (
  <svg {...svgProps}>
    <path d="M8 5l11 7-11 7z" fill="currentColor" stroke="none" />
  </svg>
);
export const IconPause = () => (
  <svg {...svgProps}>
    <rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" />
    <rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" stroke="none" />
  </svg>
);
export const IconPrev = () => (
  <svg {...svgProps}>
    <path d="M7 5v14" />
    <path d="M19 5L9 12l10 7z" fill="currentColor" stroke="none" />
  </svg>
);
export const IconNext = () => (
  <svg {...svgProps}>
    <path d="M17 5v14" />
    <path d="M5 5l10 7-10 7z" fill="currentColor" stroke="none" />
  </svg>
);
export const IconVolume = () => (
  <svg {...svgProps}>
    <path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor" stroke="none" />
    <path d="M16 9a4 4 0 0 1 0 6" />
  </svg>
);
export const IconVolumeMute = () => (
  <svg {...svgProps}>
    <path d="M4 9v6h4l5 4V5L8 9z" fill="currentColor" stroke="none" />
    <path d="M16 9l5 6M21 9l-5 6" />
  </svg>
);
export const IconChevron = () => (
  <svg {...svgProps} width={16} height={16}>
    <path d="M6 9l6 6 6-6" />
  </svg>
);
export const IconClose = () => (
  <svg {...svgProps} width={16} height={16}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);
export const IconSearchGlass = () => (
  <svg {...svgProps} width={18} height={18}>
    <circle cx="11" cy="11" r="6" />
    <path d="M20 20l-4.5-4.5" />
  </svg>
);
export const IconFolder = () => (
  <svg {...svgProps} width={16} height={16}>
    <path d="M3 6h5l2 2h9a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z" />
  </svg>
);
export const IconFileDoc = () => (
  <svg {...svgProps} width={16} height={16}>
    <path d="M6 3h8l4 4v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" />
    <path d="M14 3v4h4" />
  </svg>
);
export const IconNote = () => (
  <svg {...svgProps} width={18} height={18}>
    <path d="M9 18V5l10-2v13" />
    <circle cx="6" cy="18" r="3" fill="currentColor" stroke="none" />
    <circle cx="16" cy="16" r="3" fill="currentColor" stroke="none" />
  </svg>
);
export const IconBot = () => (
  <svg {...svgProps}>
    <rect x="4" y="8" width="16" height="11" rx="3" />
    <path d="M12 8V4M9 4h6" />
    <circle cx="9" cy="13" r="1.3" fill="currentColor" stroke="none" />
    <circle cx="15" cy="13" r="1.3" fill="currentColor" stroke="none" />
  </svg>
);
export const IconSend = () => (
  <svg {...svgProps} width={18} height={18}>
    <path d="M4 12l16-8-6 16-3-7z" fill="currentColor" stroke="none" />
  </svg>
);
export const IconTransfer = () => (
  <svg {...svgProps} width={18} height={18}>
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 12a9 9 0 0 1-15 6.7L3 16" />
    <path d="M21 4v4h-4M3 20v-4h4" />
  </svg>
);
export const IconDevice = () => (
  <svg {...svgProps} width={16} height={16}>
    <rect x="3" y="5" width="18" height="11" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </svg>
);
// 天气图标：晴/少云用太阳，其余用云
export const IconWeather = ({ code }: { code: number | null }) => {
  const clear = code === 0 || code === 1;
  if (clear) {
    return (
      <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="4.5" fill="currentColor" stroke="none" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  }
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.5A3.5 3.5 0 0 1 17 18z" />
    </svg>
  );
};

export const IconCode = () => (
  <svg viewBox="0 0 24 24" width={18} height={18} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
    <path d="m16 18 6-6-6-6" />
    <path d="m8 6-6 6 6 6" />
  </svg>
);

// 时钟：自带 1s 定时器与自身 state，更新仅限本组件，父级（整棵 Capsule）不再每秒重渲染。
// 这是外部媒体后台播放时浮窗"不丝滑"的核心修复点——此前时钟 setClock 每秒触发整树重渲染。
export const Clock = memo(function Clock() {
  const [t, setT] = useState(fmtTime());
  useEffect(() => {
    const id = setInterval(() => setT(fmtTime()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <span style={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: GOLD }}>
      {t}
    </span>
  );
});

export const ACTIONS = [
  { kind: 'ai', labelKey: 'capsule.action.ai', Icon: IconBot },
  { kind: 'aide', labelKey: 'capsule.action.aide', Icon: IconCode },
  { kind: 'search', labelKey: 'capsule.action.search', Icon: IconSearchGlass },
  { kind: 'screenshot', labelKey: 'capsule.action.screenshot', Icon: IconScreenshot },
  { kind: 'record', labelKey: 'capsule.action.record', Icon: IconRecord },
  { kind: 'dropzone', labelKey: 'capsule.action.dropzone', Icon: IconDropzone },
  { kind: 'clipboard', labelKey: 'capsule.action.clipboard', Icon: IconClipboard },
  { kind: 'transfer', labelKey: 'capsule.action.transfer', Icon: IconTransfer },
] as const;

// 动作分两层：第一排=高频（用户指定）；第二排=其余，后续排满再加「更多」二级入口
export const ACTION_LAYER1 = ['ai', 'screenshot', 'record', 'transfer', 'dropzone', 'clipboard'] as const;
export const ACTION_LAYER2 = ['aide', 'search'] as const;
