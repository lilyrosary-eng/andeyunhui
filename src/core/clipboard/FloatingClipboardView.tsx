import { useEffect, useState, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Pin, X, Clipboard, Search, Lock, ImageIcon } from 'lucide-react';

const win = getCurrentWindow();

const CLIP_STORAGE_KEY = 'clipboard_history_v1';
const MAX_IMAGE_HISTORY = 5;

interface ClipItem {
  id: string;
  type: 'text' | 'image';
  content: string;       // 文本内容 或 图片临时文件路径
  preview: string;
  timestamp: number;
  pinned: boolean;
  charCount?: number;
  thumbnail?: string;    // 缩略图 data URL（仅图片）
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 剪贴板浮窗子窗口 — 透明背景、可拖拽、实时监测剪贴板。
 * 与主面板 ClipboardHistory 共享 localStorage 历史。
 *
 * 拖拽方案：不使用 data-tauri-drag-region（会吞掉子元素点击），
 * 改用 mousedown → startDragging()，与录屏控制台一致。
 */
export function FloatingClipboardView() {
  const [items, setItems] = useState<ClipItem[]>([]);
  const [search, setSearch] = useState('');
  const [isPinned, setIsPinned] = useState(false);
  const [isFixed, setIsFixed] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; itemId: string } | null>(null);
  // 分类标签：全部 / 文本 / 图片（对应「剪贴板浮窗分两类」需求）
  const [tab, setTab] = useState<'all' | 'text' | 'image'>('all');
  const lastTextRef = useRef('');
  const lastImgHashRef = useRef('');

  // 浮窗透明效果
  useEffect(() => {
    document.body.style.backgroundColor = 'transparent';
    document.documentElement.style.backgroundColor = 'transparent';
  }, []);

  // 从 localStorage 加载文本历史
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

