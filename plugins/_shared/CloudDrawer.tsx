/// <reference path="../global.d.ts" />
// 通用「云功能」抽屉（右侧滑出），供笔记 / 图片 / 后续模块复用。
//
// 视觉与交互刻意对齐视频模块 VideoCloudDrawer / 音乐模块 ModuleDrawer：
//   标题栏云图标 + 右侧 w-80 滑出 + 遮罩 + 分组卡片（当前模块 / 云端列表）+ 可展开子项。
// 这样三处入口的「云」按钮、抽屉宽窄、子项样式完全一致，用户只需要学一次。
import React from 'react';

const { useState, useEffect } = React;

// 图标直接定义在本文件，**不从 `./icons` 导入**：
// `_shared/icons.ts` 顶层是 `const React = window.__HOST_REACT__`，而宿主（src/）的
// 静态 import 求值早于 PluginHost 挂载全局的 effect ⇒ 宿主里那个 React 是 undefined，
// 抽屉一渲染就抛错，表现为「笔记模块点云按钮整个白屏」（插件侧因全局已就绪所以正常）。
function SvgIcon({ size = 18, strokeWidth = 2, children }: {
  size?: number; strokeWidth?: number; children: React.ReactNode;
}) {
  return React.createElement('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
    strokeWidth, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, children as never);
}

/** 云图标：路径与视频侧栏「云」按钮同源，保证三处入口看起来是同一个图标。 */
export function CloudIcon(p: { size?: number; className?: string }) {
  return (
    <svg
      width={p?.size || 18}
      height={p?.size || 18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={p?.className}
    >
      <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97 6 6 0 0 0-11.64-2A4 4 0 0 0 6.5 19h11z" />
    </svg>
  );
}

function CheckIcon(p: { size?: number }) {
  return <SvgIcon size={p?.size || 14}><polyline points="20 6 9 17 4 12" /></SvgIcon>;
}

function ChevronDownIcon(p: { size?: number }) {
  return <SvgIcon size={p?.size || 18}><polyline points="6 9 12 15 18 9" /></SvgIcon>;
}

function ChevronRightIcon(p: { size?: number }) {
  return <SvgIcon size={p?.size || 18}><polyline points="9 6 15 12 9 18" /></SvgIcon>;
}

export interface CloudDrawerItem {
  id: string;
  /** 左侧色块里的文字（一般取名称首字/前两字），不传则用名称 */
  glyph?: string;
  name: string;
  desc?: string;
  accent?: string;
  /** 徽标，如「需代理」 */
  badge?: string;
}

export interface CloudDrawerGroup {
  key: string;
  title: string;
  desc?: string;
  icon?: React.ReactNode;
  /** 当前处于该组（高亮 + 勾选） */
  active?: boolean;
  /** 点击组标题（无子项时作为普通切换项） */
  onSelect?: () => void;
  items?: CloudDrawerItem[];
  onPick?: (id: string) => void;
  /** 默认是否展开子项 */
  defaultExpanded?: boolean;
}

export interface CloudDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** 分组上方的小标题，如「视频源」「检索源」 */
  sectionLabel: string;
  groups: CloudDrawerGroup[];
  /** 底部说明（合规/网络提示） */
  footer?: React.ReactNode;
}

