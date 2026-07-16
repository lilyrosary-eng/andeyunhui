import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { X, Inbox } from 'lucide-react';
import { TransferStationPanel, emitDropzoneChange } from '@/components/TransferStationPanel';

const win = getCurrentWindow();

/**
 * 中转站浮窗子窗口 — 与图标栏「中转站」共享同一后端数据源（dropzone 目录），
 * 因此两者内容实时同步：在主窗口拖入文件、或浮窗中删除/清空，另一侧都会刷新。
 *
 * 拖拽方案：顶部细条 mousedown → startDragging()，与剪贴板浮窗一致。
 */
export function FloatingDropzoneView() {
  // 浮窗透明效果
  useEffect(() => {
    document.body.style.backgroundColor = 'transparent';
    document.documentElement.style.backgroundColor = 'transparent';
  }, []);

  // 后端写入中转站后会 emit `dropzone-changed`，触发面板重新拉取（与图标栏同步）
  useEffect(() => {
    const un = listen<null>('dropzone-changed', () => {
      emitDropzoneChange();
    });
    return () => {
      void un.then((fn) => fn());
    };
  }, []);

  const handleClose = () => {
    try {
      void win.destroy();
    } catch {
      try {
        void win.close();
      } catch {
        /* ignore */
      }
    }
  };

  const handleTitleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button')) return;
    void win.startDragging();
  };

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'transparent',
        color: '#e5e5e5',
        fontFamily: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
        fontSize: '13px',
      }}
    >
      {/* 顶部拖拽条 + 关闭 */}
      <div
        onMouseDown={handleTitleMouseDown}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          height: '30px',
          flexShrink: 0,
          padding: '0 8px',
          cursor: 'move',
          userSelect: 'none',
          background: 'rgba(20, 20, 22, 0.92)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
        }}
      >
        <Inbox size={14} style={{ opacity: 0.7, flexShrink: 0 }} />
        <span style={{ flex: 1, fontWeight: 600, fontSize: '12px', letterSpacing: '0.5px' }}>
          中转站
        </span>
        <button
          onClick={handleClose}
          title="关闭"
          style={{
            background: 'none',
            border: 'none',
            color: 'rgba(255,255,255,0.5)',
            cursor: 'pointer',
            padding: '4px',
            borderRadius: '4px',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <X size={14} />
        </button>
      </div>

      {/* 中转站主体（与图标栏共享数据源，自动同步） */}
      <div style={{ flex: 1, overflow: 'hidden', background: 'rgba(28, 28, 32, 0.96)' }}>
        <TransferStationPanel />
      </div>
    </div>
  );
}

export default FloatingDropzoneView;
