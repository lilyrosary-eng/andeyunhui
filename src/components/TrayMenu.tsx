// 托盘右键菜单 — 自定义 UI 窗口（tray-menu），风格与软件主界面一致。
// 仅两个动作：回到主界面、关闭软件。失焦或 Esc 自动收起。
import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Home, Power } from 'lucide-react';

export function TrayMenu() {
  const closeSelf = () => {
    getCurrentWebviewWindow().hide().catch(() => {});
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSelf();
    };
    window.addEventListener('keydown', onKey);
    // 失焦自动收起（点击菜单外区域 / 切换到其他窗口）
    const unBlur = getCurrentWebviewWindow().listen('blur', () => closeSelf());
    return () => {
      window.removeEventListener('keydown', onKey);
      unBlur.then((fn) => fn()).catch(() => {});
    };
  }, []);

  const summon = () => {
    invoke('tray_summon_main').catch(() => {});
  };
  const quit = () => {
    invoke('tray_quit').catch(() => {});
  };

  return (
    <div
      className="w-full h-full flex flex-col rounded-2xl overflow-hidden"
      style={{
        background: 'rgba(22,22,26,0.94)',
        backdropFilter: 'blur(22px)',
        WebkitBackdropFilter: 'blur(22px)',
        border: '1px solid rgba(255,255,255,0.10)',
        boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
        color: '#fff',
        fontFamily: 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif',
      }}
    >
      <div className="px-4 pt-3 pb-2 text-[11px] tracking-[0.18em] text-white/40 select-none">
        安得云荟
      </div>
      <button
        onClick={summon}
        className="flex items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-white/10 active:bg-white/15 transition-colors"
      >
        <Home size={16} className="text-emerald-400" />
        回到主界面
      </button>
      <button
        onClick={quit}
        className="flex items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-red-500/20 active:bg-red-500/30 transition-colors"
      >
        <Power size={16} className="text-red-400" />
        关闭软件
      </button>
    </div>
  );
}
