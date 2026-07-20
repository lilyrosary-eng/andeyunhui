import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

const w = getCurrentWebviewWindow();

// 由 App.tsx 传入的任务栏锚点（物理像素 ax/ay），换算为 CSS 像素定位菜单面板
const params = new URLSearchParams(location.search);
const dpr = window.devicePixelRatio || 1;
const anchorX = Number(params.get('ax') || 0) / dpr;
const anchorY = Number(params.get('ay') || 0) / dpr;
const panelLeft = Math.max(4, Math.min(anchorX - 110, window.innerWidth - 224));
const panelTop = Math.max(4, Math.min(anchorY - 160, window.innerHeight - 170));

const btnStyle: React.CSSProperties = {
  width: '100%',
  textAlign: 'left',
  padding: '9px 12px',
  background: 'transparent',
  border: 'none',
  color: '#e5e5e5',
  fontSize: 13,
  cursor: 'pointer',
  borderRadius: 8,
};

export default function TrayMenu() {
  const [summoning, setSummoning] = useState(false);
  const [quitting, setQuitting] = useState(false);

  // 兜底：极少数未被透明层捕获的外部交互，仍可失焦关闭
  useEffect(() => {
    const un = w.listen('blur', () => w.hide());
    return () => {
      un.then((u) => u());
    };
  }, []);

  const closeSelf = () => w.hide();

  const onSummon = async () => {
    if (summoning || quitting) return;
    setSummoning(true);
    try {
      await invoke('tray_summon_main');
    } finally {
      setSummoning(false);
      closeSelf();
    }
  };

  const onQuit = async () => {
    if (quitting || summoning) return;
    setQuitting(true);
    try {
      await invoke('tray_quit_app');
    } finally {
      setQuitting(false);
      closeSelf();
    }
  };

  return (
    <div
      onClick={closeSelf}
      onContextMenu={(e) => {
        e.preventDefault();
        closeSelf();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100vw',
        height: '100vh',
        background: 'transparent',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          left: panelLeft,
          top: panelTop,
          width: 220,
          background: 'rgba(32, 32, 36, 0.92)',
          backdropFilter: 'blur(10px)',
          borderRadius: 12,
          boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
          padding: 6,
          color: '#e5e5e5',
          fontFamily: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
          fontSize: 13,
          userSelect: 'none',
        }}
      >
        <button
          onClick={onSummon}
          disabled={summoning}
          style={btnStyle}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          {summoning ? '打开中…' : '打开安得云荟'}
        </button>
        <div style={{ height: 1, background: 'rgba(255,255,255,0.1)', margin: '4px 2px' }} />
        <button
          onClick={onQuit}
          disabled={quitting}
          style={btnStyle}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(255,255,255,0.08)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          {quitting ? '退出中…' : '退出'}
        </button>
      </div>
    </div>
  );
}
