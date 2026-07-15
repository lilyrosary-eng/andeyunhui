import { useEffect, useState, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { Pin, X, Clipboard, Search, Lock } from 'lucide-react';

const appWindow = getCurrentWebviewWindow();

const DRAG_STYLE = { WebkitAppRegion: 'drag' } as React.CSSProperties;
const NO_DRAG_STYLE = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

const CLIP_STORAGE_KEY = 'clipboard_history_v1';

interface ClipItem {
  id: string;
  type: 'text' | 'image';
  content: string;
  preview: string;
  timestamp: number;
  pinned: boolean;
  charCount?: number;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 剪贴板浮窗子窗口 — 透明背景、可拖拽、实时监测剪贴板。
 * 与主面板 ClipboardHistory 共享 localStorage 历史。
 */
export function FloatingClipboardView() {
  const [items, setItems] = useState<ClipItem[]>([]);
  const [search, setSearch] = useState('');
  const [isPinned, setIsPinned] = useState(false);
  const [isFixed, setIsFixed] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; itemId: string } | null>(null);
  const lastTextRef = useRef('');
  const lastImageRef = useRef('');

  // 浮窗透明效果
  useEffect(() => {
    document.body.style.backgroundColor = 'transparent';
    document.documentElement.style.backgroundColor = 'transparent';
  }, []);

  // 从 localStorage 加载历史
  const loadFromStorage = useCallback(() => {
    try {
      const saved = localStorage.getItem(CLIP_STORAGE_KEY);
      if (saved) {
        const parsed: ClipItem[] = JSON.parse(saved);
        setItems(prev => {
          const textIds = new Set(parsed.map(i => i.id));
          const imageItems = prev.filter(i => i.type === 'image' && !textIds.has(i.id));
          return [...parsed, ...imageItems].sort((a, b) => b.timestamp - a.timestamp);
        });
        if (parsed.length > 0 && parsed[0].type === 'text') {
          lastTextRef.current = parsed[0].content;
        }
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    loadFromStorage();
    const onStorage = (e: StorageEvent) => {
      if (e.key === CLIP_STORAGE_KEY) loadFromStorage();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [loadFromStorage]);

  // 轮询剪贴板
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        const img: string | null = await invoke('clipboard_read_image');
        if (img && img !== lastImageRef.current) {
          lastImageRef.current = img;
          lastTextRef.current = '';
          const newItem: ClipItem = {
            id: Date.now() + '_img',
            type: 'image',
            content: img,
            preview: '图片',
            timestamp: Date.now(),
            pinned: false,
          };
          setItems(prev => [newItem, ...prev.filter(i => i.content !== img)].slice(0, 50));
          return;
        }
        const text: string = await invoke('clipboard_read');
        if (text && text !== lastTextRef.current) {
          lastTextRef.current = text;
          lastImageRef.current = '';
          const newItem: ClipItem = {
            id: Date.now() + '_txt',
            type: 'text',
            content: text,
            preview: text.slice(0, 200),
            timestamp: Date.now(),
            pinned: false,
            charCount: text.length,
          };
          setItems(prev => [newItem, ...prev.filter(i => !(i.type === 'text' && i.content === text))].slice(0, 50));
        }
      } catch { /* ignore */ }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // 点击外部关闭右键菜单
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
    };
  }, [contextMenu]);

  /** 切换置顶 */
  const handleTogglePin = useCallback(async () => {
    const next = !isPinned;
    setIsPinned(next);
    try {
      await appWindow.setAlwaysOnTop(next);
    } catch { /* ignore */ }
  }, [isPinned]);

  /** 切换固定（置顶 + 内容区 CSS 穿透；标题栏始终可交互）—— 与笔记浮窗逻辑一致 */
  const handleToggleFix = useCallback(async () => {
    const next = !isFixed;
    setIsFixed(next);
    try {
      await appWindow.setAlwaysOnTop(next);
      if (next) setIsPinned(true);
      else setIsPinned(false);
    } catch { /* ignore */ }
  }, [isFixed]);

  /** 关闭：用 destroy() 强制关闭，不依赖 CloseRequested 事件 */
  const handleClose = useCallback(async () => {
    try {
      await appWindow.destroy();
    } catch {
      try { await appWindow.close(); } catch { /* ignore */ }
    }
  }, []);

  // 复制到剪贴板
  const writeToClipboard = useCallback(async (item: ClipItem) => {
    try {
      if (item.type === 'text') {
        await invoke('clipboard_write', { text: item.content });
        lastTextRef.current = item.content;
        lastImageRef.current = '';
      } else {
        await invoke('clipboard_write_image', { base64Png: item.content });
        lastImageRef.current = item.content;
        lastTextRef.current = '';
      }
      setCopiedId(item.id);
      setTimeout(() => setCopiedId(null), 1200);
    } catch { /* ignore */ }
  }, []);

  // 右键菜单
  const handleContextMenu = useCallback((e: React.MouseEvent, itemId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, itemId });
  }, []);

  // 删除记录
  const deleteItem = useCallback((itemId: string) => {
    setItems(prev => prev.filter(i => i.id !== itemId));
    setContextMenu(null);
    // 同步到 localStorage（只同步文本）
    try {
      const saved = localStorage.getItem(CLIP_STORAGE_KEY);
      if (saved) {
        const parsed: ClipItem[] = JSON.parse(saved);
        const updated = parsed.filter(i => i.id !== itemId);
        localStorage.setItem(CLIP_STORAGE_KEY, JSON.stringify(updated));
      }
    } catch { /* ignore */ }
  }, []);

  // 过滤
  const filtered = search
    ? items.filter(i => i.type === 'text' && i.content.toLowerCase().includes(search.toLowerCase()))
    : items;

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'rgba(30, 30, 35, 0.85)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderRadius: '12px',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
        overflow: 'hidden',
        color: '#e5e5e5',
        fontFamily: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
        fontSize: '13px',
        ...(isFixed ? { pointerEvents: 'none' } : {}),
      }}
    >
      {/* 标题栏 */}
      <div
        data-tauri-drag-region={isFixed ? undefined : ''}
        style={{
          ...(isFixed ? {} : DRAG_STYLE),
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 12px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          cursor: isFixed ? 'default' : 'move',
        }}
      >
        <Clipboard size={14} style={{ opacity: 0.7, flexShrink: 0 }} />
        <span style={{ flex: 1, fontWeight: 600, fontSize: '12px', letterSpacing: '0.5px' }}>
          剪贴板历史
        </span>
        {/* 按钮组 — 必须用 NO_DRAG_STYLE 容器包裹，否则父级 drag-region 会吞掉点击事件 */}
        <div style={NO_DRAG_STYLE} className="flex items-center gap-0.5">
          {/* 置顶 */}
          <button
            onClick={handleTogglePin}
            title={isPinned ? '取消置顶' : '置顶'}
            style={{
              background: 'none',
              border: 'none',
              color: isPinned ? '#fbbf24' : 'rgba(255,255,255,0.5)',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Pin size={13} fill={isPinned ? 'currentColor' : 'none'} />
          </button>
          {/* 固定（置顶+穿透）—— 唯一在 isFixed 时仍可交互的按钮 */}
          <button
            onClick={handleToggleFix}
            title={isFixed ? '取消固定' : '固定（置顶+穿透）'}
            style={{
              background: 'none',
              border: 'none',
              color: isFixed ? '#60a5fa' : 'rgba(255,255,255,0.5)',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              pointerEvents: 'auto',
            }}
          >
            <Lock size={13} fill={isFixed ? 'currentColor' : 'none'} />
          </button>
          {/* 关闭 */}
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
      </div>

      {/* 搜索栏 */}
      <div style={{ padding: '6px 10px', ...NO_DRAG_STYLE }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          background: 'rgba(255,255,255,0.06)',
          borderRadius: '6px',
          padding: '4px 8px',
        }}>
          <Search size={12} style={{ opacity: 0.4, flexShrink: 0 }} />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="搜索…"
            style={{
              flex: 1,
              background: 'none',
              border: 'none',
              outline: 'none',
              color: '#e5e5e5',
              fontSize: '12px',
              fontFamily: 'inherit',
            }}
          />
        </div>
      </div>

      {/* 历史列表 */}
      <div
        style={{
          ...NO_DRAG_STYLE,
          flex: 1,
          overflowY: 'auto',
          padding: '4px 6px',
        }}
      >
        {filtered.length === 0 ? (
          <div style={{
            padding: '24px',
            textAlign: 'center',
            color: 'rgba(255,255,255,0.3)',
            fontSize: '12px',
          }}>
            {search ? '未找到匹配记录' : '暂无历史'}
          </div>
        ) : filtered.map(item => (
          <div
            key={item.id}
            onClick={() => writeToClipboard(item)}
            onContextMenu={(e) => handleContextMenu(e, item.id)}
            style={{
              padding: '6px 8px',
              marginBottom: '2px',
              borderRadius: '6px',
              cursor: 'pointer',
              transition: 'background 0.15s',
              display: 'flex',
              alignItems: 'flex-start',
              gap: '6px',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.06)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
          >
            {item.type === 'image' ? (
              <img
                src={item.content}
                alt=""
                style={{
                  maxWidth: '100%',
                  maxHeight: '80px',
                  borderRadius: '4px',
                  objectFit: 'contain',
                }}
              />
            ) : (
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: '12px',
                  color: copiedId === item.id ? '#4ade80' : '#d4d4d4',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: 'vertical',
                  lineHeight: '1.4',
                }}>
                  {copiedId === item.id ? '✓ 已复制' : item.preview}
                </div>
                <div style={{
                  fontSize: '10px',
                  color: 'rgba(255,255,255,0.3)',
                  marginTop: '2px',
                }}>
                  {formatTime(item.timestamp)}
                  {item.charCount ? ` · ${item.charCount}字` : ''}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 底部状态栏 */}
      <div style={{
        padding: '4px 10px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        fontSize: '10px',
        color: 'rgba(255,255,255,0.3)',
        display: 'flex',
        justifyContent: 'space-between',
        ...NO_DRAG_STYLE,
      }}>
        <span>{filtered.length} 条</span>
        <span>点击复制 · 右键删除</span>
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            background: 'rgba(40, 40, 45, 0.98)',
            backdropFilter: 'blur(16px)',
            border: '1px solid rgba(255, 255, 255, 0.12)',
            borderRadius: '8px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
            padding: '4px',
            zIndex: 9999,
            minWidth: '120px',
            ...NO_DRAG_STYLE,
          }}
          onClick={e => e.stopPropagation()}
        >
          <button
            onClick={() => deleteItem(contextMenu.itemId)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              width: '100%',
              padding: '6px 12px',
              background: 'none',
              border: 'none',
              color: '#ef4444',
              cursor: 'pointer',
              fontSize: '12px',
              fontFamily: 'inherit',
              borderRadius: '4px',
              textAlign: 'left',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(239, 68, 68, 0.12)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'none'; }}
          >
            <X size={13} />
            删除记录
          </button>
        </div>
      )}
    </div>
  );
}

export default FloatingClipboardView;
