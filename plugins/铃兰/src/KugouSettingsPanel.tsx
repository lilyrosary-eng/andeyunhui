import React from "react";
const { useState, useEffect } = React;
import { T } from '../../_shared/pluginRuntime';

function ArrowLeftIcon() {
  return React.createElement('svg', {
    width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round',
  }, [
    React.createElement('line', { key: '1', x1: '19', y1: '12', x2: '5', y2: '12' }),
    React.createElement('polyline', { key: '2', points: '12 19 5 12 12 5' }),
  ]);
}

const QUALITY_KEY = 'kugou.playQuality';
const QUALITY_ORDER: string[] = ['standard', 'high', 'lossless', 'hires'];

function getInitQuality(): string {
  try {
    const v = localStorage.getItem(QUALITY_KEY);
    if (v && QUALITY_ORDER.includes(v)) return v;
  } catch { /* ignore */ }
  return 'standard';
}

function qualityLabel(key: string): string {
  switch (key) {
    case 'standard': return T('music.quality.standard', '标准');
    case 'high': return T('music.quality.high', '高品质');
    case 'lossless': return T('music.quality.lossless', '无损');
    case 'hires': return T('music.quality.hires', 'Hi-Res');
    default: return key;
  }
}

function KugouSettingsPanelInner({ onBack }: { onBack?: () => void }) {
  const [quality, setQuality] = useState<string>(getInitQuality());
  const [openMenu, setOpenMenu] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(QUALITY_KEY, quality); } catch { /* ignore */ }
  }, [quality]);

  const qualityTrigger = React.createElement('button', {
    onClick: () => setOpenMenu(v => !v),
    className: 'flex items-center justify-between w-full px-4 py-3 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] hover:bg-black/5 dark:hover:bg-white/5 transition-colors',
  }, [
    React.createElement('span', { key: 'k', className: 'text-sm text-neutral-600 dark:text-stone-300' }, T('music.settings.playQuality', '播放音质')),
    React.createElement('span', { key: 'v', className: 'text-sm text-neutral-800 dark:text-stone-100 font-medium flex items-center gap-1' }, [
      qualityLabel(quality),
      React.createElement('span', { key: 'chev', className: 'text-neutral-400' }, openMenu ? '▲' : '▼'),
    ]),
  ]);

  const qualityMenu = openMenu
    ? React.createElement('div', { className: 'mt-2 space-y-1' },
        QUALITY_ORDER.map((q) =>
          React.createElement('button', {
            key: q,
            onClick: () => { setQuality(q); setOpenMenu(false); },
            className: `flex items-center justify-between w-full px-4 py-2 rounded-lg text-sm transition-colors ${
              quality === q
                ? 'bg-[var(--element-muted)] text-neutral-800 dark:text-stone-100'
                : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400'
            }`,
          }, [
            React.createElement('span', { key: 'l' }, qualityLabel(q)),
            quality === q ? React.createElement('span', { key: 'c', className: 'text-[var(--element-color-raw)]' }, '✓') : null,
          ]),
        ),
      )
    : null;

  const guestHint = React.createElement('div', { className: 'mt-4 rounded-xl border border-amber-300/40 bg-amber-50/40 dark:bg-amber-900/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300/80' },
    T('music.kugou.guestHint', '游客态：酷狗无需登录即可浏览榜单、搜索与播放，仅部分 VIP 歌曲受限。'),
  );

  const backBtn = onBack
    ? React.createElement('button', {
        onClick: onBack,
        className: 'flex items-center gap-1 text-sm text-neutral-400 dark:text-stone-500 hover:text-[var(--element-color-raw)] transition-colors mb-3',
      }, [
        React.createElement(ArrowLeftIcon, { key: 'i' }),
        React.createElement('span', { key: 't' }, T('music.settings.back', '返回')),
      ])
    : null;

  return React.createElement('div', { className: 'p-6' }, [
    backBtn,
    React.createElement('h2', { key: 'h', className: 'text-lg font-semibold text-neutral-800 dark:text-stone-100 mb-4' }, T('music.settings.title', '模块设置')),
    React.createElement('div', { key: 'sec', className: 'space-y-2' }, qualityTrigger, qualityMenu),
    guestHint,
  ]);
}

export default function KugouSettingsPanel(props: { onBack?: () => void }) {
  return React.createElement(KugouSettingsPanelInner, props);
}
