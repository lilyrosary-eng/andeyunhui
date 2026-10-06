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

if (process.platform === 'win32') {
  const out = tryRun(
    `powershell -Command "$p=(Get-NetTCPConnection -LocalPort ${PORT} -ErrorAction SilentlyContinue).OwningProcess; if($p){Stop-Process -Id $p -Force; Write-Host 'Killed port ${PORT} (PID:' $p ')'}"`
  );
  if (out) process.stdout.write(out + '\n');
} else {
  const pids = tryRun(`lsof -ti tcp:${PORT} -sTCP:LISTEN`)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (pids.length > 0) {
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        // 可能已自行退出
      }
    }
    console.log(`Killed port ${PORT} (PID: ${pids.join(',')})`);
  } else {
    // lsof 未安装或未命中：fuser 作为兜底
    tryRun(`fuser -k ${PORT}/tcp`);
  }
}
