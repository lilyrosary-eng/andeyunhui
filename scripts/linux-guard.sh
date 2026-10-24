#!/usr/bin/env bash
# linux-guard.sh —— 受限运行器：任何"可能吃内存 / 开 GUI / 编译 / 跑基准"的实验都必须走它
#
# 背景（2026-10-24 血案）：我反复起 GUI 应用 + 并行 release 构建，把整台机器拖到关机，
# 而且是硬断电 —— journal 都没落盘，连 OOM 证据都留不下。所以不能靠"事后看日志"，
# 必须在**跑之前**把上限定死，并且让超额的那部分**只死自己**。
#
# 做法：把命令放进 systemd 瞬态单元（cgroup v2），给它
#   MemoryMax       硬上限：超了内核只杀这个 cgroup 里的进程，不碰系统
#   MemorySwapMax=0 禁止用 swap 续命（否则是"卡死"而不是"被杀"）
#   CPUQuota        不把全部核心占满，保留交互
#   KillMode=control-group  结束时连 WebKit / 子进程一起收，不留孤儿
#
# 用法：
#   scripts/linux-guard.sh -- <命令...>
#   scripts/linux-guard.sh --mem 2G --cpu 300% --time 300 -- ./app
#   scripts/linux-guard.sh --dry-run --mem 512M -- python3 -c '...'
#
# 退出码：命令自身退出码；超时 124；被 cgroup 杀 137；预检拒绝 3/4。
set -uo pipefail

MEM="3G"
SWAP="0"
CPU="300%"
TIME="300"
DRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --mem) MEM="$2"; shift 2 ;;
    --swap) SWAP="$2"; shift 2 ;;
    --cpu) CPU="$2"; shift 2 ;;
    --time) TIME="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --) shift; break ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "[guard] 未知参数: $1" >&2; exit 2 ;;
  esac
done

if [ $# -eq 0 ]; then
  echo "[guard] 缺少要执行的命令（用 -- 分隔）" >&2
  exit 2
fi

parse_mb() {
  case "$1" in
    *[Gg]) echo $(( ${1%[Gg]} * 1024 )) ;;
    *[Mm]) echo "${1%[Mm]}" ;;
    *[Kk]) echo $(( ${1%[Kk]} / 1024 )) ;;
    *)     echo "$1" ;;
  esac
}

# ---------- 预检 ----------
if [ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null)" != "cgroup2fs" ]; then
  echo "[guard] 拒绝运行：不是 cgroup v2，无法做内存硬限制" >&2
  exit 3
fi
# 注意：is-system-running 在 degraded 下返回非 0，但 degraded 仍能建单元 ⇒ 不能用它当判据
if ! systemctl --user show --property=Version >/dev/null 2>&1; then
  echo "[guard] 拒绝运行：user systemd 不可达" >&2
  exit 3
fi

MEM_MB=$(parse_mb "$MEM")
AVAIL_MB=$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo)
# 余量取「上限 + 固定 2G」而不是「上限×2」：上限由 cgroup 硬保证，额外只需要给系统留一点，
# 否掉 ×2 会在机器本来就忙时无谓拒绝（2026-10-24 实测被拒了一次）。
NEED_MB=$(( MEM_MB + 2048 ))
if [ "$AVAIL_MB" -lt "$NEED_MB" ]; then
  echo "[guard] 拒绝运行：当前可用 ${AVAIL_MB}MB < 需要的 ${NEED_MB}MB（上限 ${MEM} + 2G 余量）" >&2
  exit 4
fi

UNIT="andy-guard-$$-$(date +%s)"
TIME_BIN=$(command -v /usr/bin/time || true)
CMD=("$@")
[ -n "$TIME_BIN" ] && CMD=("$TIME_BIN" -v "${CMD[@]}")

SYSD=(systemd-run --user --quiet --unit="$UNIT"
      -p "MemoryMax=$MEM" -p "MemorySwapMax=$SWAP" -p "CPUQuota=$CPU"
      -p "KillMode=control-group" -p "TimeoutStopSec=10"
      --wait --pipe --)
FULL=("${SYSD[@]}" timeout --kill-after=5 -s TERM "$TIME" "${CMD[@]}")

if [ "$DRY" -eq 1 ]; then
  printf '[guard] %q ' "${FULL[@]}"; echo
  exit 0
fi

echo "[guard] 上限 mem=$MEM swap=$SWAP cpu=$CPU time=${TIME}s ；当前可用 ${AVAIL_MB}MB" >&2

CG_DIR="/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/app.slice/${UNIT}.service"

# ---------- 执行（后台）+ 前台采样 ----------
# 采样必须放在**主 shell**：放进子 shell 会继承 stdout，调用方用管道时会一直等不到 EOF
# （我踩过：命令早跑完了，`| tail` 挂了几分钟）。
"${FULL[@]}" &
UPID=$!

PEAK_MB=0
while kill -0 "$UPID" 2>/dev/null; do
  if [ -d "$CG_DIR" ]; then
    cur=$(cat "$CG_DIR/memory.current" 2>/dev/null || true)
    pk=$(cat "$CG_DIR/memory.peak" 2>/dev/null || true)
    m=0; [ -n "${cur:-}" ] && m=$(( cur / 1048576 ))
    p=$m; [ -n "${pk:-}" ] && p=$(( pk / 1048576 ))
    [ "$p" -gt "$PEAK_MB" ] && PEAK_MB=$p
    # 主动刹车：到上限 110% 就停单元（MemoryMax 是内核硬限，这层只是让它早点死）
    if [ "$m" -gt $(( MEM_MB * 11 / 10 )) ]; then
      echo "[guard] 看门狗：cgroup 用量 ${m}MB 超过上限 ${MEM}，停止单元" >&2
      systemctl --user stop "$UNIT.service" >/dev/null 2>&1
      break
    fi
  fi
  sleep 1
done
wait "$UPID"; rc=$?

# 补一次峰值：极短命的进程可能一次采样都没赶上（1s 粒度）
if [ -d "$CG_DIR" ] && [ -r "$CG_DIR/memory.peak" ]; then
  p=$(( $(cat "$CG_DIR/memory.peak" 2>/dev/null || echo 0) / 1048576 ))
  [ "$p" -gt "$PEAK_MB" ] && PEAK_MB=$p
fi
mp=$(systemctl --user show -p MemoryPeak --value "$UNIT.service" 2>/dev/null || true)
if [ -n "${mp:-}" ] && [ "$mp" -ge 0 ] 2>/dev/null; then
  p=$(( mp / 1048576 )); [ "$p" -gt "$PEAK_MB" ] && PEAK_MB=$p
fi

echo "[guard] cgroup 峰值内存: ${PEAK_MB}MB（上限 ${MEM}）" >&2

# ---------- 收尾 ----------
systemctl --user stop "$UNIT.service" >/dev/null 2>&1
systemctl --user reset-failed "$UNIT.service" >/dev/null 2>&1

case "$rc" in
  124|137) echo "[guard] 结束：rc=$rc（124=超时 / 137=被 cgroup 杀掉，系统未受影响）" >&2 ;;
  *)      echo "[guard] 结束：rc=$rc" >&2 ;;
esac
exit "$rc"
