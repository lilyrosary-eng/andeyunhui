/// <reference path="../../global.d.ts" />
// 网络视频模块内联 SVG 图标（自包含，避免依赖 _shared/icons 的命名）
import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

function svg(path: React.ReactNode, opts: IconProps & { fill?: boolean } = {}) {
  const { size = 18, className, style, fill = false } = opts;
  return React.createElement('svg', {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: fill ? 'currentColor' : 'none',
    stroke: fill ? 'none' : 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className,
    style,
    children: path,
  });
}

export const CloudIcon = (p: IconProps) =>
  svg([React.createElement('path', { key: '1', d: 'M17.5 19a4.5 4.5 0 0 0 .5-9 6 6 0 0 0-11.6-1.5A4 4 0 0 0 6 19z' })], p);
export const SearchIcon = (p: IconProps) =>
  svg([
    React.createElement('circle', { key: '1', cx: '11', cy: '11', r: '7' }),
    React.createElement('path', { key: '2', d: 'm21 21-4.3-4.3' }),
  ], p);
export const PlayIcon = (p: IconProps) =>
  svg([React.createElement('polygon', { key: '1', points: '6 4 20 12 6 20 6 4' })], p);
export const DownloadIcon = (p: IconProps) =>
  svg([
    React.createElement('path', { key: '1', d: 'M12 3v12' }),
    React.createElement('path', { key: '2', d: 'm7 12 5 5 5-5' }),
    React.createElement('path', { key: '3', d: 'M5 21h14' }),
  ], p);
export const BackIcon = (p: IconProps) =>
  svg([React.createElement('path', { key: '1', d: 'm15 18-6-6 6-6' })], p);
export const GlobeIcon = (p: IconProps) =>
  svg([
    React.createElement('circle', { key: '1', cx: '12', cy: '12', r: '9' }),
    React.createElement('path', { key: '2', d: 'M3 12h18' }),
    React.createElement('path', { key: '3', d: 'M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z' }),
  ], p);
export const FilmIcon = (p: IconProps) =>
  svg([
    React.createElement('rect', { key: '1', x: '3', y: '4', width: '18', height: '16', rx: '2' }),
    React.createElement('path', { key: '2', d: 'M7 4v16M17 4v16M3 9h4M3 15h4M17 9h4M17 15h4' }),
  ], p);
export const CloseIcon = (p: IconProps) =>
  svg([React.createElement('path', { key: '1', d: 'M18 6 6 18M6 6l12 12' })], p);
