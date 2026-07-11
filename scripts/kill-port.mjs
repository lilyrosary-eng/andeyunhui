import { execSync } from 'child_process';

const PORT = 1420;

try {
  const cmd = `powershell -Command "$p=(Get-NetTCPConnection -LocalPort ${PORT} -ErrorAction SilentlyContinue).OwningProcess; if($p){Stop-Process -Id $p -Force; Write-Host 'Killed port ${PORT} (PID:' $p ')'}"`;
  execSync(cmd, { stdio: 'pipe' });
} catch {
  // 端口未被占用或清理失败，忽略错误继续启动
}