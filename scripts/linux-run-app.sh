#!/usr/bin/env bash
# linux-run-app.sh —— 受控启动 安得云荟（Linux 开发/验证用）
#
# 为什么需要它（2026-10-24 血案）：我反复用 `timeout N app &` 起 GUI 做实验，
# 每次都带起 2~3 个 WebKitWebProcess + 媒体服务；旧实例没死透就叠新实例，
# 最后把整机拖到关机（硬断电，journal 都没落盘）。
#
# 这个脚本把三件事固定下来：
#   1) 单实例：已有进程就直接拒绝（不叠加）
#   2) 资源上限：走 scripts/linux-guard.sh（MemoryMax 4G / CPU 400% / 硬超时）
#   3) 收尾干净：退出后扫描并清掉本次派生的 WebKit 子进程，再报告内存
#
# 用法：
#   scripts/linux-run-app.sh                # 跑 60s
#   scripts/linux-run-app.sh --time 20      # 跑 20s
#   scripts/linux-run-app.sh --bin ./src-tauri/target/debug/andeyunhui --time 30
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="/usr/bin/andeyunhui"
TIME="60"
MEM="4G"
CPU="400%"

while [ $# -gt 0 ]; do
  case "$1" in
    --time) TIME="$2"; shift 2 ;;
    --mem) MEM="$2"; shift 2 ;;
    --bin) BIN="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "[run-app] 未知参数: $1" >&2; exit 2 ;;
  esac
done

if pgrep -x andeyunhui >/dev/null 2>&1; then
  echo "[run-app] 拒绝启动：已有 andeyunhui 在跑（先把旧实例关掉，不要叠加）" >&2
  pgrep -a -x andeyunhui | head -3 >&2
  exit 5
fi

if [ ! -x "$BIN" ]; then
  echo "[run-app] 找不到可执行文件: $BIN" >&2
  exit 6
fi

echo "[run-app] 启动 $BIN（$(date +%H:%M:%S)，上限 mem=$MEM cpu=$CPU time=${TIME}s）" >&2
"$ROOT/scripts/linux-guard.sh" --mem "$MEM" --cpu "$CPU" --time "$TIME" -- "$BIN"
rc=$?

# 收尾：guard 的 unit 已经被 stop 并 KillMode=control-group 收过一遍；
# 这里再兜一层，防止有子进程换组逃逸。
left=$(pgrep -x andeyunhui 2>/dev/null | wc -l)
wk=$(pgrep -c -f "WebKitWebProcess" 2>/dev/null || echo 0)
echo "[run-app] 退出 rc=$rc；残留 andeyunhui=$left WebKitWebProcess=$wk" >&2
if [ "$left" -gt 0 ]; then
  echo "[run-app] 清掉残留 andeyunhui" >&2
  pkill -x andeyunhui 2>/dev/null
fi
free -h | head -2 >&2
exit "$rc"
