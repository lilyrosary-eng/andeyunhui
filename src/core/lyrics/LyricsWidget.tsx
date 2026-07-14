// 悬浮歌词窗口 — 宿主层面组件，绕开插件加载系统
// 透明背景，歌词文字带阴影描边保证可读性，锁定后点击穿透
import { useState, useEffect, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalSize } from '@tauri-apps/api/dpi';
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

  // 拖拽结束后保存位置 — 事件驱动（onMoved）+ 节流（debounce 400ms）。
  // 旧实现用 setInterval(savePos, 2000) 每 2 秒调用 win.outerPosition()，
  // 当歌词窗口与笔记浮窗都 always_on_top 时，Windows 窗口层级竞争会导致
  // outerPosition() 卡住，定时器堆积未完成 Promise → JS 线程卡死。
  // onMoved 是 Rust 侧推送的事件，不会阻塞 JS 线程。
  // 但 onMoved 在拖动时每像素触发一次，直接 invoke 会导致 IPC 风暴 + 文件 I/O 堆塞，
  // 最终整个应用卡死（右上角按钮、托盘都无响应）。
  // 解决：debounce 400ms，拖动结束后只保存一次。
  const savePosTimerRef = useRef<ReturnType<typeof setTimeout>>(0);
  const isResizingRef = useRef(false); // setSize 期间忽略 onMoved，避免循环
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onMoved(({ payload }) => {
      // setSize 触发的窗口移动不保存
      if (isResizingRef.current) return;
      const x = payload.x;
      const y = payload.y;
      const prev = lastSavedPos.current;
      if (prev && Math.abs(prev.x - x) < 1 && Math.abs(prev.y - y) < 1) return;
      lastSavedPos.current = { x, y };
      // debounce：拖动过程中不写盘，停止移动 400ms 后才保存
      if (savePosTimerRef.current) clearTimeout(savePosTimerRef.current);
      savePosTimerRef.current = setTimeout(() => {
        invoke('save_lyrics_widget_position', { x, y }).catch(() => {});
      }, 400);
    });
    return () => {
      unlisten.then(fn => fn());
      if (savePosTimerRef.current) clearTimeout(savePosTimerRef.current);
    };
  }, []);

  // 窗口高度：基于实际内容测量（scrollHeight，含换行）+ 防抖 setSize
  // 旧实现用固定公式（fontSize * 1.25），不 accounting for 长歌词换行 → 截断
  // 更早的实现用 ResizeObserver 高频 setSize → DWM 卡死
  // 折中方案：歌词内容变化后测量 scrollHeight，300ms 防抖后 setSize，频率安全
  const contentRef = useRef<HTMLDivElement>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout>>(0);
  useEffect(() => {
    const measureAndResize = () => {
      if (!contentRef.current) return;
      const content = contentRef.current;
      // 关键修复：「真实内容宽度」必须脱离父容器约束来测。外层是 w-full(=当前窗口宽，
      // 初始约 400px)，若直接 content.scrollWidth 会在「当前窗口宽」下测量 → 大字号仍被
      // 当前窗口宽卡住、容器不随字体变大、横向截断/换行错乱。临时改为绝对定位使其宽度
      // 由内容本身决定（shrink-to-fit），测完立即还原，无视觉闪烁。
      const prevPosition = content.style.position;
      const prevMaxWidth = content.style.maxWidth;
      content.style.position = 'absolute';
      content.style.maxWidth = 'none';
      const naturalW = content.scrollWidth;
      content.style.position = prevPosition;
      content.style.maxWidth = prevMaxWidth;
      // 桌面歌词最大宽度限制（避免超长歌词把窗口拉到全屏），超出则换行、高度随之增长
      const availW = (typeof window !== 'undefined' && window.screen) ? window.screen.availWidth : 1920;
      // 取消此前固定 1000px 上限：大字号下容器需随文字自然变宽，否则横向被截断。
      // 仅以屏幕 92% 作为安全上限，兼顾「容器随字体变大而变大」与「不占满全屏」。
      const capW = Math.max(240, Math.floor(availW * 0.92));
      const padX = 32; // px-4 左右各 16px
      // textShadow(0 0 16px) + WebkitTextStroke 会向左右各延伸，且随字号增大更明显，
      // 宽度按字号动态补偿，避免大字号下文字边缘（含阴影/描边）被窗口裁切。
      const shadowPadX = Math.ceil(fontSize * 0.5) + 16;
      const w = Math.min(Math.max(naturalW + padX + shadowPadX, 180), capW);
      // 限定内容宽度，超宽歌词换行（高度自然增长），同时避免横向溢出被窗口裁切
      content.style.maxWidth = `${w - padX}px`;
      // scrollHeight 含 py-3 padding(24px) 与换行高度，但不含 textShadow 上下延伸。
      // 旧实现用固定 14px 补偿，大字号时阴影延伸远超 14px → 上/下缘被裁切。
      // 改为随字号动态补偿，从根本上解决「加大字体上下被截断」。
      const actualH = content.scrollHeight;
      const shadowPadY = Math.ceil(fontSize * 0.5) + 8;
      const h = Math.ceil(actualH) + shadowPadY;
      const win = getCurrentWindow();
      isResizingRef.current = true;
      win.setSize(new LogicalSize(w, h)).finally(() => {
        setTimeout(() => { isResizingRef.current = false; }, 100);
      });
    };
    // 防抖 300ms：歌词快速更新时只取最后一次，避免高频 setSize
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(measureAndResize, 300);
    return () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    };
  }, [fontSize, showNextLine, currentLine, nextLine]);

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
      {/* 内容容器：py-3 补偿 textShadow 向上 8px / 向下 6px 的视觉延伸（textShadow 不参与 scrollHeight 计算） */}
      <div ref={contentRef} className="flex flex-col items-center py-3">
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
      </div>

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