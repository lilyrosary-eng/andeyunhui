/// <reference path="../../global.d.ts" />
import React from "react";
const { useState, useEffect } = React;
import { X } from 'lucide-react';
import { CloudIcon, CheckIcon, MusicIcon, ChevronDownIcon, ChevronRightIcon, ListenNowIcon, LibraryIcon, RadioIcon, SearchIcon, UserIcon, DownloadIcon } from '../../_shared/icons';
import { T, useLang } from '../../_shared/pluginRuntime';
import type { NeteaseProfile } from './neteaseApi';

interface ModuleDrawerProps {
  open: boolean;
  onClose: () => void;
  // 当前是否已切换到网易云模块
  isNeteaseOpen: boolean;
  // 点击「本地音乐」时回调：应关闭网易云并关闭抽屉
  onSelectLocalMusic: () => void;
  // 点击网易云折叠菜单子项时回调：key 为 listen/library/radio/search/downloads/login
  onSelectNetease?: (key: 'listen' | 'library' | 'radio' | 'search' | 'downloads' | 'login') => void;
  // 网易云当前登录资料，null 表示未登录
  neteaseProfile?: NeteaseProfile | null;
  // 当前是否已切换到酷狗音乐模块
  isKugouOpen?: boolean;
  // 点击酷狗折叠菜单子项时回调：key 为 home/roam/search/mine
  onSelectKugou?: (key: 'home' | 'roam' | 'search' | 'mine') => void;
  // 当前是否已切换到汽水音乐模块
  isQishuiOpen?: boolean;
// 点击汽水折叠菜单子项时回调：key 为 listen/library/search/about
onSelectQishui?: (key: 'listen' | 'library' | 'search' | 'about') => void;
}

