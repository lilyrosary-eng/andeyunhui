// 网络音乐模块通用顶部栏模板（网易云 / 酷狗 等共用）
//
// 结构固定为：左侧「标题 + 可选返回按钮」，右侧「登录态按钮（点击进入用户页）+ 云按钮（点击打开模块抽屉）」。
// 各网络音乐模块只需传入对应状态与回调，即可复用同一套布局与设计语言，
// 无需每个模块重复实现顶部栏。

import React from 'react';
import { ChevronLeft } from 'lucide-react';
import { CloudIcon } from '../../_shared/icons';

interface MusicHeaderUser {
  // 是否已登录
  loggedIn: boolean;
  // 已登录时的用户昵称（未登录传空串）
  name?: string;
  // 已登录时的头像 URL（可选，缺省用首字母圆形占位）
  avatarUrl?: string;
  // 首字母占位用的字符（通常取昵称首字，缺省「云」）
  initial?: string;
}

interface MusicHeaderProps {
  // 顶部标题（当前子模块名，如「现在就听」「榜单」「搜索」）
  title: React.ReactNode;
  // 可选返回按钮：传入则在标题左侧显示返回箭头，点击触发 onBackToSub
  onBackToSub?: () => void;
  onBackToSubTitle?: string;
  // 右侧登录态按钮点击（进入用户页 / 登录页）
  onUserClick: () => void;
  // 右侧云按钮点击（打开模块抽屉）
  onCloudClick: () => void;
  // 云按钮无障碍提示文案
  cloudTitle?: string;
  // 登录态信息；不传则当成未登录（仅显示「登录」文本）
  user?: MusicHeaderUser;
}

// 已登录态：头像（或首字母占位）+ 昵称
function LoggedUserButton({ user, onClick }: { user: MusicHeaderUser; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="btn-press flex items-center gap-1.5 px-2 py-1 rounded-lg hover:bg-neutral-200/60 dark:hover:bg-stone-800/60 transition-colors"
      title={user.name ? `已登录：${user.name}` : '已登录'}
    >
      {user.avatarUrl ? (
        <img src={user.avatarUrl} alt="" className="w-6 h-6 rounded-full object-cover" />
      ) : (
        <span className="w-6 h-6 rounded-full bg-blue-500/15 text-blue-600 dark:text-blue-400 flex items-center justify-center text-xs font-bold">
          {(user.initial || user.name || '云').slice(0, 1)}
        </span>
      )}
      <span className="text-xs text-neutral-700 dark:text-stone-200 max-w-[80px] truncate">
        {user.name || '已登录'}
      </span>
    </button>
  );
}

// 未登录态：纯文本「登录」
function LoginButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="btn-press text-xs text-neutral-500 dark:text-stone-400 hover:text-blue-600 dark:hover:text-blue-400 px-2 py-1 rounded-lg hover:bg-neutral-200/60 dark:hover:bg-stone-800/60 transition-colors"
    >
      登录
    </button>
  );
}

export function MusicHeader({
  title,
  onBackToSub,
  onBackToSubTitle,
  onUserClick,
  onCloudClick,
  cloudTitle,
  user,
}: MusicHeaderProps) {
  return (
    <div className="shrink-0 flex items-center justify-between min-w-0 px-4 pt-4 pb-2">
      <div className="flex items-center gap-1 min-w-0">
        {onBackToSub && (
          <button
            onClick={onBackToSub}
            className="btn-press flex items-center justify-center p-1.5 -ml-1 rounded-lg text-neutral-500 dark:text-stone-400 hover:bg-neutral-200/60 dark:hover:bg-stone-800/60 transition-colors"
            title={onBackToSubTitle || '返回'}
          >
            <ChevronLeft size={20} />
          </button>
        )}
        <h2 className="text-sm font-semibold text-neutral-800 dark:text-stone-100 truncate min-w-0">
          {title}
        </h2>
      </div>
      <div className="flex items-center gap-2">
        {user && user.loggedIn ? (
          <LoggedUserButton user={user} onClick={onUserClick} />
        ) : (
          <LoginButton onClick={onUserClick} />
        )}
        <button
          onClick={onCloudClick}
          className="btn-press flex items-center justify-center p-2 rounded-lg text-neutral-500 dark:text-stone-400 hover:bg-neutral-200/60 dark:hover:bg-stone-800/60 transition-colors"
          title={cloudTitle || '音乐模块'}
        >
          <CloudIcon size={18} />
        </button>
      </div>
    </div>
  );
}
