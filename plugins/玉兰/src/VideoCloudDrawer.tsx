/// <reference path="../../global.d.ts" />
// 视频模块 · 云功能抽屉（右侧滑出）。
// 设计语言对齐音乐模块 ModuleDrawer：标题栏云图标 + 右侧滑出 + 遮罩 +
// accent 配色卡片（本地视频 / 云端视频）+ 可展开子项。
// 云端视频展开后为各「网络视频平台」入口（哔哩哔哩 / 抖音 / 腾讯视频 / 爱奇艺），
// 点击即进入对应平台的在线视图（原生取流 or 内嵌网页）。
import React from 'react';
const { useState, useEffect } = React;
import {
  CloudIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
} from '../../_shared/icons';
import { useLang } from '../../_shared/pluginRuntime';
import { VIDEO_PLATFORMS } from './online/videoPlatforms';

interface VideoCloudDrawerProps {
  open: boolean;
  onClose: () => void;
  /** 当前是否处于视频模块（本地视频）下，用于高亮「本地视频」项 */
  isLocalActive: boolean;
  /** 打开某个网络视频平台（进入在线视图） */
  onOpenPlatform: (id: string) => void;
}

// 模块项配色主题（与音乐 ModuleDrawer 同构；本地=视频绿，云端=云蓝）
interface AccentSet {
  text: string;
  textDark: string;
  bgSoft: string;
  bgSoftDark: string;
  bgActive: string;
  bgActiveDark: string;
  borderActive: string;
  borderActiveDark: string;
  check: string;
}

const accents = {
  local: {
    text: 'text-[#5a7f5d]',
    textDark: 'dark:text-[#8fbf93]',
    bgSoft: 'bg-[#5a7f5d]/10',
    bgSoftDark: 'dark:bg-[#5a7f5d]/10',
    bgActive: 'bg-[#eaf3ea]/60',
    bgActiveDark: 'dark:bg-[#22341f]/40',
    borderActive: 'border-[#a7c9a9]/60',
    borderActiveDark: 'dark:border-[#5a7f5d]/40',
    check: 'bg-[#5a7f5d]',
  } satisfies AccentSet,
  cloud: {
    text: 'text-[#3b82f6]',
    textDark: 'dark:text-[#60a5fa]',
    bgSoft: 'bg-[#3b82f6]/10',
    bgSoftDark: 'dark:bg-[#3b82f6]/10',
    bgActive: 'bg-[#eff6ff]/60',
    bgActiveDark: 'dark:bg-[#1e3a5f]/40',
    borderActive: 'border-[#93c5fd]/60',
    borderActiveDark: 'dark:border-[#3b82f6]/40',
    check: 'bg-[#3b82f6]',
  } satisfies AccentSet,
};

function CloseIcon() {
  return React.createElement('svg', {
    width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round',
  }, React.createElement('path', { d: 'M18 6 6 18M6 6l12 12' }));
}

interface DrawerModuleItemProps {
  active: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  onSelect?: () => void;
  icon: React.ReactNode;
  title: string;
  desc?: string;
  accent: AccentSet;
  children?: React.ReactNode;
}

// 通用模块切换项：本地视频 / 云端视频 共用同一套布局与交互（对齐音乐 DrawerModuleItem）
function DrawerModuleItem({
  active, expanded, onToggleExpand, onSelect, icon, title, desc, accent, children,
}: DrawerModuleItemProps) {
  const hasChildren = React.Children.count(children) > 0;
  const handleClick = () => {
    if (hasChildren) onToggleExpand?.();
    else onSelect?.();
  };
  return React.createElement('div', { className: 'mt-3' },
    React.createElement('button', {
      onClick: handleClick,
      className: `w-full flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
        active
          ? `${accent.borderActive} ${accent.borderActiveDark} ${accent.bgActive} ${accent.bgActiveDark} hover:brightness-[1.02]`
          : 'border-neutral-200/60 dark:border-stone-700/60 hover:bg-neutral-100/70 dark:hover:bg-stone-700/50'
      }`,
    },
      React.createElement('div', {
        className: `flex h-9 w-9 items-center justify-center rounded-lg shrink-0 ${
          active ? `${accent.bgSoft} ${accent.bgSoftDark} ${accent.text} ${accent.textDark}` : 'bg-neutral-200/70 dark:bg-stone-600/50 text-neutral-500 dark:text-stone-300'
        }`,
      }, icon),
      React.createElement('span', {
        className: `flex-1 text-sm font-medium truncate ${active ? `${accent.text} ${accent.textDark}` : 'text-neutral-700 dark:text-stone-200'}`,
      }, title),
      active && React.createElement('div', {
        className: `flex h-5 w-5 items-center justify-center rounded-full ${accent.check} text-white shrink-0`,
      }, React.createElement(CheckIcon, { size: 12 })),
      hasChildren && React.createElement('div', {
        className: `shrink-0 transition-transform duration-200 ${active ? `${accent.text} ${accent.textDark}` : 'text-neutral-400 dark:text-stone-500'}`,
      }, expanded ? React.createElement(ChevronDownIcon, { size: 18 }) : React.createElement(ChevronRightIcon, { size: 18 })),
    ),
    hasChildren && React.createElement('div', {
      className: `overflow-hidden transition-all duration-300 ease-out ${expanded ? 'max-h-96 opacity-100 mt-2' : 'max-h-0 opacity-0'}`,
    }, React.createElement('div', { className: 'space-y-1 pl-2' }, children)),
  );
}

