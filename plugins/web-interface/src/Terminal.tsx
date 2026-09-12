/// <reference path="../../../global.d.ts" />
// ============================================================
// Web 接口模块 · 真 PTY 终端（复用 pty_service + xterm.js）
//
// 简化版：不看花哨逻辑，做法很直接——
//   打开一个终端（portable-pty），把预设的命令写进去执行；
//   服务进程就常驻在这个终端里 → 既看到日志，也能交互输入。
// 停止 = 卸载组件 → 清理阶段调用 pty_kill 杀掉进程。
// 输出走 pty-output:<id> 事件 → term.write；输入走 term.onData → pty_write。
// ============================================================
const React = window.__HOST_REACT__;
const hostApi = window.__HOST_API__;
const { useState, useEffect, useRef, useCallback } = React;

interface XtermBundle {
  Terminal: any;
  FitAddon: any;
}
let xtermPromise: Promise<XtermBundle> | null = null;
let xtermCssInjected = false;

function loadXterm(): Promise<XtermBundle> {
  if (xtermPromise) return xtermPromise;
  xtermPromise = (async () => {
    const [xtermMod, fitMod, cssMod] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/xterm/css/xterm.css?inline'),
    ]);
    if (!xtermCssInjected && cssMod?.default) {
      const style = document.createElement('style');
      style.setAttribute('data-webterm-css', '1');
      style.textContent = cssMod.default;
      document.head.appendChild(style);
      xtermCssInjected = true;
    }
    return { Terminal: xtermMod.Terminal, FitAddon: fitMod.FitAddon };
  })();
  return xtermPromise;
}

export interface WebTerminalProps {
  /** 要执行的命令/脚本（写入终端后回车执行） */
  command: string;
  /** 工作目录（可选） */
  cwd?: string;
  /** 注入子进程的环境变量（可选）。用于抑制外部浏览器（如 BROWSER=…）等场景 */
  env?: Record<string, string>;
  /** 开终端时先在顶部打印的提示行（如 `$ python -m http.server 8000`），仅作展示 */
  hint?: string;
  /** 进程退出回调（pty-exit） */
  onExit?: () => void;
  /** 终端初始化失败回调 */
  onError?: (msg: string) => void;
  /** PTY 输出回调（原样文本）。供上层解析服务自报的监听地址等 */
  onOutput?: (text: string) => void;
}