// 通用首页图标（云按钮折叠菜单复用）
function HomeIcon() {
  return React.createElement('svg', {
    width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, [
    React.createElement('path', { key: '1', d: 'm3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }),
    React.createElement('polyline', { key: '2', points: '9 22 9 12 15 12 15 22' }),
  ]);
}

// 折叠菜单子项（网易云注入功能下的各个部分）
const neteaseItems: { key: 'listen' | 'library' | 'radio' | 'search' | 'login' | 'downloads'; icon: React.ReactElement }[] = [
  { key: 'listen', icon: React.createElement(ListenNowIcon, { size: 16 }) },
  { key: 'library', icon: React.createElement(LibraryIcon, { size: 16 }) },
  { key: 'radio', icon: React.createElement(RadioIcon, { size: 16 }) },
  { key: 'search', icon: React.createElement(SearchIcon, { size: 16 }) },
  { key: 'downloads', icon: React.createElement(DownloadIcon, { size: 16 }) },
  { key: 'login', icon: React.createElement(UserIcon, { size: 16 }) },
];

// 模块项配色主题
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
    text: 'text-[#4caf50]',
    textDark: 'dark:text-[#81c784]',
    bgSoft: 'bg-[#4caf50]/10',
    bgSoftDark: 'dark:bg-[#4caf50]/10',
    bgActive: 'bg-[#e8f5e9]',
    bgActiveDark: 'dark:bg-[#2a3a2b]',
    borderActive: 'border-[#c8e6c9]',
    borderActiveDark: 'dark:border-[#3d4f3d]',
    check: 'bg-[#4caf50]',
  } satisfies AccentSet,
  netease: {
    text: 'text-[#f44336]',
    textDark: 'dark:text-[#ff8a80]',
    bgSoft: 'bg-[#f44336]/10',
    bgSoftDark: 'dark:bg-[#f44336]/10',
    bgActive: 'bg-[#ffebee]/60',
    bgActiveDark: 'dark:bg-[#3e2723]/40',
    borderActive: 'border-[#ff8a80]/60',
    borderActiveDark: 'dark:border-[#ff8a80]/40',
    check: 'bg-[#f44336]',
  } satisfies AccentSet,
  kugou: {
    text: 'text-[#ff7700]',
    textDark: 'dark:text-[#ffb74d]',
    bgSoft: 'bg-[#ff7700]/10',
    bgSoftDark: 'dark:bg-[#ff7700]/10',
    bgActive: 'bg-[#fff3e0]/60',
    bgActiveDark: 'dark:bg-[#3e2e1a]/40',
    borderActive: 'border-[#ffb74d]/60',
    borderActiveDark: 'dark:border-[#ffb74d]/40',
    check: 'bg-[#ff7700]',
  } satisfies AccentSet,
  qishui: {
    text: 'text-[#00c2c7]',
    textDark: 'dark:text-[#4dd0e1]',
    bgSoft: 'bg-[#00c2c7]/10',
    bgSoftDark: 'dark:bg-[#00c2c7]/10',
    bgActive: 'bg-[#e0f7f9]/60',
    bgActiveDark: 'dark:bg-[#1a3a3c]/40',
    borderActive: 'border-[#4dd0e1]/60',
    borderActiveDark: 'dark:border-[#4dd0e1]/40',
    check: 'bg-[#00c2c7]',
  } satisfies AccentSet,
};

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

// 通用模块切换项：本地音乐 / 网易云 / 酷狗 共用同一套布局与交互
function DrawerModuleItem({
  active,
  expanded,
  onToggleExpand,
  onSelect,
  icon,
  title,
  desc,
  accent,
  children,
}: DrawerModuleItemProps) {
  const hasChildren = React.Children.count(children) > 0;

  const handleClick = () => {
    // 带抽屉（子菜单）的项：点击只展开/收起，不自动进入模块，保持其余逻辑不变
    if (hasChildren) {
      onToggleExpand?.();
    } else {
      onSelect?.();
    }
  };

  return (
    <div className="mt-3">
      <button
        onClick={handleClick}
        className={`w-full flex items-center gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
          active
            ? `${accent.borderActive} ${accent.borderActiveDark} ${accent.bgActive} ${accent.bgActiveDark} hover:brightness-[1.02]`
            : 'border-neutral-200/60 dark:border-stone-700/60 hover:bg-neutral-100/70 dark:hover:bg-stone-700/50'
        }`}
      >
        <div className={`flex h-9 w-9 items-center justify-center rounded-lg shrink-0 ${
          active ? `${accent.bgSoft} ${accent.bgSoftDark} ${accent.text} ${accent.textDark}` : 'bg-neutral-200/70 dark:bg-stone-600/50 text-neutral-500 dark:text-stone-300'
        }`}>
          {icon}
        </div>
        <span className={`flex-1 text-sm font-medium truncate ${
          active ? `${accent.text} ${accent.textDark}` : 'text-neutral-700 dark:text-stone-200'
        }`}>
          {title}
        </span>
        {active && (
          <div className={`flex h-5 w-5 items-center justify-center rounded-full ${accent.check} text-white shrink-0`}>
            <CheckIcon size={12} />
          </div>
        )}
        {hasChildren && (
          <div className={`shrink-0 transition-transform duration-200 ${
            active ? `${accent.text} ${accent.textDark}` : 'text-neutral-400 dark:text-stone-500'
          }`}>
            {expanded
              ? React.createElement(ChevronDownIcon, { size: 18 })
              : React.createElement(ChevronRightIcon, { size: 18 })}
          </div>
        )}
      </button>

      {hasChildren && (
        <div
          className={`overflow-hidden transition-all duration-300 ease-out ${
            expanded ? 'max-h-96 opacity-100 mt-2' : 'max-h-0 opacity-0'
          }`}
        >
          <div className="space-y-1 pl-2">
            {children}
          </div>
        </div>
      )}
    </div>
  );
}

// 折叠子项（可复用模板）：网易云 / 酷狗 的子菜单项共用同一套布局
interface DrawerSubItemProps {
  icon: React.ReactNode;
  title: string;
  desc?: string;
  onClick?: () => void;
}

function DrawerSubItem({ icon, title, desc, onClick }: DrawerSubItemProps) {
  return (
    <button
      key={title}
      onClick={onClick}
      className="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-neutral-100/70 dark:hover:bg-stone-700/50"
    >
      <div className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0 bg-neutral-200/70 dark:bg-stone-600/50 text-neutral-500 dark:text-stone-300">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-neutral-700 dark:text-stone-200 truncate">{title}</p>
        {desc ? <p className="text-xs text-neutral-400 dark:text-stone-500 truncate">{desc}</p> : null}
      </div>
    </button>
  );
}

// 酷狗折叠菜单子项（热榜 / 漫游 / 搜索 / 我的）：游客态，漫游=发现流，我的=游客提示
const kugouItems: { key: 'home' | 'roam' | 'search' | 'mine'; icon: React.ReactElement }[] = [
  { key: 'home', icon: React.createElement(HomeIcon, { size: 16 }) },
  { key: 'roam', icon: React.createElement(LibraryIcon, { size: 16 }) },
  { key: 'search', icon: React.createElement(SearchIcon, { size: 16 }) },
  { key: 'mine', icon: React.createElement(UserIcon, { size: 16 }) },
];

// 汽水折叠菜单子项（现在就听 / 漫游 / 搜索 / 关于）：游客态，对齐网易云 tab 结构
const qishuiItems: { key: 'listen' | 'library' | 'search' | 'about'; icon: React.ReactElement }[] = [
{ key: 'listen', icon: React.createElement(ListenNowIcon, { size: 16 }) },
{ key: 'library', icon: React.createElement(LibraryIcon, { size: 16 }) },
{ key: 'search', icon: React.createElement(SearchIcon, { size: 16 }) },
{ key: 'about', icon: React.createElement(UserIcon, { size: 16 }) },
];

export function ModuleDrawer({ open, onClose, isNeteaseOpen, onSelectLocalMusic, onSelectNetease, neteaseProfile, isKugouOpen, onSelectKugou, isQishuiOpen, onSelectQishui }: ModuleDrawerProps) {
  useLang();
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const [neteaseExpanded, setNeteaseExpanded] = useState(isNeteaseOpen);
  const [kugouExpanded, setKugouExpanded] = useState(!!isKugouOpen);
  const [qishuiExpanded, setQishuiExpanded] = useState(!!isQishuiOpen);

  // 修正：本地音乐只有在网易云/酷狗/汽水都未打开时才高亮
  const isLocalActive = !isNeteaseOpen && !isKugouOpen && !isQishuiOpen;

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

  useEffect(() => {
    setNeteaseExpanded(isNeteaseOpen);
  }, [isNeteaseOpen]);

  useEffect(() => {
    setKugouExpanded(!!isKugouOpen);
  }, [isKugouOpen]);

  useEffect(() => {
    setQishuiExpanded(!!isQishuiOpen);
  }, [isQishuiOpen]);

  if (!mounted) return null;

  return (
    <div className="absolute inset-0 z-40 flex justify-end overflow-hidden">
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={onClose}
      />
      <div
        className={`relative z-50 h-full w-80 bg-transparent shadow-2xl transform transition-transform duration-300 ease-out flex flex-col ${
          visible ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="shrink-0 flex items-center justify-between px-4 py-4 border-b border-neutral-200/60 dark:border-stone-700/60">
          <div className="flex items-center gap-2">
            <CloudIcon size={18} className="text-neutral-700 dark:text-stone-200" />
            <h3 className="text-base font-semibold text-neutral-800 dark:text-stone-100">
              {T('music.moduleDrawer.title')}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200 transition-colors"
            aria-label={T('music.moduleDrawer.close')}
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <p className="text-xs font-medium text-neutral-400 dark:text-stone-500 uppercase tracking-wider mb-3">
            {T('music.moduleDrawer.localMusicDesc')}
          </p>

          <DrawerModuleItem
            active={isLocalActive}
            onSelect={() => { onSelectLocalMusic(); onClose(); }}
            icon={React.createElement(MusicIcon, { size: 20 })}
            title={T('music.moduleDrawer.localMusic')}
            desc={T('music.moduleDrawer.localMusicDesc')}
            accent={accents.local}
          />

          <DrawerModuleItem
            active={isNeteaseOpen}
            expanded={neteaseExpanded}
            onToggleExpand={() => setNeteaseExpanded((v) => !v)}
            onSelect={() => { if (onSelectNetease) onSelectNetease('listen'); onClose(); }}
            icon={React.createElement(MusicIcon, { size: 18 })}
            title={T('music.moduleDrawer.placeholder')}
            accent={accents.netease}
          >
            {neteaseItems.map((item) => {
              const isLogin = item.key === 'login';
              const isLoggedIn = isLogin && !!neteaseProfile;
              const title = isLogin
                ? (isLoggedIn ? neteaseProfile!.nickname : (T('music.moduleDrawer.netease.login') || '未登录'))
                : (T(`music.moduleDrawer.netease.${item.key}`) || (item.key === 'library' ? '漫游' : item.key));
              const desc = isLogin
                ? (isLoggedIn ? (T('music.moduleDrawer.netease.loginDesc') || '查看我的账号') : (T('music.moduleDrawer.netease.loginDesc') || '登录 / 注册'))
                : (T(`music.moduleDrawer.netease.${item.key}Desc`) || '');
              const icon = isLogin && neteaseProfile?.avatarUrl
                ? React.createElement('img', { src: neteaseProfile.avatarUrl, alt: '', className: 'w-full h-full rounded-full object-cover' })
                : item.icon;
              return (
                <DrawerSubItem
                  key={item.key}
                  icon={icon}
                  title={title}
                  desc={desc}
                  onClick={() => {
                    if (onSelectNetease) onSelectNetease(item.key);
                    onClose();
                  }}
                />
              );
            })}
          </DrawerModuleItem>

          <DrawerModuleItem
            active={!!isKugouOpen}
            expanded={kugouExpanded}
            onToggleExpand={() => setKugouExpanded((v) => !v)}
            onSelect={() => { if (onSelectKugou) onSelectKugou('home'); onClose(); }}
            icon={React.createElement(MusicIcon, { size: 18 })}
            title={T('music.moduleDrawer.kugou.title') || '酷狗音乐'}
            accent={accents.kugou}
          >
            {kugouItems.map((item) => {
              const titleKey = item.key === 'home' ? 'music.moduleDrawer.kugou.home'
                : item.key === 'roam' ? 'music.moduleDrawer.kugou.roam'
                : item.key === 'search' ? 'music.moduleDrawer.kugou.search'
                : 'music.moduleDrawer.kugou.mine';
              const descKey = item.key === 'home' ? 'music.moduleDrawer.kugou.homeDesc'
                : item.key === 'roam' ? 'music.moduleDrawer.kugou.roamDesc'
                : item.key === 'search' ? 'music.moduleDrawer.kugou.searchDesc'
                : 'music.moduleDrawer.kugou.mineDesc';
              const titleDefault = item.key === 'home' ? '热榜'
                : item.key === 'roam' ? '漫游'
                : item.key === 'search' ? '搜索'
                : '我的';
              const descDefault = item.key === 'home' ? '官方榜单 / 为你推荐'
                : item.key === 'roam' ? '发现好歌无限流'
                : item.key === 'search' ? '找歌找专辑'
                : '登录查看收藏 / 歌单';
              const title = T(titleKey) || titleDefault;
              const desc = T(descKey) || descDefault;
              return (
                <DrawerSubItem
                  key={item.key}
                  icon={item.icon}
                  title={title}
                  desc={desc}
                  onClick={() => {
                    if (onSelectKugou) onSelectKugou(item.key);
                    onClose();
                  }}
                />
              );
            })}
          </DrawerModuleItem>

          <DrawerModuleItem
            active={!!isQishuiOpen}
            expanded={qishuiExpanded}
            onToggleExpand={() => setQishuiExpanded((v) => !v)}
            onSelect={() => { if (onSelectQishui) onSelectQishui('listen'); onClose(); }}
            icon={React.createElement(MusicIcon, { size: 18 })}
            title={T('music.moduleDrawer.qishui.title') || '汽水音乐'}
            accent={accents.qishui}
          >
            {qishuiItems.map((item) => {
              const titleKey = item.key === 'listen' ? 'music.moduleDrawer.qishui.listen'
                : item.key === 'library' ? 'music.moduleDrawer.qishui.library'
                : item.key === 'search' ? 'music.moduleDrawer.qishui.search'
                : 'music.moduleDrawer.qishui.about';
              const descKey = item.key === 'listen' ? 'music.moduleDrawer.qishui.listenDesc'
                : item.key === 'library' ? 'music.moduleDrawer.qishui.libraryDesc'
                : item.key === 'search' ? 'music.moduleDrawer.qishui.searchDesc'
                : 'music.moduleDrawer.qishui.aboutDesc';
              const titleDefault = item.key === 'listen' ? '现在就听'
                : item.key === 'library' ? '漫游'
                : item.key === 'search' ? '搜索'
                : '关于';
              const descDefault = item.key === 'listen' ? '推荐歌单 / 热门榜单'
                : item.key === 'library' ? '发现更多歌单'
                : item.key === 'search' ? '找歌找专辑'
                : '游客态说明';
              const title = T(titleKey) || titleDefault;
              const desc = T(descKey) || descDefault;
              return (
                <DrawerSubItem
                  key={item.key}
                  icon={item.icon}
                  title={title}
                  desc={desc}
                  onClick={() => {
                    if (onSelectQishui) onSelectQishui(item.key);
                    onClose();
                  }}
                />
              );
            })}
          </DrawerModuleItem>
        </div>
      </div>
    </div>
  );
}
