import { useEffect, useState, useCallback, useRef } from 'react';
import { emit, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { api } from '@/lib/api';
import { Pin, Copy, X } from 'lucide-react';
import { logger } from '@/lib/logger';
import { t } from '@/lib/i18n';
import { storage } from '@/core/storage';
import { KEYS } from '@/core/storage/keys';
import { EVENTS } from '@/core/events/schema';

const appWindow = getCurrentWebviewWindow();
const AUTO_SAVE_MS = 1000;

/** 模块级防抖 timer：每次输入重置，避免高频保存 */
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 浮窗笔记底色：浅粉 → 浅紫渐变（与「常用笔记卡片」同风格），
 * 让文字在这层底上始终清晰、不会"隐身"。
 */
const NOTE_GRADIENT = 'linear-gradient(135deg, rgba(253,228,240,0.94), rgba(238,232,252,0.94))';

/**
 * 显式拖拽与不可拖拽的 CSS（WebviewWindow 动态创建时
 * data-tauri-drag-region 不会自动注入 -webkit-app-region，需手动补齐）
 */
const DRAG_STYLE = { WebkitAppRegion: 'drag' } as React.CSSProperties;
const NO_DRAG_STYLE = { WebkitAppRegion: 'no-drag' } as React.CSSProperties;

/** 浮窗笔记子窗口 — 可编辑、可拖动、防连点卡死 */
export function FloatingNoteView() {
  const [noteId] = useState(() => {
    return new URLSearchParams(window.location.search).get('noteId') || '';
  });
  const [title, setTitle] = useState(() => t('common.loading'));
  const [content, setContent] = useState('');
  const [isPinned, setIsPinned] = useState(false);
  const [isFixed, setIsFixed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isCopying, setIsCopying] = useState(false);
  // 跟随应用内统一设置的字体：优先取主窗口创建时通过 URL 传入的 fontFamily（浮窗 webview
  // 的 localStorage 可能与主窗隔离）；再回退读 localStorage；并监听 app-font-changed 事件
  // 实时同步设置变更。
  const [globalFont, setGlobalFont] = useState(() => {
    try {
      const fromUrl = new URLSearchParams(window.location.search).get('fontFamily');
      if (fromUrl) return fromUrl;
    } catch { /* ignore */ }
    return storage.getString(KEYS.theme.fontFamily.key, '');
  });
  useEffect(() => {
    // 挂载即向主窗口请求当前字体（主窗口 app-font-request 监听 → 回发 app-font-changed），
    // 兜底补上「URL 参数仅覆盖新建窗 / localStorage 可能隔离」两种情况。
    try { emit('app-font-request').catch(() => {}); } catch { /* ignore */ }
    let un: (() => void) | undefined;
    listen<{ fontFamily?: string }>('app-font-changed', (e) => {
      if (e.payload?.fontFamily) setGlobalFont(e.payload.fontFamily);
    }).then((u) => { un = u; }).catch(() => {});
    return () => { un?.(); };
  }, []);

  // 加载完成后才允许自动保存（避免首次渲染触发保存）
  const loadedRef = useRef(false);
  // 持有最新标题/内容，供 onCloseRequested（任意关闭路径）读取，避免闭包拿到旧值
  const titleRef = useRef(title);
  const contentRef = useRef(content);
  titleRef.current = title;
  contentRef.current = content;

  // 浮窗透明效果：覆盖全局 body 背景色，让窗口透明生效
  useEffect(() => {
    const prev = document.body.style.backgroundColor;
    document.body.style.backgroundColor = 'transparent';
    return () => { document.body.style.backgroundColor = prev; };
  }, []);

  // 加载笔记内容
  useEffect(() => {
    if (!noteId) {
      logger.debug('[FloatingNoteView] noteId 为空，跳过加载');
      setLoading(false);
      return;
    }
    api.getNoteContent(noteId).then((data) => {
      setTitle(data.title || t('floatingNote.untitled'));
      // 去除内容首行 # 大标题（标题栏已显示，无需重复）。
      // 必须 trimStart()：磁盘格式为「# 标题\n\n正文」，去掉标题后会残留前导空行，
      // 若不清理，保存时后端又补「\n\n」，每次开浮窗往返都会在正文上方累加一行空白。
      const c = (data.content || '').replace(/^#\s+[^\n]*\n?/, '').trimStart();
      setContent(c);
      setLoading(false);
      loadedRef.current = true;
    }).catch((err) => {
      console.error('[FloatingNoteView] 笔记内容加载失败:', err);
      setTitle(t('floatingNote.loadFailed'));
      setLoading(false);
    });
  }, [noteId]);

  // 防抖自动保存（模式与主编辑器一致：1s 防抖，跳过首次加载）
  useEffect(() => {
    if (!loadedRef.current) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!noteId || !title) return;
      api.saveNote(noteId, title, content).catch((err) =>
        logger.warn('[FloatingNoteView] 自动保存失败:', err),
      );
    }, AUTO_SAVE_MS);
    return () => {
      if (saveTimer) clearTimeout(saveTimer);
    };
  }, [content, title, noteId]);

  /**
   * 统一收口：flush 未保存内容并 emit floating-note-closed，
   * 主窗口据此把笔记从 floatingNoteIds 移除、回到原笔记栏
   * （修复任务栏关闭后“消失/被删”，同时避免丢未保存内容）。
   * 带 2s 兜底：即使 saveNote/emit 异常也不会让窗口永远关不掉。
   */
  const flushAndNotify = useCallback(async () => {
    const guard = new Promise<void>((r) => setTimeout(r, 2000));
    const work = (async () => {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = undefined; }
      if (noteId && titleRef.current) {
        await api.saveNote(noteId, titleRef.current, contentRef.current).catch(() => {});
      }
      await emit(EVENTS.notes.closed, { noteId }).catch(() => {});
    })();
    await Promise.race([work, guard]);
  }, [noteId]);

  /**
   * 右上角 X：先保存 + 通知，再用 destroy() 强制关闭。
   * 关键：destroy() 不触发 CloseRequested 事件，因此不会与下面的
   * onCloseRequested 重复，且无论事件语义如何都能保证关闭（彻底修复“关不掉”）。
   */
  const handleClose = useCallback(async () => {
    await flushAndNotify().catch(() => {});
    try {
      await appWindow.destroy();
    } catch {
      try { await appWindow.close(); } catch (err) { logger.warn('[FloatingNoteView] 关闭失败:', err); }
    }
  }, [flushAndNotify]);

  /**
   * OS 级关闭（任务栏右键关闭 / Alt+F4）：Tauri 会 await 此 handler，
   * 从而保证 emit 在窗口销毁前送达，笔记正常回原栏。
   * 2s 兜底由 flushAndNotify 内部的 guard 保证窗口不会卡死。
   */
  useEffect(() => {
    const un = appWindow.onCloseRequested(async () => {
      await flushAndNotify().catch(() => {});
    });
    return () => { un.then((u) => u()).catch(() => {}); };
  }, [flushAndNotify]);

  /** 切换置顶 */
  const handleTogglePin = useCallback(async () => {
    setIsPinned(p => !p);
    try {
      await appWindow.setAlwaysOnTop(!isPinned);
    } catch (err) { logger.warn('[FloatingNoteView] 置顶切换失败:', err); }
  }, [isPinned]);

  /** 复制笔记：后端创建副本 + 在旁边开新浮窗（防连点） */
  const handleCopy = useCallback(async () => {
    if (isCopying) return;
    setIsCopying(true);
    try {
      const newId = await api.duplicateNote(noteId);
      const pos = await appWindow.outerPosition();
      api.createFloatingNoteWindow(newId, t('floatingNote.copyName', { title }), pos.x + 30, pos.y + 30);
    } catch (err) { logger.warn('[FloatingNoteView] 复制笔记失败:', err); }
    finally { setIsCopying(false); }
  }, [noteId, title, isCopying]);

  /** 切换固定（置顶 + 内容区 CSS 穿透；标题栏始终可交互） */
  const handleToggleFix = useCallback(async () => {
    const next = !isFixed;
    setIsFixed(next);
    try {
      // 固定 = 置顶；穿透只用 CSS 做在内容区，标题栏保持可交互
      await appWindow.setAlwaysOnTop(next);
      if (next) setIsPinned(true);
      else setIsPinned(false);
    } catch (err) { logger.warn('[FloatingNoteView] 固定切换失败:', err); }
  }, [isFixed]);

  if (!noteId) {
    return (
      <div
        className="flex items-center justify-center h-screen text-neutral-700 text-[15px] font-medium"
        style={{
          background: NOTE_GRADIENT,
          fontFamily: globalFont && globalFont !== '系统默认' ? `"${globalFont}", sans-serif` : undefined,
        }}
      >
        {t('floatingNote.invalid')}
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col h-screen rounded-2xl border border-white/40 shadow-lg overflow-hidden ${isFixed ? 'pointer-events-none' : ''}`}
      style={{
        background: NOTE_GRADIENT,
        fontFamily: globalFont && globalFont !== '系统默认' ? `"${globalFont}", sans-serif` : undefined,
      }}
    >
      {/* ====== 自定义标题栏（拖拽区；固定时移除拖拽属性，不可拖动）====== */}
      <div
        data-tauri-drag-region={isFixed ? undefined : ''}
        style={isFixed ? undefined : DRAG_STYLE}
        className="flex items-center justify-between gap-2 px-3 py-2.5 bg-white/25 text-neutral-800 border-b border-black/5 select-none"
      >
        {/* 标题（浮窗只读） */}
        <span className="flex-1 min-w-0 text-base font-semibold truncate ml-1 select-none">
          {title || t('notes.floatingTitle')}
        </span>
        {/* 按钮组（不可拖拽） */}
        <div style={NO_DRAG_STYLE} className="flex items-center gap-0.5 flex-shrink-0">
          {/* 置顶 */}
          <button
            onClick={handleTogglePin}
            className={`btn-press p-1.5 rounded-lg transition-colors ${
              isPinned
                ? 'text-yellow-500 bg-yellow-50 dark:bg-yellow-900/20'
                : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5'
            }`}
            title={isPinned ? t('common.unpin') : t('common.pin')}
          >
            <Pin size={14} fill={isPinned ? 'currentColor' : 'none'} />
          </button>
          {/* 复制为新笔记 */}
          <button
            onClick={handleCopy}
            disabled={isCopying}
            className={`btn-press p-1.5 rounded-lg transition-colors ${
              isCopying
                ? 'opacity-50 cursor-not-allowed'
                : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5'
            }`}
            title={t('floatingNote.copyAsNew')}
          >
            <Copy size={14} />
          </button>
          {/* 固定（唯一保持可交互的按钮） */}
          <button
            onClick={handleToggleFix}
            className={`btn-press p-1.5 rounded-lg transition-colors pointer-events-auto ${
              isFixed
                ? 'text-blue-500 bg-blue-50 dark:bg-blue-900/20'
                : 'text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5'
            }`}
            title={isFixed ? t('floatingNote.unfix') : t('floatingNote.fix')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill={isFixed ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
              <path d="M18 8L22 4L20 2L6 16L10 20L22 8Z" />
              <path d="M2 22L10 20" />
            </svg>
          </button>
          {/* 分割线 */}
          <div className="w-px h-4 mx-1 bg-neutral-200/50 dark:bg-stone-600/50" />
          {/* 关闭 */}
          <button
            onClick={handleClose}
            className="btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            title={t('floatingNote.close')}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* ====== 内容编辑区 ====== */}
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="flex items-center justify-center h-full text-neutral-400 dark:text-stone-500 text-sm">
            {t('common.loading')}
          </div>
        ) : (
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="w-full h-full resize-none p-5 bg-transparent text-[15.5px] leading-7 font-semibold text-neutral-800 outline-none border-none placeholder:text-neutral-400"
            style={{ fontFamily: 'inherit' }}
            placeholder={t('floatingNote.mdPlaceholder')}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}

export default FloatingNoteView;