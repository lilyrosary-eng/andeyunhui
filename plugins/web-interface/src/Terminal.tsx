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
const { useState, useEffect, useRef } = React;

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
}

export function WebTerminal({ command, cwd, env, hint, onExit, onError }: WebTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'exited' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let disposed = false;
    let term: any = null;
    let fitAddon: any = null;
    let ptyId: string | null = null;
    let unlistenExit: (() => void) | null = null;
    let unlistenErr: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
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
          theme: dark
            ? { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#d4d4d4' }
            : { background: '#ffffff', foreground: '#24292e', cursor: '#24292e' },
          allowProposedApi: true,
        });
        fitAddon = new bundle.FitAddon();
        term.loadAddon(fitAddon);
        term.open(container);
        fitAddon.fit();
        const cols = term.cols || 80;
        const rows = term.rows || 24;

        // 由模块分配的 ptyId，服务即跑在这个终端里
        ptyId = 'wp_pty_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
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

        // 输出桥接：PTY → xterm（经 frameBuffer 批处理）
        const outUnlistenP = hostApi.listen(`pty-output:${ptyId}`, (e: any) => {
          if (e?.payload) {
            if (fb && !disposed) fb.push(e.payload as string);
            else if (!disposed) term?.write(e.payload);
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

        // 等 shell 就绪后把命令写进去执行 —— 服务进程从此常驻此终端
        setTimeout(() => {
          if (!disposed && ptyId && command) {
            hostApi.invoke('pty_write', { id: ptyId, data: command + '\r' }).catch(() => {});
          }
        }, 600);
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
    </div>
  );
}