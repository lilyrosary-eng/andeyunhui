/// <reference path="../global.d.ts" />

import React from "react";

// =============================================
// 插件共享图标 — 统一使用 React.createElement('svg', ...)
// 所有插件从此文件导入图标，避免重复定义
// 遵循 lucide 风格的 SVG 路径，保持视觉一致性
// =============================================

const React = window.__HOST_REACT__;

// ========== SVG 基础工厂 ==========

function SvgEl({
  size = 20, fill = 'none', strokeWidth = 2, children,
}: {
  size?: number; fill?: string; strokeWidth?: number; children: React.ReactNode;
}) {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 24 24',
    fill, stroke: 'currentColor', strokeWidth,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  }, children as any);
}

// ========== 播放控制 ==========

export function PlayIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 22, fill: 'currentColor', children: [
    React.createElement('polygon', { key: 'a', points: '5 3 19 12 5 21 5 3' }),
  ] });
}

export function PauseIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 22, fill: 'currentColor', children: [
    React.createElement('rect', { key: 'a', x: '6', y: '4', width: '4', height: '16' }),
    React.createElement('rect', { key: 'b', x: '14', y: '4', width: '4', height: '16' }),
  ] });
}

export function SkipBackIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 20, children: [
    React.createElement('polygon', { key: 'a', points: '19 20 9 12 19 4 19 20' }),
    React.createElement('line', { key: 'b', x1: '5', y1: '19', x2: '5', y2: '5' }),
  ] });
}

export function SkipForwardIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 20, children: [
    React.createElement('polygon', { key: 'a', points: '5 4 15 12 5 20 5 4' }),
    React.createElement('line', { key: 'b', x1: '19', y1: '5', x2: '19', y2: '19' }),
  ] });
}

// ========== 音量 ==========

export function VolumeIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 18, children: [
    React.createElement('polygon', { key: 'a', points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5' }),
    React.createElement('path', { key: 'b', d: 'M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07' }),
  ] });
}

export function VolumeMuteIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 18, children: [
    React.createElement('polygon', { key: 'a', points: '11 5 6 9 2 9 2 15 6 15 11 19 11 5' }),
    React.createElement('line', { key: 'b', x1: '23', y1: '9', x2: '17', y2: '15' }),
    React.createElement('line', { key: 'c', x1: '17', y1: '9', x2: '23', y2: '15' }),
  ] });
}

// ========== 播放模式 ==========

export function ListIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 18, children: [
    React.createElement('line', { key: '1', x1: '8', y1: '6', x2: '21', y2: '6' }),
    React.createElement('line', { key: '2', x1: '8', y1: '12', x2: '21', y2: '12' }),
    React.createElement('line', { key: '3', x1: '8', y1: '18', x2: '21', y2: '18' }),
    React.createElement('line', { key: '4', x1: '3', y1: '6', x2: '3.01', y2: '6' }),
    React.createElement('line', { key: '5', x1: '3', y1: '12', x2: '3.01', y2: '12' }),
    React.createElement('line', { key: '6', x1: '3', y1: '18', x2: '3.01', y2: '18' }),
  ] });
}

export function SingleIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 18, children: [
    React.createElement('line', { key: '1', x1: '8', y1: '12', x2: '21', y2: '12' }),
    React.createElement('line', { key: '2', x1: '8', y1: '12', x2: '8.01', y2: '12' }),
    React.createElement('path', { key: '3', d: 'M14 19V5L8 12l6 7' }),
  ] });
}

export function ShuffleIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 18, children: [
    React.createElement('path', { key: 'a', d: 'M16 3h5v5' }),
    React.createElement('path', { key: 'b', d: 'M4 20L21 3' }),
    React.createElement('path', { key: 'c', d: 'M21 16v5h-5' }),
    React.createElement('path', { key: 'd', d: 'M15 15l6 6' }),
    React.createElement('path', { key: 'e', d: 'M4 4l5 5' }),
  ] });
}

export function RepeatIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 18, children: [
    React.createElement('path', { key: 'a', d: 'm17 2 4 4-4 4' }),
    React.createElement('path', { key: 'b', d: 'M3 11v-1a4 4 0 0 1 4-4h14' }),
    React.createElement('path', { key: 'c', d: 'm7 22-4-4 4-4' }),
    React.createElement('path', { key: 'd', d: 'M21 13v1a4 4 0 0 1-4 4H3' }),
  ] });
}

