#!/usr/bin/env bash
# 分段推送：代理慢且会掐长连接（CONNECT tunnel 502 / schannel close_notify），
# 一次性推 36 个提交必然失败。改为按提交分批推，每批完成后 origin/main 前进一段，
# 下一批只需推增量 —— 单次负载小得多，且失败可重试、不会整体回退。
set -u

cd /c/Users/Rosary/Desktop/andeyunhui || exit 1

# 线性历史校验：分段推 <sha>:main 要求每个 sha 都是 HEAD 的祖先（fast-forward）
merges=$(git rev-list --merges origin/main..HEAD 2>/dev/null | wc -l)
if [ "$merges" -ne 0 ]; then
  echo "✗ 历史里有 $merges 个 merge 提交，不能按 sha 分段落盘，改为一次性推送"
  CHUNK=999
else
  CHUNK=6
fi

commits=($(git rev-list --reverse origin/main..HEAD))
total=${#commits[@]}
echo "待推送提交数: $total，每批 $CHUNK 个"

i=0
batch=0
while [ "$i" -lt "$total" ]; do
  j=$((i + CHUNK - 1))
  [ "$j" -ge "$total" ] && j=$((total - 1))
  sha=${commits[$j]}
  batch=$((batch + 1))

  ok=0
  for attempt in 1 2 3 4 5; do
    if git -c http.version=HTTP/1.1 push --quiet origin "$sha:main" >/tmp/ade-push.log 2>&1; then
      ok=1
      break
    fi
    echo "  批 $batch 第 $attempt 次失败: $(tail -1 /tmp/ade-push.log)"
    sleep $((attempt * 3))
  done

  if [ "$ok" -ne 1 ]; then
    echo "✗ 批 $batch 连续 5 次失败，已推送到 $(git rev-parse --short origin/main)，中止"
    exit 1
  fi

  echo "✓ 批 $batch：推到 $(git rev-parse --short "$sha")（第 $((j + 1))/$total 个提交）"
  i=$((j + 1))
done

echo ""
echo "=== 最终状态 ==="
git fetch --quiet origin 2>/dev/null
git status -sb | head -1
echo "本地 HEAD : $(git rev-parse --short HEAD)"
echo "origin/main: $(git rev-parse --short origin/main)"
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then
  echo "✓ 已完全同步"
else
  echo "✗ 仍有差异：$(git rev-list --count origin/main..HEAD) 个提交未推送"
  exit 1
fi
