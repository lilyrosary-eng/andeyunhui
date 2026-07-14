/**
 * 前端全局错误捕获：把 JS 运行时错误自动写入会话日志文件。
 *
 * 捕获来源：
 * 1. `window.onerror` — 同步错误（未捕获的异常、语法错误等）
 * 2. `window.addEventListener('unhandledrejection', ...)` — 未处理的 Promise 拒绝
 * 3. `console.error` / `console.warn` 重写 — 捕获所有 error/warn 级别日志
 *
 * 所有日志通过 `write_frontend_log` Tauri 命令写入 Rust 侧的会话日志文件，
 * 与 Rust 后端日志统一存储，用户可通过「打开日志文件夹」直接找到并提交。
 *
 * 防重入：invoke 失败时不再递归触发 console.error，避免无限循环。
 */

let initialized = false;
let sending = false; // 防重入标志：invoke 过程中屏蔽二次捕获

function safeInvoke(level: string, message: string, source?: string) {
  if (sending) return;
  sending = true;
  try {
    // 动态 import 避免在非 Tauri 环境报错
    import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke("write_frontend_log", { level, message, source })
      )
      .catch(() => {
        // invoke 失败时静默（不能再 console.error，否则无限循环）
      })
      .finally(() => {
        sending = false;
      });
  } catch {
    sending = false;
  }
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (arg instanceof Error) {
        return `${arg.name}: ${arg.message}\n${arg.stack || ""}`;
      }
      if (typeof arg === "object" && arg !== null) {
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      }
      return String(arg);
    })
    .join(" ");
}

/** 初始化全局错误捕获。应在应用入口（main.tsx）最早处调用一次。 */
export function initFileLogger() {
  if (initialized) return;
  initialized = true;

  // 1. 捕获同步错误
  window.addEventListener("error", (event) => {
    const msg = event.error
      ? `${event.error.name}: ${event.error.message}\n${event.error.stack || ""}`
      : event.message;
    const source = `${event.filename}:${event.lineno}:${event.colno}`;
    safeInvoke("ERROR", msg, source);
  });

  // 2. 捕获未处理的 Promise 拒绝
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const msg =
      reason instanceof Error
        ? `Unhandled Rejection: ${reason.name}: ${reason.message}\n${reason.stack || ""}`
        : `Unhandled Rejection: ${formatArgs([reason])}`;
    safeInvoke("ERROR", msg, "unhandledrejection");
  });

  // 3. 重写 console.error / console.warn，同时保留原行为
  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);

  console.error = (...args: unknown[]) => {
    origError(...args);
    safeInvoke("ERROR", formatArgs(args), "console.error");
  };

  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    safeInvoke("WARN", formatArgs(args), "console.warn");
  };

  // 标记初始化完成
  safeInvoke("INFO", "前端日志系统已初始化", "file-logger");
}
