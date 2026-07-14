// 悬浮歌词窗口 — 宿主层面组件，绕开插件加载系统
// 透明背景，歌词文字带阴影描边保证可读性，锁定后点击穿透
import { useState, useEffect, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalSize, PhysicalPosition } from '@tauri-apps/api/dpi';
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

  // 窗口尺寸：基于实际内容测量（换行后真实高度）+ 防抖 setSize
  // 旧实现用固定公式（fontSize * 1.25）→ 不 accounting 长歌词换行 → 截断；
  // ResizeObserver 高频 setSize → DWM 卡死。折中：内容变化后测量，200ms 防抖 setSize。
  //
  // 左右截断修复（2026-07-14）：content 用 width:auto + maxWidth 让 flex 自然收缩、文字在最大宽度内
  // 换行；窗口宽度 = 内容宽 + 固定两侧留白 MARGIN_X（给足阴影空间），绝不挤压文字、杜绝左右裁切。
  //
  // 2026-07-15 自适应兜底（终结多轮截断）：前几轮在「估算高度公式」上反复打补丁（留白/过渡/FOUT），
  // 但估算高度一旦系统性偏小，窗口即偏低、底部被裁，且偏差随行数/字号累积（越长越截、42 必截）。
  // 故改为：stage1 用「绝对定位隔离上下文」测得 estH（脱离窗口高度的 flex 容器，不会被 h-full 父容器
  // 按当前窗口高 shrink 失真）；最终高度 = estH + 上下留白 safeY*2，直接精确 setSize。
  // 曾用 stage2 在 in-flow 状态重测 content，但 content 是 flex-shrink:1 子项，窗口未长大时被压缩成窗口高
  // → 量得 realH≈窗口高 → 又 setSize 回窗口高 → 死锁（content 真实 133、窗口恒 80、永不长大）。
  // 故彻底废弃 in-flow 重测，只用隔离测量的 estH。
  // 仍保留：①测量前关闭子元素过渡+强制回流→字号跳到目标值；②显式 width:contentW 解除对旧窗口宽度
  // 依赖；③await document.fonts.ready 防 FOUT；④上下留白内嵌为 content padding(safeY)，左右 MARGIN_X。
  //
  // 2026-07-15 稳定锚点（杜绝跳动）：setSize 默认从窗口左上角增长，而 content 居中(justify-center)，
  // 故宽高随歌词长度变化时窗口中心会移动→文字跳动。修复：setSize 前先读当前 innerSize/outerPosition
  // 算出屏幕中心(物理像素，乘 scaleFactor 对齐 DPI)，再按新尺寸反推 top-left 并 setPosition，使文字
  // 中心恒定。拖拽后中心随 onMoved 更新，锚定尊重手动摆放。
  const MARGIN_X = 20; // 左右留白：容纳 textShadow(16px)/WebkitTextStroke 水平外延，防左右被窗口裁切
  const contentRef = useRef<HTMLDivElement>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout>>(0);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (cancelled) return;
      // ③等字体就绪：WebFont 未加载时回退字体行高偏小 → 测出的高度偏低 → 真实字体载入后溢出截断
      const fonts = (typeof document !== 'undefined' && (document as any).fonts) ? (document as any).fonts : null;
      if (fonts?.ready) { try { await fonts.ready; } catch { /* ignore */ } }
      if (cancelled || !contentRef.current) return;

      const content = contentRef.current;
      const children = Array.from(content.children) as HTMLElement[];

      // ①关闭过渡并强制回流：让字号立即跳到目标值（而非插值中途），避免测量拿到偏小字号高度
      content.style.transition = 'none';
      const childPrevTrans = children.map((c) => c.style.transition);
      children.forEach((c) => { c.style.transition = 'none'; });
      void content.offsetHeight; // 强制回流，应用目标字号

      const prev = {
        position: content.style.position,
        width: content.style.width,
        maxWidth: content.style.maxWidth,
        whiteSpace: content.style.whiteSpace,
        paddingTop: content.style.paddingTop,
        paddingBottom: content.style.paddingBottom,
        transition: content.style.transition,
      };
      // 测量期间清空上下 padding：padding 留白改由「显示态」承担
      content.style.paddingTop = '0px';
      content.style.paddingBottom = '0px';

      // 1) 测「单行自然宽」：绝对定位 + 不换行（已用目标字号），单行宽度可靠、无按行累计误差
      content.style.position = 'absolute';
      content.style.width = 'auto';
      content.style.maxWidth = 'none';
      content.style.whiteSpace = 'nowrap';
      const naturalW = content.scrollWidth;

      // 2) 内容最大宽（封顶屏幕 92% 减两侧留白）；超长歌词在此宽度内换行
      const availW = (typeof window !== 'undefined' && window.screen) ? window.screen.availWidth : 1920;
      const capW = Math.max(240, Math.floor(availW * 0.92));
      const contentW = Math.min(naturalW, capW - MARGIN_X * 2);
      const w = contentW + MARGIN_X * 2; // 窗口比内容宽 2*MARGIN_X，左右留白给阴影

      // 3) 估算高度（仅作首帧下界，宁可高估；真实高度由 stage2 精修，故估算偏小也无妨）
      content.style.position = 'absolute';
      content.style.width = `${contentW}px`;
      content.style.maxWidth = 'none';
      content.style.whiteSpace = 'normal';
      const estH = Math.ceil(content.getBoundingClientRect().height);

      // 还原临时样式（含过渡）
      content.style.position = prev.position;
      content.style.width = prev.width;
      content.style.maxWidth = prev.maxWidth;
      content.style.whiteSpace = prev.whiteSpace;
      content.style.paddingTop = prev.paddingTop;
      content.style.paddingBottom = prev.paddingBottom;
      content.style.transition = prev.transition;
      children.forEach((c, i) => { c.style.transition = childPrevTrans[i]; });

      const safeY = Math.ceil(fontSize * 0.5) + 22;

      // 显示态：width:auto + maxWidth（flex 自然收缩、文字换行不错位），以内嵌 padding 承载上下留白
      content.style.width = 'auto';
      content.style.maxWidth = `${contentW}px`;
      content.style.whiteSpace = 'normal';
      content.style.paddingTop = `${safeY}px`;
      content.style.paddingBottom = `${safeY}px`;

      const win = getCurrentWindow();
      isResizingRef.current = true;

      // 最终高度用隔离测量的 estH + 上下留白 safeY*2（estH 脱离窗口高度的 flex 容器 shrink 影响）。
      const finalH = estH + safeY * 2;

      // 稳定锚点：保持窗口「中心」在屏幕上的位置不变，避免随歌词长度/字号变化而跳变。
      // 先读当前尺寸/位置算出屏幕中心(物理像素)，再按新尺寸反推新 top-left，使文字中心恒定。
      // 拖拽后中心会更新到用户放置处（onMoved 已同步位置），故锚定尊重手动摆放。
      try {
        const sf = await win.scaleFactor();
        const curSize = await win.innerSize();      // 物理像素
        const curPos = await win.outerPosition();   // 物理像素
        const cx = curPos.x + curSize.width / 2;
        const cy = curPos.y + curSize.height / 2;
        const newLeft = Math.round(cx - (w * sf) / 2);
        const newTop = Math.round(cy - (finalH * sf) / 2);
        await win.setSize(new LogicalSize(w, finalH));
        await win.setPosition(new PhysicalPosition(newLeft, newTop));
      } catch {
        // 极端情况（首次无位置信息）退化为仅 setSize，不移动位置
        try { await win.setSize(new LogicalSize(w, finalH)); } catch { /* ignore */ }
      } finally {
        setTimeout(() => { isResizingRef.current = false; }, 100);
      }
    };
    // 防抖 200ms：歌词快速更新时只取最后一次，避免高频 setSize
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(run, 200);
    return () => {
      cancelled = true;
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
      {/* 内容容器：上下留白由窗口 safeY 提供（不再用 py-3，避免与纵向缓冲重复占用导致上下被裁） */}
      <div ref={contentRef} className="flex flex-col items-center">
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