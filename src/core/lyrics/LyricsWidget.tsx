// 悬浮歌词窗口 — 宿主层面组件，绕开插件加载系统
// 透明背景，歌词文字带阴影描边保证可读性，锁定后点击穿透
import { useState, useEffect, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';

const LYRICS_EVENT = 'lyrics-update';
const LOCK_ICON_SIZE = 18;

/** 歌词字体大小默认值，可通过事件同步更新 */
const DEFAULT_FONT_SIZE = 28;
const DEFAULT_NEXT_LINE_OPACITY = 0.35;

export function LyricsWidget() {
  const [currentLine, setCurrentLine] = useState('');
  const [nextLine, setNextLine] = useState('');
  const [locked, setLocked] = useState(false);
  const [showLockIcon, setShowLockIcon] = useState(false);
  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem('music_lyrics_font_size');
    return saved ? parseInt(saved, 10) : DEFAULT_FONT_SIZE;
  });
  const [showNextLine, setShowNextLine] = useState(() => {
    const saved = localStorage.getItem('music_lyrics_show_next_line');
    return saved !== null ? saved === 'true' : true;
  });
  const lockTimerRef = useRef<ReturnType<typeof setTimeout>>(0);
  // 记录上一次已保存的位置，避免位置未变化时每 2 秒无谓写盘并打印日志
  const lastSavedPos = useRef<{ x: number; y: number } | null>(null);

  // 监听歌词更新事件
  useEffect(() => {
    const unlisten = listen<{ currentLine: string; nextLine: string }>(
      LYRICS_EVENT,
      (event) => {
        setCurrentLine(event.payload.currentLine);
        setNextLine(event.payload.nextLine);
      },
    );
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // 监听样式配置更新事件
  useEffect(() => {
    const unlisten = listen<{ fontSize?: number; showNextLine?: boolean }>(
      'lyrics-style-update',
      (event) => {
        if (event.payload.fontSize !== undefined) setFontSize(event.payload.fontSize);
        if (event.payload.showNextLine !== undefined) setShowNextLine(event.payload.showNextLine);
      },
    );
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // 读取初始锁定状态
  useEffect(() => {
    invoke<boolean>('get_lyrics_widget_locked').then(setLocked).catch(() => {});
  }, []);

  // 监听锁定状态变更（由主面板或本窗口的锁定按钮触发，保证两端按钮同步）
  useEffect(() => {
    const unlisten = listen<{ locked: boolean }>('lyrics-lock-changed', (event) => {
      setLocked(event.payload.locked);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // 拖拽：mousedown 开始拖拽，mousemove 更新位置，mouseup 结束并保存
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (locked) return;
      e.preventDefault();
      const win = getCurrentWindow();
      win.startDragging().catch(() => {});
    },
    [locked],
  );

  // 初始化已保存位置，避免首次启动就重复写入默认 (100,100)
  useEffect(() => {
    // Rust 返回元组 (f64, f64)，序列化为 JSON 数组 [x, y]
    invoke<[number, number]>('get_lyrics_widget_position')
      .then((p) => { lastSavedPos.current = { x: p[0], y: p[1] }; })
      .catch(() => {});
  }, []);

  // 拖拽结束后保存位置（仅在位置真正变化时保存）
  useEffect(() => {
    if (locked) return;
    const win = getCurrentWindow();
    let timer: ReturnType<typeof setInterval>;

    const savePos = async () => {
      try {
        const pos = await win.outerPosition();
        const prev = lastSavedPos.current;
        if (prev && Math.abs(prev.x - pos.x) < 1 && Math.abs(prev.y - pos.y) < 1) {
          return; // 位置未变化，跳过保存
        }
        lastSavedPos.current = { x: pos.x, y: pos.y };
        invoke('save_lyrics_widget_position', { x: pos.x, y: pos.y }).catch(() => {});
      } catch { /* 窗口可能已关闭 */ }
    };

    // 每 2 秒检测一次位置变化并保存
    timer = setInterval(savePos, 2000);

    return () => clearInterval(timer);
  }, [locked]);

  // 鼠标悬停显示锁图标
  const handleMouseEnter = useCallback(() => {
    if (locked) return;
    setShowLockIcon(true);
  }, [locked]);

  const handleMouseLeave = useCallback(() => {
    if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
    lockTimerRef.current = setTimeout(() => setShowLockIcon(false), 500);
  }, []);

  // 点击锁定/解锁图标：切换歌词窗口锁定状态
  const handleToggleLock = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const newLocked = !locked;
      invoke('set_lyrics_widget_locked', { locked: newLocked }).catch(() => {});
      setLocked(newLocked);
      setShowLockIcon(false);
    },
    [locked],
  );

  return (
    <div
      className="w-full h-full flex flex-col items-center justify-center select-none relative"
      style={{
        background: 'transparent',
        // 锁定态：歌词区鼠标穿透到背后窗口（点击穿透），仅解锁按钮保持可交互
        pointerEvents: locked ? 'none' : 'auto',
      }}
      onMouseDown={handleMouseDown}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* 当前行 */}
      <div
        className="text-center leading-tight px-4 transition-all duration-300"
        style={{
          fontSize: `${fontSize}px`,
          fontWeight: 700,
          color: '#ffffff',
          textShadow: '0 0 8px rgba(0,0,0,0.8), 0 0 16px rgba(0,0,0,0.6), 0 2px 4px rgba(0,0,0,0.5)',
          WebkitTextStroke: '1px rgba(0,0,0,0.3)',
          opacity: currentLine ? 1 : 0,
        }}
      >
        {currentLine || '\u00A0'}
      </div>

      {/* 下一行预览 */}
      {showNextLine && nextLine && (
        <div
          className="text-center leading-tight px-4 mt-1 transition-all duration-300"
          style={{
            fontSize: `${fontSize * 0.7}px`,
            fontWeight: 400,
            color: '#ffffff',
            textShadow: '0 0 6px rgba(0,0,0,0.7), 0 0 12px rgba(0,0,0,0.5), 0 1px 3px rgba(0,0,0,0.4)',
            WebkitTextStroke: '0.5px rgba(0,0,0,0.2)',
            opacity: DEFAULT_NEXT_LINE_OPACITY,
          }}
        >
          {nextLine}
        </div>
      )}

      {/* 锁定/解锁图标：hover 时淡入；锁定态常驻显示并可点击解锁（穿透下仍保持可交互） */}
      <div
        className="absolute top-2 right-2 transition-opacity duration-200"
        style={{
          opacity: locked ? 0.85 : (showLockIcon ? 0.7 : 0),
          pointerEvents: (locked || showLockIcon) ? 'auto' : 'none',
          cursor: 'pointer',
        }}
        // 关键：阻止 mousedown 冒泡到父级（父级 onMouseDown 会触发 startDragging），
        // 否则点击锁定图标会顺带拖动整个歌词窗口
        onMouseDown={(e) => e.stopPropagation()}
        onClick={handleToggleLock}
        title={locked ? '解锁歌词' : '锁定歌词'}
      >
        {locked ? (
          <svg
            width={LOCK_ICON_SIZE}
            height={LOCK_ICON_SIZE}
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.5))' }}
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        ) : (
          <svg
            width={LOCK_ICON_SIZE}
            height={LOCK_ICON_SIZE}
            viewBox="0 0 24 24"
            fill="none"
            stroke="white"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.5))' }}
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 9.9-1" />
          </svg>
        )}
      </div>
    </div>
  );
}