function CloseIcon() {
  return React.createElement(
    'svg',
    { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
    React.createElement('path', { d: 'M18 6 6 18M6 6l12 12' }),
  );
}

const ACCENT = {
  text: 'text-[#3b82f6]',
  textDark: 'dark:text-[#60a5fa]',
  bgSoft: 'bg-[#3b82f6]/10',
  bgActive: 'bg-[#eff6ff]/60 dark:bg-[#1e3a5f]/40',
  borderActive: 'border-[#93c5fd]/60 dark:border-[#3b82f6]/40',
  check: 'bg-[#3b82f6]',
};

export function CloudDrawer({ open, onClose, title, sectionLabel, groups, footer }: CloudDrawerProps) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (open) {
      setMounted(true);
      requestAnimationFrame(() => setVisible(true));
      // 打开时默认展开带子项的分组
      const next: Record<string, boolean> = {};
      for (const g of groups) if (g.items?.length) next[g.key] = g.defaultExpanded !== false;
      setExpanded((prev) => ({ ...next, ...prev }));
    } else {
      setVisible(false);
      const timer = setTimeout(() => setMounted(false), 300);
      return () => clearTimeout(timer);
    }
    // groups 每次渲染都是新数组，不能进依赖，否则会反复展开
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!mounted) return null;

  return React.createElement(
    'div',
    { className: 'absolute inset-0 z-40 flex justify-end overflow-hidden' },
    React.createElement('div', {
      className: `absolute inset-0 bg-black/50 transition-opacity duration-300 ${visible ? 'opacity-100' : 'opacity-0'}`,
      onClick: onClose,
    }),
    React.createElement(
      'div',
      {
        className: `relative z-50 h-full w-80 bg-[var(--nav-bg)]/95 backdrop-blur-xl shadow-2xl transform transition-transform duration-300 ease-out flex flex-col ${
          visible ? 'translate-x-0' : 'translate-x-full'
        }`,
      },
      // 标题栏
      React.createElement(
        'div',
        { className: 'shrink-0 flex items-center justify-between px-4 py-4 border-b border-neutral-200/60 dark:border-stone-700/60' },
        React.createElement(
          'div',
          { className: 'flex items-center gap-2' },
          React.createElement(CloudIcon, { size: 18, className: 'text-neutral-700 dark:text-stone-200' }),
          React.createElement('h3', { className: 'text-base font-semibold text-neutral-800 dark:text-stone-100' }, title),
        ),
        React.createElement(
          'button',
          {
            onClick: onClose,
            className:
              'btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200 transition-colors',
            'aria-label': '关闭',
          },
          React.createElement(CloseIcon),
        ),
      ),
      // 分组列表
      React.createElement(
        'div',
        { className: 'flex-1 overflow-y-auto p-4' },
        React.createElement(
          'p',
          { className: 'text-xs font-medium text-neutral-400 dark:text-stone-500 uppercase tracking-wider mb-3' },
          sectionLabel,
        ),
        groups.map((g) => {
          const hasChildren = !!g.items?.length;
          const isExpanded = expanded[g.key] ?? g.defaultExpanded !== false;
          return React.createElement(
            'div',
            { key: g.key, className: 'mt-3' },
            React.createElement(
              'button',
              {
                onClick: () => (hasChildren ? setExpanded((p) => ({ ...p, [g.key]: !isExpanded })) : g.onSelect?.()),
                className: `w-full flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
                  g.active
                    ? `${ACCENT.borderActive} ${ACCENT.bgActive}`
                    : 'border-neutral-200/60 dark:border-stone-700/60 hover:bg-neutral-100/70 dark:hover:bg-stone-700/50'
                }`,
              },
              React.createElement(
                'div',
                {
                  className: `flex h-9 w-9 items-center justify-center rounded-lg shrink-0 ${
                    g.active
                      ? `${ACCENT.bgSoft} ${ACCENT.text} ${ACCENT.textDark}`
                      : 'bg-neutral-200/70 dark:bg-stone-600/50 text-neutral-500 dark:text-stone-300'
                  }`,
                },
                g.icon || React.createElement(CloudIcon, { size: 18 }),
              ),
              React.createElement(
                'span',
                {
                  className: `flex-1 text-sm font-medium truncate ${
                    g.active ? `${ACCENT.text} ${ACCENT.textDark}` : 'text-neutral-700 dark:text-stone-200'
                  }`,
                },
                g.title,
              ),
              g.active &&
                React.createElement(
                  'div',
                  { className: `flex h-5 w-5 items-center justify-center rounded-full ${ACCENT.check} text-white shrink-0` },
                  React.createElement(CheckIcon, { size: 12 }),
                ),
              hasChildren &&
                React.createElement(
                  'div',
                  {
                    className: `shrink-0 transition-transform duration-200 ${
                      g.active ? `${ACCENT.text} ${ACCENT.textDark}` : 'text-neutral-400 dark:text-stone-500'
                    }`,
                  },
                  isExpanded ? React.createElement(ChevronDownIcon, { size: 18 }) : React.createElement(ChevronRightIcon, { size: 18 }),
                ),
            ),
            hasChildren &&
              React.createElement(
                'div',
                {
                  className: `overflow-hidden transition-all duration-300 ease-out ${
                    isExpanded ? 'max-h-96 opacity-100 mt-2' : 'max-h-0 opacity-0'
                  }`,
                },
                React.createElement(
                  'div',
                  { className: 'space-y-1 pl-2' },
                  (g.items || []).map((it) =>
                    React.createElement(
                      'button',
                      {
                        key: it.id,
                        onClick: () => g.onPick?.(it.id),
                        className:
                          'w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-neutral-100/70 dark:hover:bg-stone-700/50',
                      },
                      React.createElement(
                        'div',
                        {
                          className:
                            'flex h-8 w-8 items-center justify-center rounded-lg shrink-0 text-white text-xs font-bold',
                          style: { background: it.accent || '#6b7280' },
                        },
                        it.glyph || it.name.slice(0, 2),
                      ),
                      React.createElement(
                        'div',
                        { className: 'flex-1 min-w-0' },
                        React.createElement(
                          'div',
                          { className: 'flex items-center gap-1.5' },
                          React.createElement(
                            'p',
                            { className: 'text-sm font-medium text-neutral-700 dark:text-stone-200 truncate' },
                            it.name,
                          ),
                          it.badge &&
                            React.createElement(
                              'span',
                              {
                                className:
                                  'shrink-0 rounded px-1 py-[1px] text-[10px] text-amber-600 bg-amber-500/10 dark:text-amber-400',
                              },
                              it.badge,
                            ),
                        ),
                        it.desc &&
                          React.createElement(
                            'p',
                            { className: 'text-xs text-neutral-400 dark:text-stone-500 truncate' },
                            it.desc,
                          ),
                      ),
                    ),
                  ),
                ),
              ),
          );
        }),
        footer &&
          React.createElement(
            'div',
            { className: 'mt-5 px-1 text-[11px] leading-relaxed text-neutral-400 dark:text-stone-500' },
            footer,
          ),
      ),
    ),
  );
}

export default CloudDrawer;