interface DrawerSubItemProps {
  icon: React.ReactNode;
  title: string;
  desc?: string;
  onClick?: () => void;
}

function DrawerSubItem({ icon, title, desc, onClick }: DrawerSubItemProps) {
  return React.createElement('button', {
    onClick,
    className: 'w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-neutral-100/70 dark:hover:bg-stone-700/50',
  },
    React.createElement('div', { className: 'flex h-8 w-8 items-center justify-center rounded-lg shrink-0 bg-neutral-200/70 dark:bg-stone-600/50 text-neutral-500 dark:text-stone-300' }, icon),
    React.createElement('div', { className: 'flex-1 min-w-0' },
      React.createElement('p', { className: 'text-sm font-medium text-neutral-700 dark:text-stone-200 truncate' }, title),
      desc ? React.createElement('p', { className: 'text-xs text-neutral-400 dark:text-stone-500 truncate' }, desc) : null,
    ),
  );
}

export function VideoCloudDrawer({ open, onClose, isLocalActive, onOpenPlatform }: VideoCloudDrawerProps) {
  useLang();
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const [cloudExpanded, setCloudExpanded] = useState(true);

  useEffect(() => {
    if (open) {
      setMounted(true);
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
      const timer = setTimeout(() => setMounted(false), 300);
      return () => clearTimeout(timer);
    }
  }, [open]);

  if (!mounted) return null;

  return React.createElement('div', { className: 'absolute inset-0 z-40 flex justify-end overflow-hidden' },
    React.createElement('div', {
      className: `absolute inset-0 bg-black/50 transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0'}`,
      onClick: onClose,
    }),
    React.createElement('div', {
      className: `relative z-50 h-full w-80 bg-[var(--nav-bg)]/95 backdrop-blur-xl shadow-2xl transform transition-transform duration-300 ease-out flex flex-col ${visible ? 'translate-x-0' : 'translate-x-full'}`,
    },
      // 标题栏：云图标 + 标题 + 关闭
      React.createElement('div', { className: 'shrink-0 flex items-center justify-between px-4 py-4 border-b border-neutral-200/60 dark:border-stone-700/60' },
        React.createElement('div', { className: 'flex items-center gap-2' },
          React.createElement(CloudIcon, { size: 18, className: 'text-neutral-700 dark:text-stone-200' }),
          React.createElement('h3', { className: 'text-base font-semibold text-neutral-800 dark:text-stone-100' }, '云视频'),
        ),
        React.createElement('button', {
          onClick: onClose,
          className: 'btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200 transition-colors',
          'aria-label': '关闭',
        }, React.createElement(CloseIcon)),
      ),
      React.createElement('div', { className: 'flex-1 overflow-y-auto p-4' },
        React.createElement('p', { className: 'text-xs font-medium text-neutral-400 dark:text-stone-500 uppercase tracking-wider mb-3' }, '视频源'),

        // 本地视频（即当前视频模块）
        React.createElement(DrawerModuleItem, {
          active: isLocalActive,
          onSelect: onClose,
          icon: React.createElement(VideoIconLocal),
          title: '本地视频',
          desc: '本机文件夹扫描',
          accent: accents.local,
        }),

        // 云端视频：可展开，列出各网络视频平台
        React.createElement(DrawerModuleItem, {
          active: false,
          expanded: cloudExpanded,
          onToggleExpand: () => setCloudExpanded((v) => !v),
          icon: React.createElement(CloudIcon, { size: 18 }),
          title: '云端视频',
          accent: accents.cloud,
        },
          VIDEO_PLATFORMS.map((p) => React.createElement(DrawerSubItem, {
            key: p.id,
            icon: React.createElement('div', {
              className: 'flex h-full w-full items-center justify-center rounded-lg text-white text-xs font-bold',
              style: { background: p.accent },
            }, p.name.slice(0, 1)),
            title: p.name,
            desc: p.desc,
            onClick: () => onOpenPlatform(p.id),
          })),
        ),
      ),
    ),
  );
}

// 本地视频图标（与侧栏 VideoIcon 同款描边风）
function VideoIconLocal() {
  return React.createElement('svg', {
    width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, [
    React.createElement('polygon', { key: '1', points: '23 7 16 12 23 17 23 7' }),
    React.createElement('rect', { key: '2', x: '1', y: '5', width: '15', height: '14', rx: '2', ry: '2' }),
  ]);
}

export default VideoCloudDrawer;
