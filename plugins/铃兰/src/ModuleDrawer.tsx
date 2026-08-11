/// <reference path="../../global.d.ts" />
import React from "react";
const { useState, useEffect } = React;
import { X } from 'lucide-react';
import { CloudIcon, CheckIcon, MusicIcon, ChevronDownIcon, ChevronRightIcon } from '../../_shared/icons';
import { T, useLang } from '../../_shared/pluginRuntime';

interface ModuleDrawerProps {
  open: boolean;
  onClose: () => void;
}

// 折叠菜单子项（网易云注入功能下的各个部分，对应截图中圈出的内容）
const neteaseItems = [
  {
    label: T('music.moduleDrawer.netease.listenNow'),
    desc: T('music.moduleDrawer.netease.listenNowDesc'),
    icon: React.createElement(MusicIcon, { size: 16 }),
  },
  {
    label: T('music.moduleDrawer.netease.library'),
    desc: T('music.moduleDrawer.netease.libraryDesc'),
    icon: React.createElement(MusicIcon, { size: 16 }),
  },
  {
    label: T('music.moduleDrawer.netease.radio'),
    desc: T('music.moduleDrawer.netease.radioDesc'),
    icon: React.createElement(MusicIcon, { size: 16 }),
  },
  {
    label: T('music.moduleDrawer.netease.search'),
    desc: T('music.moduleDrawer.netease.searchDesc'),
    icon: React.createElement(MusicIcon, { size: 16 }),
  },
  {
    label: T('music.moduleDrawer.netease.login'),
    desc: T('music.moduleDrawer.netease.loginDesc'),
    icon: React.createElement(MusicIcon, { size: 16 }),
  },
];

export function ModuleDrawer({ open, onClose }: ModuleDrawerProps) {
  useLang();
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);
  const [neteaseOpen, setNeteaseOpen] = useState(false);

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

  return (
    <div className="absolute inset-0 z-40 flex justify-end overflow-hidden">
      <div
        className={`absolute inset-0 bg-black/50 transition-opacity duration-300 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={onClose}
      />
      <div
        className={`relative z-50 h-full w-80 bg-transparent shadow-2xl transform transition-transform duration-300 ease-out ${
          visible ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="flex items-center justify-between px-4 py-4 border-b border-neutral-200/60 dark:border-stone-700/60">
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
        <div className="p-4">
          <p className="text-xs font-medium text-neutral-400 dark:text-stone-500 uppercase tracking-wider mb-3">
            {T('music.moduleDrawer.localMusicDesc')}
          </p>
          <button
            className="w-full flex items-center gap-3 rounded-xl bg-[#e8f5e9] dark:bg-[#2a3a2b] px-4 py-3 border border-[#c8e6c9] dark:border-[#3d4f3d] text-left transition-transform active:scale-[0.99]"
            onClick={onClose}
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#4caf50]/10 text-[#4caf50] shrink-0">
              <MusicIcon size={20} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-neutral-800 dark:text-stone-100 truncate">
                {T('music.moduleDrawer.localMusic')}
              </p>
              <p className="text-xs text-neutral-400 dark:text-stone-500 truncate">
                {T('music.moduleDrawer.localMusicDesc')}
              </p>
            </div>
            <div className="flex h-5 w-5 items-center justify-center rounded-full bg-[#4caf50] text-white shrink-0">
              <CheckIcon size={12} />
            </div>
          </button>

          <div className="mt-3">
            <button
              onClick={() => setNeteaseOpen((v) => !v)}
              className="w-full flex items-center gap-3 rounded-xl border border-[#ff8a80]/60 dark:border-[#ff8a80]/40 bg-[#ffebee]/60 dark:bg-[#3e2723]/40 px-4 py-3 text-left transition-colors hover:bg-[#ffcdd2]/70 dark:hover:bg-[#4e342e]/50"
            >
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#f44336]/10 text-[#f44336] dark:text-[#ff8a80] shrink-0">
                <MusicIcon size={18} />
              </div>
              <span className="flex-1 text-sm font-medium text-[#f44336] dark:text-[#ff8a80] truncate">
                {T('music.moduleDrawer.placeholder')}
              </span>
              <div className="text-[#f44336] dark:text-[#ff8a80] shrink-0 transition-transform duration-200">
                {neteaseOpen
                  ? React.createElement(ChevronDownIcon, { size: 18 })
                  : React.createElement(ChevronRightIcon, { size: 18 })}
              </div>
            </button>

            <div
              className={`overflow-hidden transition-all duration-300 ease-out ${
                neteaseOpen ? 'max-h-96 opacity-100 mt-2' : 'max-h-0 opacity-0'
              }`}
            >
              <div className="space-y-1 pl-2">
                {neteaseItems.map((item, idx) => (
                  <button
                    key={idx}
                    className="w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-neutral-100/70 dark:hover:bg-stone-700/50"
                  >
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-200/70 dark:bg-stone-600/50 text-neutral-500 dark:text-stone-300 shrink-0">
                      {item.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-neutral-700 dark:text-stone-200 truncate">
                        {item.label}
                      </p>
                      {item.desc && (
                        <p className="text-xs text-neutral-400 dark:text-stone-500 truncate">
                          {item.desc}
                        </p>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
