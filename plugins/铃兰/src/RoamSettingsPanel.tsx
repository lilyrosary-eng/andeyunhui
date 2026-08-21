/// <reference path="../../global.d.ts" />
// 漫游电台独立设置面板
//
// 漫游电台的模块设置独立，不使用铃兰的设置面板。
// 当前包含：自动续推开关、历史记录上限、音质偏好。

import React from "react";
const { useState, useEffect } = React;
import { ChevronLeft } from 'lucide-react';
import { T, useLang } from '../../_shared/pluginRuntime';

const STORAGE_KEY_AUTO_EXTEND = 'roam_auto_extend';
const STORAGE_KEY_HISTORY_LIMIT = 'roam_history_limit';
const STORAGE_KEY_QUALITY = 'roam_quality_pref';
const STORAGE_KEY_THEME_MODE = 'roam_theme_mode'; // 'preset' | 'follow'
const STORAGE_KEY_COVER_FILTER = 'roam_cover_filter'; // 'on' | 'off'
const STORAGE_KEY_BAR_POSITION = 'roam_bar_position'; // 'stage' | 'overlay'

export function RoamSettingsPanel({ onClose }: { onClose: () => void }) {
  useLang();
  const [autoExtend, setAutoExtend] = useState(() => localStorage.getItem(STORAGE_KEY_AUTO_EXTEND) !== 'false');
  const [historyLimit, setHistoryLimit] = useState(() => {
    const v = localStorage.getItem(STORAGE_KEY_HISTORY_LIMIT);
    return v ? parseInt(v, 10) : 100;
  });
  const [quality, setQuality] = useState(() => localStorage.getItem(STORAGE_KEY_QUALITY) || 'auto');
  const [themeMode, setThemeMode] = useState<'preset' | 'follow'>(() => {
    const v = localStorage.getItem(STORAGE_KEY_THEME_MODE);
    return v === 'preset' ? 'preset' : 'follow';
  });
  const [coverFilter, setCoverFilter] = useState<'on' | 'off'>(() => {
    const v = localStorage.getItem(STORAGE_KEY_COVER_FILTER);
    return v === 'off' ? 'off' : 'on';
  });
  const [barPosition, setBarPosition] = useState<'stage' | 'overlay'>(() => {
    const v = localStorage.getItem(STORAGE_KEY_BAR_POSITION);
    return v === 'overlay' ? 'overlay' : 'stage';
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_AUTO_EXTEND, String(autoExtend));
  }, [autoExtend]);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_HISTORY_LIMIT, String(historyLimit));
  }, [historyLimit]);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_QUALITY, quality);
  }, [quality]);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_THEME_MODE, themeMode);
    window.dispatchEvent(new CustomEvent('roam-theme-mode-changed', { detail: themeMode }));
  }, [themeMode]);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_COVER_FILTER, coverFilter);
    window.dispatchEvent(new CustomEvent('roam-cover-filter-changed', { detail: coverFilter }));
  }, [coverFilter]);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_BAR_POSITION, barPosition);
    window.dispatchEvent(new CustomEvent('roam-bar-position-changed', { detail: barPosition }));
  }, [barPosition]);

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-white dark:bg-[#1e1e1e]">
      {/* 头部 */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-3 border-b border-neutral-200/60 dark:border-stone-700/60">
        <button
          onClick={onClose}
          className="btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-neutral-700 dark:hover:text-stone-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
        >
          <ChevronLeft size={18} />
        </button>
        <h2 className="text-base font-semibold text-neutral-800 dark:text-stone-100">漫游设置</h2>
      </div>

      {/* 设置项 */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-md mx-auto space-y-6">
          {/* 自动续推 */}
          <div className="rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60 p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-neutral-700 dark:text-stone-200">自动续推</div>
                <div className="text-xs text-neutral-400 dark:text-stone-500 mt-0.5">
                  播放到队列末尾时自动追加推荐歌曲
                </div>
              </div>
              <button
                onClick={() => setAutoExtend((v) => !v)}
                className={`relative w-11 h-6 rounded-full transition-colors ${
                  autoExtend ? 'bg-[#7c4dff]' : 'bg-neutral-300 dark:bg-stone-600'
                }`}
              >
                <span
                  className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                    autoExtend ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* 历史记录上限 */}
          <div className="rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60 p-4">
            <div className="text-sm font-medium text-neutral-700 dark:text-stone-200 mb-3">历史记录上限</div>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={20}
                max={200}
                step={10}
                value={historyLimit}
                onChange={(e) => setHistoryLimit(parseInt(e.target.value, 10))}
                className="flex-1 accent-[#7c4dff]"
              />
              <span className="text-sm text-neutral-600 dark:text-stone-300 tabular-nums w-12 text-right">
                {historyLimit} 首
              </span>
            </div>
            <div className="text-xs text-neutral-400 dark:text-stone-500 mt-2">
              超过上限时自动删除最早的记录
            </div>
          </div>

          {/* 音质偏好 */}
          <div className="rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60 p-4">
            <div className="text-sm font-medium text-neutral-700 dark:text-stone-200 mb-3">音质偏好</div>
            <div className="space-y-2">
              {[
                { value: 'auto', label: '自动（推荐）', desc: '根据网络状况自动选择' },
                { value: 'standard', label: '标准音质', desc: '流畅播放，节省流量' },
                { value: 'high', label: '高品质', desc: '320kbps' },
                { value: 'lossless', label: '无损音质', desc: 'FLAC，需 VIP（酷狗）' },
              ].map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setQuality(opt.value)}
                  className={`w-full flex items-center justify-between rounded-lg px-3 py-2.5 transition-colors ${
                    quality === opt.value
                      ? 'bg-[#7c4dff]/10 text-[#7c4dff] dark:text-[#b388ff]'
                      : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-300'
                  }`}
                >
                  <div className="text-left">
                    <div className="text-sm font-medium">{opt.label}</div>
                    <div className="text-[10px] text-neutral-400 dark:text-stone-500">{opt.desc}</div>
                  </div>
                  {quality === opt.value && (
                    <div className="w-4 h-4 rounded-full bg-[#7c4dff] flex items-center justify-center shrink-0">
                      <svg width={8} height={8} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={3}>
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>

          {/* 视觉主题 */}
          <div className="rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60 p-4">
            <div className="text-sm font-medium text-neutral-700 dark:text-stone-200 mb-3">视觉主题</div>
            <div className="space-y-2">
              <button
                onClick={() => setThemeMode('follow')}
                className={`w-full flex items-center justify-between rounded-lg px-3 py-2.5 transition-colors ${
                  themeMode === 'follow'
                    ? 'bg-[#7c4dff]/10 text-[#7c4dff] dark:text-[#b388ff]'
                    : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-300'
                }`}
              >
                <div className="text-left">
                  <div className="text-sm font-medium">跟随歌曲</div>
                  <div className="text-[10px] text-neutral-400 dark:text-stone-500">根据当前歌曲封面动态生成配色与主题</div>
                </div>
                {themeMode === 'follow' && (
                  <div className="w-4 h-4 rounded-full bg-[#7c4dff] flex items-center justify-center shrink-0">
                    <svg width={8} height={8} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={3}>
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                )}
              </button>
              <button
                onClick={() => setThemeMode('preset')}
                className={`w-full flex items-center justify-between rounded-lg px-3 py-2.5 transition-colors ${
                  themeMode === 'preset'
                    ? 'bg-[#7c4dff]/10 text-[#7c4dff] dark:text-[#b388ff]'
                    : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-300'
                }`}
              >
                <div className="text-left">
                  <div className="text-sm font-medium">使用预设</div>
                  <div className="text-[10px] text-neutral-400 dark:text-stone-500">轮换薄荷、金阳、湖蓝、粉霞、雪白五套预设主题</div>
                </div>
                {themeMode === 'preset' && (
                  <div className="w-4 h-4 rounded-full bg-[#7c4dff] flex items-center justify-center shrink-0">
                    <svg width={8} height={8} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={3}>
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                )}
              </button>
            </div>
          </div>

          {/* 封面滤镜（仅在跟随歌曲模式下生效） */}
          <div className="rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60 p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-neutral-700 dark:text-stone-200">封面滤镜</div>
                <div className="text-xs text-neutral-400 dark:text-stone-500 mt-0.5">
                  跟随歌曲时，是否对封面应用色相偏移与饱和度调整
                </div>
              </div>
              <button
                onClick={() => setCoverFilter((v) => v === 'on' ? 'off' : 'on')}
                className={`relative w-11 h-6 rounded-full transition-colors ${
                  coverFilter === 'on' ? 'bg-[#7c4dff]' : 'bg-neutral-300 dark:bg-stone-600'
                }`}
              >
                <span
                  className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                    coverFilter === 'on' ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </div>
          </div>

          {/* 播放栏位置 */}
          <div className="rounded-2xl bg-neutral-100/70 dark:bg-stone-800/60 border border-neutral-200/60 dark:border-stone-700/60 p-4">
            <div className="text-sm font-medium text-neutral-700 dark:text-stone-200 mb-3">播放栏位置</div>
            <div className="space-y-2">
              <button
                onClick={() => setBarPosition('stage')}
                className={`w-full flex items-center justify-between rounded-lg px-3 py-2.5 transition-colors ${
                  barPosition === 'stage'
                    ? 'bg-[#7c4dff]/10 text-[#7c4dff] dark:text-[#b388ff]'
                    : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-300'
                }`}
              >
                <div className="text-left">
                  <div className="text-sm font-medium">舞台底部</div>
                  <div className="text-[10px] text-neutral-400 dark:text-stone-500">播放栏横贯整个舞台底部，不与封面重叠</div>
                </div>
                {barPosition === 'stage' && (
                  <div className="w-4 h-4 rounded-full bg-[#7c4dff] flex items-center justify-center shrink-0">
                    <svg width={8} height={8} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={3}>
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                )}
              </button>
              <button
                onClick={() => setBarPosition('overlay')}
                className={`w-full flex items-center justify-between rounded-lg px-3 py-2.5 transition-colors ${
                  barPosition === 'overlay'
                    ? 'bg-[#7c4dff]/10 text-[#7c4dff] dark:text-[#b388ff]'
                    : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-300'
                }`}
              >
                <div className="text-left">
                  <div className="text-sm font-medium">遮罩区内</div>
                  <div className="text-[10px] text-neutral-400 dark:text-stone-500">播放栏嵌入左侧玻璃面板底部</div>
                </div>
                {barPosition === 'overlay' && (
                  <div className="w-4 h-4 rounded-full bg-[#7c4dff] flex items-center justify-center shrink-0">
                    <svg width={8} height={8} viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth={3}>
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                )}
              </button>
            </div>
          </div>

          {/* 说明 */}
          <div className="rounded-2xl bg-[#7c4dff]/5 border border-[#7c4dff]/20 p-4">
            <div className="text-xs text-neutral-500 dark:text-stone-400 leading-relaxed">
              漫游电台从各平台获取推荐歌曲，独立于各平台模块运行。
              切换漫游路径时自动清空历史记录，切换模块时清空所有缓存。
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default RoamSettingsPanel;