export function WebTerminal({ command, cwd, env, hint, onExit, onError, onOutput }: WebTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'exited' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  // 用 ref 保存 ptyId，便于组件级 pasteText 在 effect 之外也能拿到当前终端写输入
  const ptyIdRef = useRef<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const showToast = useCallback((text: string) => {
    setToast(text);
    setTimeout(() => setToast(null), 1200);
  }, []);

  // 复制选中文本到剪贴板（优先 navigator.clipboard，兜底 execCommand）
  const copyText = useCallback((text: string) => {
    const legacy = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      ta.style.pointerEvents = 'none';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      document.body.removeChild(ta);
      showToast('已复制');
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(() => showToast('已复制')).catch(legacy);
    } else {
      legacy();
    }
  }, [showToast]);

  // 读取剪贴板文本并写入当前终端（模拟粘贴）。优先无痕读剪贴板，失败回退 Rust 命令
  const pasteText = useCallback(async () => {
    let text = '';
    try {
      const t = await navigator.clipboard.readText();
      if (t) text = t;
    } catch { /* 权限/无痕被拒则回退 */ }
    if (!text) {
      try {
        const t = String(await hostApi.invoke('clipboard_read'));
        if (t) text = t;
      } catch { /* 读不到就忽略 */ }
    }
    if (text && ptyIdRef.current) {
      hostApi.invoke('pty_write', { id: ptyIdRef.current, data: text }).catch(() => {});
      showToast('已粘贴');
    }
  }, [showToast]);

  useEffect(() => {
    let disposed = false;
    let term: any = null;
    let fitAddon: any = null;
    let ptyId: string | null = null;
    let unlistenExit: (() => void) | null = null;
    let unlistenErr: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    // 命令兜底下发定时器：即便 shell 始终无输出，到点也会把命令写进去。
    // 声明在 try 之外，保证 pty_create 失败时 cleanup 仍能安全清理它。
    let sendFallbackTimer = 0;
    const disposers: Array<() => void> = [];

    (async () => {
      try {
        const bundle = await loadXterm();
        if (disposed) return;
        const container = containerRef.current;
        if (!container) return;

        const dark = document.documentElement.classList.contains('dark');
        term = new bundle.Terminal({
          cursorBlink: true,
          convertEol: true, // Windows CR 正常换行
          fontSize: 12.5,
          scrollback: 20000,
          fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
          // 选中高亮必须显式给色：xterm 默认 selection 是半透明白，在浅色主题（白底）
          // 几乎完全不可见、深色主题下也偏灰，表现为「拖选没反应」。这里用 VS Code 同款
          // 高对比选中色，并补 selectionInactiveBackground（失焦时仍能看到选区）。
          theme: dark
            ? {
                background: '#1e1e1e',
                foreground: '#d4d4d4',
                cursor: '#d4d4d4',
                selectionBackground: '#264f78',
                selectionForeground: '#ffffff',
                selectionInactiveBackground: '#3a3d41',
              }
            : {
                background: '#ffffff',
                foreground: '#24292e',
                cursor: '#24292e',
                selectionBackground: '#add6ff',
                selectionForeground: '#000000',
                selectionInactiveBackground: '#e5ebf1',
              },
          allowProposedApi: true,
        });
        fitAddon = new bundle.FitAddon();
        term.loadAddon(fitAddon);
        term.open(container);
        fitAddon.fit();
        const cols = term.cols || 80;
        const rows = term.rows || 24;

        // 终端文本可选中，并支持复制（Ctrl+C / Ctrl+Shift+C / 右键复制选中内容）。
        // 容器显式放行 user-select；用 capture 阶段 keydown 拦截，避免 WebView2 把 Ctrl+Shift+C 当作 devtools 检查。
        try { container.style.userSelect = 'text'; } catch { /* ignore */ }
        const onTermKeyDown = (e: KeyboardEvent) => {
          if (disposed) return;
          const mod = e.ctrlKey || e.metaKey;
          // 粘贴：Ctrl+V / Ctrl+Shift+V / Shift+Insert
          if (mod && e.code === 'KeyV') {
            e.preventDefault(); e.stopPropagation(); pasteText(); return;
          }
          if (e.shiftKey && e.code === 'Insert') {
            e.preventDefault(); e.stopPropagation(); pasteText(); return;
          }
          // 复制：Ctrl+C / Ctrl+Shift+C
          const sel = term?.getSelection?.() as string | undefined;
          if (mod && e.shiftKey && e.code === 'KeyC') {
            // 无选中也吞掉 Ctrl+Shift+C，避免误触 WebView2 的 devtools 检查视图
            e.preventDefault(); e.stopPropagation();
            if (sel) copyText(sel);
            return;
          }
          if (mod && e.code === 'KeyC' && sel) {
            e.preventDefault(); e.stopPropagation(); copyText(sel);
          }
        };
        container.addEventListener('keydown', onTermKeyDown, true);
        disposers.push(() => { try { container.removeEventListener('keydown', onTermKeyDown, true); } catch { /* ignore */ } });
        const onTermContext = (e: MouseEvent) => {
          if (disposed) return;
          const sel = term?.getSelection?.() as string | undefined;
          if (sel) {
            e.preventDefault(); copyText(sel); // 有选中 → 右键复制选中
          } else {
            e.preventDefault(); pasteText();   // 无选中 → 右键粘贴（对齐 Windows 终端惯例）
          }
        };
        container.addEventListener('contextmenu', onTermContext);
        disposers.push(() => { try { container.removeEventListener('contextmenu', onTermContext); } catch { /* ignore */ } });

        // 由模块分配的 ptyId，服务即跑在这个终端里
        ptyId = 'wp_pty_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        ptyIdRef.current = ptyId;
        await hostApi.invoke('pty_create', { id: ptyId, cwd: cwd || null, cols, rows, env: env || null });
        if (disposed) return;

        // 输出批处理：高频 pty-output 事件（尤其大日志）经 rAF 合并到一帧内一次 term.write，
        // 避免每次事件都触发 WebView2 回调和 xterm 渲染，缓解主线程堆积、防止日志被截断/卡顿。
        // 落后帧最多 ~16ms，实时性可接受；本地无可用的 createFrameBuffer 时退化为直接 write。
        let fb: { push: (s: string) => void; flush: () => void; destroy: () => void } | null = null;
        if (typeof hostApi.createFrameBuffer === 'function') {
          fb = hostApi.createFrameBuffer((items: string[]) => {
            if (!disposed && term) term.write(items.join(''));
          });
        }

        // 命令下发（幂等，只发一次）：等 shell 就绪后再写，避免写进未就绪的 shell 被丢弃。
        // 原先是固定 600ms 后写入 —— PowerShell 等启动更慢的 shell 会吃掉/丢弃这条命令，
        // 表现为「点了一键启动，终端开了但服务没跑起来」。
        // 改为：收到 PTY 首帧输出即视为 shell 就绪并立即下发；另设 2.5s 兜底定时器，
        // 兼顾「shell 静默启动、始终无输出」的场景。多行命令逐行下发，
        // 避免整段一次性粘贴被部分 shell 当成单行处理。
        let commandSent = false;
        const sendCommand = () => {
          if (commandSent || disposed || !ptyId || !command) return;
          commandSent = true;
          window.clearTimeout(sendFallbackTimer);
          const lines = String(command).split(/\r?\n/).filter((l) => l.trim().length > 0);
          if (lines.length <= 1) {
            hostApi.invoke('pty_write', { id: ptyId, data: command + '\r' }).catch(() => {});
            return;
          }
          lines.forEach((line, i) => {
            window.setTimeout(() => {
              if (disposed || !ptyId) return;
              hostApi.invoke('pty_write', { id: ptyId, data: line + '\r' }).catch(() => {});
            }, i * 120);
          });
        };
        sendFallbackTimer = window.setTimeout(sendCommand, 2500);

        // 输出桥接：PTY → xterm（经 frameBuffer 批处理）；首帧输出即触发命令下发
        const outUnlistenP = hostApi.listen(`pty-output:${ptyId}`, (e: any) => {
          if (e?.payload) {
            if (fb && !disposed) fb.push(e.payload as string);
            else if (!disposed) term?.write(e.payload);
            sendCommand();
            onOutput?.(String(e.payload));
          }
        });
        // 进程退出
        const exitUnlistenP = hostApi.listen(`pty-exit:${ptyId}`, () => {
          if (!disposed) {
            setStatus('exited');
            term?.write('\r\n\x1b[90m[进程已退出]\x1b[0m\r\n');
            onExit?.();
          }
        });
        // 读错误
        const errUnlistenP = hostApi.listen(`pty-error:${ptyId}`, (e: any) => {
          if (!disposed) term?.write('\r\n\x1b[31m[错误] ' + String(e?.payload || '') + '\x1b[0m\r\n');
        });
        // 输入桥接：xterm → PTY
        const dataDisposer = term.onData((data: string) => {
          if (ptyId && !disposed) {
            hostApi.invoke('pty_write', { id: ptyId, data }).catch(() => {});
          }
        });
        disposers.push(() => dataDisposer?.dispose());

        // resize 桥接
        let resizeTimer: any = null;
        resizeObserver = new ResizeObserver(() => {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            if (disposed || !fitAddon) return;
            try {
              fitAddon.fit();
              // 容器被 display:none 隐藏时会算出 0/极小尺寸，忽略以免向 PTY 发送非法行列
              if (ptyId && term.cols > 2 && term.rows > 2) {
                hostApi.invoke('pty_resize', { id: ptyId, cols: term.cols, rows: term.rows }).catch(() => {});
              }
            } catch { /* 容器不可见时忽略 */ }
          }, 80);
        });
        resizeObserver.observe(container);

        const [uo, ue, uerr] = await Promise.all([outUnlistenP, exitUnlistenP, errUnlistenP]);
        unlistenExit = typeof ue === 'function' ? ue : (ue as any)?.unsubscribe ?? null;
        unlistenErr = typeof uerr === 'function' ? uerr : (uerr as any)?.unsubscribe ?? null;
        disposers.push(() => { try { unlistenErr?.(); } catch { /* */ } });

        setStatus('ready');
        if (hint) term?.write('\x1b[90m$ ' + hint.replace(/\r?\n/g, ' ') + '\x1b[0m\r\n');
        term?.write('\r\n\x1b[90m[ Ctrl+C / Ctrl+Shift+C 复制选中 · 右键或 Ctrl+V / Shift+Insert 粘贴 ]\x1b[0m\r\n');

        // 命令下发已交给 sendCommand（首帧输出触发 + 2.5s 兜底），此处不再重复写
        setTimeout(() => { try { term?.focus(); } catch { /* */ } }, 60);
      } catch (e: any) {
        if (!disposed) {
          setStatus('error');
          setErrMsg(String(e?.message || e));
          onError?.(String(e?.message || e));
        }
      }
    })();

    cleanupRef.current = () => {
      disposed = true;
      window.clearTimeout(sendFallbackTimer);
      try { resizeObserver?.disconnect(); } catch { /* */ }
      disposers.forEach((d) => { try { d(); } catch { /* */ } });
      try { unlistenExit?.(); } catch { /* */ }
      try { unlistenErr?.(); } catch { /* */ }
      // 先冲刷批处理缓冲里的残留输出，再销毁，避免卸载瞬间丢最后一段日志
      try { fb?.flush(); } catch { /* */ }
      try { fb?.destroy(); } catch { /* */ }
      if (ptyId) {
        hostApi.invoke('pty_kill', { id: ptyId }).catch(() => {});
      }
      try { term?.dispose(); } catch { /* */ }
      ptyIdRef.current = null;
    };
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command, cwd, env, hint]);

  return (
    <div className="relative flex flex-col h-full w-full bg-white dark:bg-[#1e1e1e]">
      {status === 'loading' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center text-xs text-neutral-400 dark:text-stone-500">
          正在启动终端…
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center p-4 text-center text-xs text-red-500">
          终端启动失败：{errMsg || '未知错误'}
        </div>
      )}
      <div ref={containerRef} className="flex-1 min-h-0 w-full overflow-hidden" />
      {status === 'ready' && toast && (
        <div className="absolute bottom-2 right-2 z-20 rounded-md bg-black/70 dark:bg-white/10 px-2 py-1 text-[11px] text-white dark:text-stone-200 shadow">
          {toast}
        </div>
      )}
    </div>
  );
}