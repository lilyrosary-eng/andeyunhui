#!/usr/bin/env bash
# ============================================================
#  build-linux.sh —— Linux 一键构建（deb / AppImage）
#
#  对应 Windows 的 `pnpm tauri build`（那条脚本走 dev-env.bat，Linux 上不可用）。
#  串起 Linux 专属前置：环境准备（sccache/pipewire）→ 随包 ffmpeg → tauri build。
#
#  用法：
#    bash scripts/build-linux.sh              # 全量
#    bash scripts/build-linux.sh --bundles deb
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."

# 1) 构建依赖：缺则自动准备（有 sudo 走 apt；无 sudo 走本地解包 .linux-deps）
bash scripts/setup-linux-build-deps.sh

# 2) 环境：未装 sccache 时关闭 rustc-wrapper；注入 .linux-deps 前缀
# shellcheck disable=SC1091
source scripts/linux-dev-env.sh

# 3) 随包分发的 ffmpeg（静态优先；由 prepare-bundled-dlc 再次校验）
node scripts/fetch-ffmpeg-linux.mjs

# 4) 构建（beforeBuildCommand 会跑完整前端 + DLC 打包链）
pnpm exec tauri build "$@"
