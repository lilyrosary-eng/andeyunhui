/// <reference path="../global.d.ts" />
// 在线视图（网络视频 / 网络图片 / 网络站点）里的「云」切换器。
//
// 背景：进入在线视图后侧栏换成了平台列表，原模块标题栏（带「云」按钮）被替换，
// 用户想切换到别的平台/回到本地，只能点 logo 返回 —— 交互不一致。
// 这里把「云按钮 + 站点选择抽屉」封成一套，三处在线视图共用：
//   · 标题栏右侧「云」按钮（与模块页同形同位）；
//   · 抽屉列出「本地」与全部网络站点，选中即切换（不必先返回本地）。
import React from 'react';
import { CloudDrawer, CloudIcon } from './CloudDrawer';

export interface OnlineCloudItem {
  id: string;
  name: string;
  desc?: string;
  accent?: string;
  badge?: string;
}

export interface OnlineCloudSwitchProps {
  open: boolean;
  onClose: () => void;
  /** 抽屉标题，如「网络图片」 */
  title: string;
  /** 分组小标题，如「图片来源」 */
  sectionLabel: string;
  localLabel: string;
  localDesc: string;
  items: OnlineCloudItem[];
  /** 当前选中的站点 id（null = 本地） */
  activeId: string | null;
  onPick: (id: string) => void;
  /** 选「本地」= 退出在线视图 */
  onLocal: () => void;
  footer?: string;
}

/** 标题栏「云」按钮（与笔记/图片/视频模块页的按钮逐字一致） */
export function CloudTitleButton({ open, onClick }: { open: boolean; onClick: () => void }) {
  return React.createElement(
    'button',
    {
      onClick,
      title: '云',
      className: `btn-press flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs transition-colors ${
        open
          ? 'text-[var(--element-color-raw)] bg-[var(--element-muted)]'
          : 'text-neutral-500 dark:text-stone-400 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)]'
      }`,
    },
    React.createElement(CloudIcon, { key: 'i', size: 15 }),
    React.createElement('span', { key: 't' }, '云'),
  );
}

/** 在线视图里的站点选择抽屉 */
export function OnlineCloudSwitch({
  open,
  onClose,
  title,
  sectionLabel,
  localLabel,
  localDesc,
  items,
  activeId,
  onPick,
  onLocal,
  footer,
}: OnlineCloudSwitchProps) {
  return React.createElement(CloudDrawer, {
    open,
    onClose,
    title,
    sectionLabel,
    groups: [
      {
        key: 'local',
        title: localLabel,
        desc: localDesc,
        active: activeId === null,
        onSelect: () => {
          onLocal();
          onClose();
        },
      },
      {
        key: 'network',
        title,
        desc: '官方页面 · 浏览器窗口',
        active: activeId !== null,
        defaultExpanded: true,
        items,
        onPick: (id: string) => {
          onPick(id);
          onClose();
        },
      },
    ],
    footer,
  });
}

export default OnlineCloudSwitch;
