// 释放 dev server 端口（默认 1420），让 vite 的 strictPort 能顺利绑定。
//
// 跨平台说明：本脚本原先只有 PowerShell 实现（Get-NetTCPConnection + Stop-Process），
// 因为 TAURI dev 早期只在 Windows 上跑。移植到 Linux 后 `powershell` 不存在 →
// execSync 抛错 → 被下面的 catch 吞掉 → 端口没被释放 → vite 因 strictPort:true
// 直接以 "Port 1420 is already in use" 失败退出，tauri dev 随之报
// "beforeDevCommand terminated with a non-zero status code"。
// 故补 POSIX 分支：优先 lsof，拿不到 PID 时退回 fuser。
import { execSync } from 'child_process';

const PORT = Number(process.env.PORT || 1420);

/** 执行命令，失败或异常一律返回空串（清理类操作不应阻断启动流程）。 */
function tryRun(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '';
  }
}

/** 同步等待（不引依赖）。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* 极端环境下的忙等兜底，毫秒级可接受 */
    }
  }
}

/**
 * 当前**正在 LISTEN** 该端口的 PID 列表。
 * 只认 LISTEN（-State Listen / -sTCP:LISTEN）——不加这个条件会把已建立的连接
 * 一起算进来，可能误杀客户端进程。
 */
function listeningPids() {
  if (process.platform === 'win32') {
    const out = tryRun(
      `powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess"`
    );
    return out
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s));
  }
  return tryRun(`lsof -ti tcp:${PORT} -sTCP:LISTEN`)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

const pids = listeningPids();

if (pids.length > 0) {
  for (const pid of pids) {
    if (process.platform === 'win32') {
      // ⚠⚠ 不要用 `Stop-Process -Force`（原实现）：实测它会**打印成功但进程仍在监听**
      //   —— 2026-10-08：占用 1420 的 node（PID 16608）没被杀死，
      //   紧接着 `pnpm tauri dev` 仍报 `Port 1420 is already in use`，
      //   表现为「明明提示 Killed 却起不来」。`taskkill /F` 才可靠。
      tryRun(`taskkill /F /PID ${pid}`);
    } else {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        // 可能已自行退出
      }
    }
  }
  console.log(`Killed port ${PORT} (PID: ${pids.join(',')})`);
} else if (process.platform !== 'win32') {
  // lsof 未安装或未命中：fuser 作为兜底
  tryRun(`fuser -k ${PORT}/tcp`);
}

// ★ 校验：等 LISTEN 真正消失再返回。
//   只报「已杀」而不确认释放，等于把失败留给后面的 vite —— 而 strictPort:true 下
//   那是最贵的失败方式（整个 tauri dev 链终止）。这里宁可多等 ~3s 把它钉死。
for (let i = 0; i < 20; i++) {
  if (listeningPids().length === 0) break;
  sleepSync(150);
}

const stillBusy = listeningPids();
if (stillBusy.length > 0) {
  console.error(
    `[kill-port] 端口 ${PORT} 仍被 PID ${stillBusy.join(',')} 占用；` +
      `请手动清理（Windows: taskkill /F /PID <pid>）后重试。`
  );
  process.exitCode = 1;
}
