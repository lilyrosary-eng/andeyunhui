#!/usr/bin/env bash
# ============================================================
#  linux-dev.sh —— 日常迭代用（前端热更，不重编 Rust）
#
#  为什么用它：release 打包会把 dist/ 用 `generate_context!` 嵌进二进制，
#  于是**改一行 CSS 也要把整个 lib crate 重编一遍**（本机约 15 分钟）。
#  `tauri dev` 走 vite dev server 直接喂页面，前端改动 1 秒内热更，
#  只有真正改了 Rust 才需要重新编译（而且只编改动的 crate）。
#
#  用法：  bash scripts/linux-dev.sh
#  退出：  Ctrl+C（会同时关掉 vite 与应用；残留 WebKit 由 run-app 逻辑不涉及）
#
#  需要出 deb 时仍走构建：./scripts/linux-guard.sh ... tauri build --bundles deb
# ============================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# shellcheck source=/dev/null
source scripts/linux-dev-env.sh

echo "[linux-dev] 启动 tauri dev（前端热更；改 Rust 才会重编）"
exec node node_modules/@tauri-apps/cli/tauri.js dev "$@"
