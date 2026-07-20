import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { listen } from '@tauri-apps/api/event';
import { openPath } from '@tauri-apps/plugin-opener';
import { X, Inbox } from 'lucide-react';
import { TransferStationPanel, emitDropzoneChange } from '@/components/TransferStationPanel';
import { api, type ImportedFile } from '@/lib/api';

const win = getCurrentWindow();

/**
 * 中转站浮窗子窗口 — 与图标栏「中转站」共享同一后端数据源（dropzone 目录），
 * 后端所有写入/删除命令都会 emit `dropzone-changed`，主窗口与浮窗各自监听后实时刷新，保持一致。
 *
 * 浮窗自身也支持拖入 / 粘贴文件（走与主窗口一致的 addBytesToDropzone），并暴露文本文件的「打开」按钮。
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

  // 浮窗内拖入 / 粘贴文件 → 导入中转站（与主窗口拖放一致）
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
        e.preventDefault();
      }
    };
    const onDrop = async (e: DragEvent) => {
      const dt = e.dataTransfer;
      if (!dt || dt.files.length === 0) return;
      e.preventDefault();
      for (const file of Array.from(dt.files)) {
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          await api.addBytesToDropzone(dataUrl, file.name);
        } catch (err) {
          console.error('[浮窗] 导入失败:', err);
        }
      }
    };
    const onPaste = async (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      // 优先处理剪贴板中的文件
      for (const it of Array.from(items)) {
        if (it.kind === 'file') {
          const file = it.getAsFile();
          if (!file) continue;
          e.preventDefault();
          try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result as string);
              reader.onerror = reject;
              reader.readAsDataURL(file);
            });
            await api.addBytesToDropzone(dataUrl, file.name);
          } catch (err) {
            console.error('[浮窗] 粘贴导入失败:', err);
          }
          return;
        }
      }
      // 纯文本：以 .txt 存入中转站
      const text = e.clipboardData?.getData('text');
      if (text) {
        e.preventDefault();
        const name = `剪贴板_${Date.now()}.txt`;
        const b64 = 'data:text/plain;base64,' + btoa(unescape(encodeURIComponent(text)));
        try {
          await api.addBytesToDropzone(b64, name);
        } catch (err) {
          console.error('[浮窗] 文本粘贴失败:', err);
        }
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('paste', onPaste);
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

  // 浮窗环境无笔记编辑器，文本文件「打开」直接用系统默认应用打开
  const handleOpenReadableFile = async (file: ImportedFile, _content: string) => {
    try {
      if (file.absolutePath) await openPath(file.absolutePath);
    } catch (err) {
      console.error('[浮窗] 打开文件失败:', err);
    }
  };

  return (
    <div
      className="floating-dropzone-root"
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'transparent',
        color: '#23402f',
        fontFamily: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
        fontSize: '13px',
        borderRadius: '16px',
        overflow: 'hidden',
        border: '1px solid rgba(110, 175, 135, 0.55)',
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
          background: 'rgba(208, 232, 214, 0.5)',
          borderBottom: '1px solid rgba(110, 175, 135, 0.4)',
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
            color: 'rgba(35,64,47,0.6)',
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

      {/* 中转站主体（与图标栏共享数据源，自动同步；文本文件可「打开」） */}
      <div style={{ flex: 1, overflow: 'hidden', background: 'rgba(224, 240, 228, 0.45)' }}>
        <TransferStationPanel onOpenReadableFile={handleOpenReadableFile} />
      </div>
    </div>
  );
}

export default FloatingDropzoneView;