  // 轮询剪贴板（hash 检测，避免每秒读取大图）
  useEffect(() => {
    const id = setInterval(async () => {
      try {
        // 先用轻量 hash 检测图片变化（传入上次已知的 hash，后端比对后仅变化时返回数据）
        const imgInfo: { hash: string; tempPath: string; thumbnail: string } | null =
          await invoke('clipboard_poll_image', { lastHash: lastImgHashRef.current || null });
        if (imgInfo) {
          lastImgHashRef.current = imgInfo.hash;
          lastTextRef.current = '';
          const newItem: ClipItem = {
            id: Date.now() + '_img',
            type: 'image',
            content: imgInfo.tempPath,  // 仅存路径，不存 base64
            preview: '图片',
            timestamp: Date.now(),
            pinned: false,
            thumbnail: imgInfo.thumbnail,
          };
          setItems(prev => {
            const existing = prev.filter(i => !(i.type === 'image' && i.content === imgInfo.tempPath));
            const imageCount = existing.filter(i => i.type === 'image' && !i.pinned).length;
            const trimmed = imageCount >= MAX_IMAGE_HISTORY
              ? existing.filter(i => i.type !== 'image' || i.pinned)
              : existing;
            return [newItem, ...trimmed].slice(0, 50);
          });
          return;
        }
        // 无新图片 → 检测文本
        const text: string = await invoke('clipboard_read');
        if (text && text !== lastTextRef.current) {
          lastTextRef.current = text;
          lastImgHashRef.current = '';
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
    }, 1500);
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
    try { await win.setAlwaysOnTop(next); } catch { /* ignore */ }
  }, [isPinned]);

  /** 切换固定（置顶 + 内容区 CSS 穿透；标题栏始终可交互） */
  const handleToggleFix = useCallback(async () => {
    const next = !isFixed;
    setIsFixed(next);
    try {
      await win.setAlwaysOnTop(next);
      if (next) setIsPinned(true);
      else setIsPinned(false);
    } catch { /* ignore */ }
  }, [isFixed]);

  /** 关闭 */
  const handleClose = useCallback(async () => {
    try { await win.destroy(); }
    catch {
      try { await win.close(); } catch { /* ignore */ }
    }
  }, []);

  // 拖拽：mousedown 启动 startDragging，按钮点击不受影响
  const handleTitleMouseDown = useCallback((e: React.MouseEvent) => {
    // 仅左键拖拽
    if (e.button !== 0) return;
    // 按钮/输入框不触发拖拽
    if ((e.target as HTMLElement).closest('button, input, [data-no-drag]')) return;
    if (isFixed) return;
    void win.startDragging();
  }, [isFixed]);

  // 复制到剪贴板
  const writeToClipboard = useCallback(async (item: ClipItem) => {
    try {
      if (item.type === 'text') {
        await invoke('clipboard_write', { text: item.content });
        lastTextRef.current = item.content;
        lastImgHashRef.current = '';
      } else {
        // 图片：从临时文件路径写入剪贴板
        await invoke('clipboard_write_image_from_path', { path: item.content });
        // 重置 hash，让下次轮询重新检测并更新（避免重复添加）
        lastImgHashRef.current = '';
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
    try {
      const saved = localStorage.getItem(CLIP_STORAGE_KEY);
      if (saved) {
        const parsed: ClipItem[] = JSON.parse(saved);
        const updated = parsed.filter(i => i.id !== itemId);
        localStorage.setItem(CLIP_STORAGE_KEY, JSON.stringify(updated));
      }
    } catch { /* ignore */ }
  }, []);

  // 过滤（先按分类标签，再按搜索关键字）
  const filtered = items.filter((i) => {
    if (tab === 'text' && i.type !== 'text') return false;
    if (tab === 'image' && i.type !== 'image') return false;
    if (search && i.type === 'text' && !i.content.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: 'rgba(30, 30, 35, 0.92)',
        backdropFilter: 'blur(16px)',
        WebkitBackdropFilter: 'blur(16px)',
        borderRadius: '12px',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
        overflow: 'hidden',
        color: '#e5e5e5',
        fontFamily: '-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
        fontSize: '13px',
        // 不再使用 pointerEvents: 'none' 穿透 — 之前固定后内容区无法交互导致"失控"
        // 固定语义简化为：仅置顶，不穿透
      }}
    >
      {/* 标题栏 — mousedown 拖拽，不使用 data-tauri-drag-region */}
      <div
        onMouseDown={handleTitleMouseDown}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '8px 12px',
          borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
          cursor: isFixed ? 'default' : 'move',
          userSelect: 'none',
        }}
      >
        <Clipboard size={14} style={{ opacity: 0.7, flexShrink: 0 }} />
        <span style={{ flex: 1, fontWeight: 600, fontSize: '12px', letterSpacing: '0.5px' }}>
          剪贴板历史
        </span>
        {/* 按钮组 */}
        <div data-no-drag style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
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
          {/* 固定 */}
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
      <div data-no-drag style={{ padding: '6px 10px' }}>
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

      {/* 分类标签：全部 / 文本 / 图片 */}
      <div data-no-drag style={{ display: 'flex', gap: '4px', padding: '0 10px 6px' }}>
        {([['all', '全部'], ['text', '文本'], ['image', '图片']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            style={{
              flex: 1,
              padding: '4px 0',
              fontSize: '12px',
              borderRadius: '6px',
              border: 'none',
              cursor: 'pointer',
              color: tab === k ? '#1e1e23' : 'rgba(255,255,255,0.55)',
              background: tab === k ? '#60a5fa' : 'rgba(255,255,255,0.08)',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 历史列表 */}
      <div
        data-no-drag
        style={{
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
              display: 'flex',
              alignItems: 'flex-start',
              gap: '6px',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.06)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
          >
            {item.type === 'image' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%' }}>
                {item.thumbnail ? (
                  <img
                    src={item.thumbnail}
                    alt="缩略图"
                    loading="lazy"
                    decoding="async"
                    style={{
                      maxWidth: '80px',
                      maxHeight: '60px',
                      borderRadius: '4px',
                      objectFit: 'cover',
                      flexShrink: 0,
                    }}
                  />
                ) : (
                  <div style={{
                    width: '60px',
                    height: '40px',
                    borderRadius: '4px',
                    background: 'rgba(255,255,255,0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}>
                    <ImageIcon size={16} style={{ opacity: 0.4 }} />
                  </div>
                )}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: '12px',
                    color: copiedId === item.id ? '#4ade80' : '#d4d4d4',
                  }}>
                    {copiedId === item.id ? '✓ 已复制图片' : '图片'}
                  </div>
                  <div style={{
                    fontSize: '10px',
                    color: 'rgba(255,255,255,0.3)',
                    marginTop: '2px',
                  }}>
                    {formatTime(item.timestamp)} · 点击复制
                  </div>
                </div>
              </div>
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
      <div data-no-drag style={{
        padding: '4px 10px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        fontSize: '10px',
        color: 'rgba(255,255,255,0.3)',
        display: 'flex',
        justifyContent: 'space-between',
      }}>
        <span>{filtered.length} 条</span>
        <span>点击复制 · 右键删除</span>
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <div
          data-no-drag
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