export function Repeat1Icon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 18, children: [
    React.createElement('path', { key: 'a', d: 'm17 2 4 4-4 4' }),
    React.createElement('path', { key: 'b', d: 'M3 11v-1a4 4 0 0 1 4-4h14' }),
    React.createElement('path', { key: 'c', d: 'm7 22-4-4 4-4' }),
    React.createElement('path', { key: 'd', d: 'M21 13v1a4 4 0 0 1-4 4H3' }),
    React.createElement('path', { key: 'e', d: 'M11 10h1v4' }),
  ] });
}

// ========== 通用 ==========

export function MusicIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 24, strokeWidth: 1.5, children: [
    React.createElement('path', { key: 'a', d: 'M9 18V5l12-2v13' }),
    React.createElement('circle', { key: 'b', cx: '6', cy: '18', r: '3' }),
    React.createElement('circle', { key: 'c', cx: '18', cy: '16', r: '3' }),
  ] });
}

export function LyricsIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 18, children: [
    React.createElement('path', { key: 'a', d: 'M4 17h4' }),
    React.createElement('path', { key: 'b', d: 'M4 13h7' }),
    React.createElement('path', { key: 'c', d: 'M4 9h10' }),
    React.createElement('path', { key: 'd', d: 'M15 6l3 3-3 3' }),
  ] });
}

export function LockIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 18, children: [
    React.createElement('rect', { key: 'a', x: '3', y: '11', width: '18', height: '11', rx: '2', ry: '2' }),
    React.createElement('path', { key: 'b', d: 'M7 11V7a5 5 0 0 1 10 0v4' }),
  ] });
}

export function UnlockIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 18, children: [
    React.createElement('rect', { key: 'a', x: '3', y: '11', width: '18', height: '11', rx: '2', ry: '2' }),
    React.createElement('path', { key: 'b', d: 'M7 11V7a5 5 0 0 1 9.9-1' }),
  ] });
}

export function FullscreenIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 18, children: [
    React.createElement('polyline', { key: 'a', points: '15 3 21 3 21 9' }),
    React.createElement('polyline', { key: 'b', points: '9 21 3 21 3 15' }),
    React.createElement('line', { key: 'c', x1: '21', y1: '3', x2: '14', y2: '10' }),
    React.createElement('line', { key: 'd', x1: '3', y1: '21', x2: '10', y2: '14' }),
  ] });
}

export function MinimizeIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 18, children: [
    React.createElement('path', { key: 'a', d: 'M8 3v3a2 2 0 0 1-2 2H3' }),
    React.createElement('path', { key: 'b', d: 'M21 8h-3a2 2 0 0 1-2-2V3' }),
    React.createElement('path', { key: 'c', d: 'M3 16h3a2 2 0 0 1 2 2v3' }),
    React.createElement('path', { key: 'd', d: 'M16 21v-3a2 2 0 0 1 2-2h3' }),
  ] });
}

export function ArrowLeftIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 18, children: [
    React.createElement('polyline', { key: 'a', points: '15 18 9 12 15 6' }),
  ] });
}

export function SearchIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 14, children: [
    React.createElement('circle', { key: 'a', cx: '11', cy: '11', r: '8' }),
    React.createElement('line', { key: 'b', x1: '21', y1: '21', x2: '16.65', y2: '16.65' }),
  ] });
}

export function PlusIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 16, children: [
    React.createElement('line', { key: 'a', x1: '12', y1: '5', x2: '12', y2: '19' }),
    React.createElement('line', { key: 'b', x1: '5', y1: '12', x2: '19', y2: '12' }),
  ] });
}

export function CheckIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 14, children: [
    React.createElement('polyline', { key: 'a', points: '20 6 9 17 4 12' }),
  ] });
}

export function MoreIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 14, children: [
    React.createElement('circle', { key: 'a', cx: '12', cy: '12', r: '1' }),
    React.createElement('circle', { key: 'b', cx: '19', cy: '12', r: '1' }),
    React.createElement('circle', { key: 'c', cx: '5', cy: '12', r: '1' }),
  ] });
}

export function FolderIcon(p: { size?: number }) {
  return SvgEl({ size: p?.size || 16, strokeWidth: 1.5, children: [
    React.createElement('path', { key: 'a', d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' }),
  ] });
}