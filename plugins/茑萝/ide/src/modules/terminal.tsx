// 茑萝 · IDE 真 PTY 终端（阶段四）
// 用 xterm.js + portable-pty 后端替换原一次性命令终端，支持交互式 shell。
// 沙箱屏蔽 WebSocket，故输出走 Tauri 事件 pty-output:<id> → term.write，输入走 term.onData → pty_write。
// xterm.js 走动态 import（与 CodeMirror 同模式），CSS 用 ?inline 注入避免插件包 CSS 提取问题。
const React = window.__HOST_REACT__;
const hostApi = window.__HOST_API__;
const { useState, useEffect, useRef } = React;
import { ideShared } from './shared';

// ===== xterm.js 懒加载（缓存 Promise，与 loadCM 同模式）=====
interface XtermBundle {
  Terminal: any;
  FitAddon: any;
  WebglAddon: any;
}
let xtermPromise: Promise<XtermBundle> | null = null;
let xtermCssInjected = false;

function loadXterm(): Promise<XtermBundle> {
  if (xtermPromise) return xtermPromise;
  xtermPromise = (async () => {
    const [xtermMod, fitMod, webglMod, cssMod] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/addon-webgl'),
      import('@xterm/xterm/css/xterm.css?inline'),
    ]);
    // 注入 xterm CSS（仅一次）：插件包不走标准 CSS 提取，故用 ?inline 取字符串手动注入
    if (!xtermCssInjected && cssMod?.default) {
      const style = document.createElement('style');
      style.setAttribute('data-xterm-css', '1');
      style.textContent = cssMod.default;
      document.head.appendChild(style);
      xtermCssInjected = true;
    }
    return {
      Terminal: xtermMod.Terminal,
      FitAddon: fitMod.FitAddon,
      WebglAddon: webglMod.WebglAddon,
    };
  })();
  return xtermPromise;
}

// 检测当前是否暗色模式（终端主题随 IDE 主题切换）
function isDarkMode(): boolean {
  return document.documentElement.classList.contains('dark');
}

export function IdePtyTerminal() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'exited' | 'error'>('loading');
  const [errMsg, setErrMsg] = useState('');
  // 存放清理函数，组件卸载时调用
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let disposed = false;
    let term: any = null;
    let fitAddon: any = null;
    let webglAddon: any = null;
    let ptyId: string | null = null;
    let unlistenOutput: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const disposers: Array<() => void> = [];

    (async () => {
      try {
        const bundle = await loadXterm();
        if (disposed) return;
        const container = containerRef.current;
        if (!container) return;

        // 创建 xterm 实例
        const dark = isDarkMode();
        term = new bundle.Terminal({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, "Courier New", monospace',
          theme: dark ? {
            background: '#1e1e1e',
            foreground: '#d4d4d4',
            cursor: '#d4d4d4',
            selectionBackground: '#264f78',
          } : {
            background: '#ffffff',
            foreground: '#24292e',
            cursor: '#24292e',
            selectionBackground: '#c8e1ff',
          },
          allowProposedApi: true,
        });
        fitAddon = new bundle.FitAddon();
        term.loadAddon(fitAddon);
        term.open(container);
        // WebGL 渲染加速（失败则回退到默认 canvas 渲染器）
        try {
          webglAddon = new bundle.WebglAddon();
          term.loadAddon(webglAddon);
        } catch { /* 无 GPU 或不支持 → 默认渲染器即可 */ }

        // 初始 fit 拿到 cols/rows 再创建 PTY
        fitAddon.fit();
        const cols = term.cols || 80;
        const rows = term.rows || 24;

        ptyId = 'pty_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
        const cwd = ideShared.projectRoot || null;
        await hostApi.invoke('pty_create', { id: ptyId, cwd, cols, rows });
        if (disposed) return;

        setStatus('ready');

        // 输出桥接：PTY → xterm
        const outUnlistenP = hostApi.listen(`pty-output:${ptyId}`, (e: any) => {
          if (e?.payload && !disposed) term?.write(e.payload);
        });
        // 退出事件
        const exitUnlistenP = hostApi.listen(`pty-exit:${ptyId}`, () => {
          if (!disposed) {
            setStatus('exited');
            term?.write('\r\n\x1b[90m[进程已退出]\x1b[0m\r\n');
          }
        });
        // 错误事件
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

        // resize 桥接：容器尺寸变化 → fit → pty_resize
        let resizeTimer: any = null;
        resizeObserver = new ResizeObserver(() => {
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            if (disposed || !fitAddon) return;
            try {
              fitAddon.fit();
              if (ptyId) {
                hostApi.invoke('pty_resize', { id: ptyId, cols: term.cols, rows: term.rows }).catch(() => {});
              }
            } catch { /* 容器不可见时 fit 可能抛错，忽略 */ }
          }, 80);
        });
        resizeObserver.observe(container);

        // 等待 unlisten 句柄
        const [uo, ue, uerr] = await Promise.all([outUnlistenP, exitUnlistenP, errUnlistenP]);
        unlistenOutput = typeof uo === 'function' ? uo : (uo as any)?.unsubscribe ?? null;
        unlistenExit = typeof ue === 'function' ? ue : (ue as any)?.unsubscribe ?? null;
        const unlistenErr = typeof uerr === 'function' ? uerr : (uerr as any)?.unsubscribe ?? null;
        disposers.push(() => { try { unlistenErr?.(); } catch { /* */ } });

        // 聚焦终端
        setTimeout(() => { try { term?.focus(); } catch { /* */ } }, 50);
      } catch (e: any) {
        if (!disposed) {
          setStatus('error');
          setErrMsg(String(e?.message || e));
        }
      }
    })();

    // 清理：卸载时 kill PTY + dispose xterm + 取消监听
    cleanupRef.current = () => {
      disposed = true;
      try { resizeObserver?.disconnect(); } catch { /* */ }
      disposers.forEach((d) => { try { d(); } catch { /* */ } });
      try { unlistenOutput?.(); } catch { /* */ }
      try { unlistenExit?.(); } catch { /* */ }
      if (ptyId) {
        hostApi.invoke('pty_kill', { id: ptyId }).catch(() => {});
      }
      try { webglAddon?.dispose(); } catch { /* */ }
      try { term?.dispose(); } catch { /* */ }
    };
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, []);

  return (
    <div className="relative flex flex-col h-full w-full">
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-neutral-400 dark:text-stone-500 z-10">
          正在启动终端…
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-red-500 z-10 px-4 text-center">
          终端启动失败：{errMsg || '未知错误'}
          <br /><span className="text-neutral-400">（请确认系统支持 PTY；Windows 需 Win10 1809+ 的 ConPTY）</span>
        </div>
      )}
      <div ref={containerRef} className="flex-1 min-h-0 w-full overflow-hidden" />
    </div>
  );
}
