#!/usr/bin/env bash
# ============================================================
#  linux-dev-env.sh —— Linux 下的 Tauri dev/build 环境准备
#  与 Windows 的 dev-env.bat 对应（那边载入 MSVC 环境；这边处理 Linux 专属前置）。
#
#  用法：  source scripts/linux-dev-env.sh
#  然后：  pnpm exec tauri dev / pnpm exec tauri build   （或 pnpm build:linux）
#
#  处理三件事：
#   1) sccache：仓库 src-tauri/.cargo/config.toml 全局设了 rustc-wrapper="sccache"
#      （Windows 机装了）。Linux 未装 sccache 时 cargo 会直接以
#      「could not execute process sccache」失败 —— 未装则在此关闭该包装。
#   2) 本地解包前缀 .linux-deps/（无 sudo 场景，见 scripts/setup-linux-build-deps.sh）：
#      注入 PKG_CONFIG_PATH / PATH(patchelf) / bindgen 头路径。
#   3) 提示缺失依赖时引导运行 setup-linux-build-deps.sh。
# ============================================================

_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPS_PREFIX="${LINUX_DEPS_PREFIX:-$_REPO_ROOT/.linux-deps}"

# 1) sccache：未安装则关闭 rustc wrapper（否则 cargo 直接报错）
if command -v sccache >/dev/null 2>&1; then
  # 服务端常驻，跨构建复用产物；未启动时 sccache 会自己拉起
  sccache --start-server >/dev/null 2>&1 || true
  echo "[linux-dev-env] sccache 就绪（$(sccache --version 2>/dev/null | head -1)）"
else
  export RUSTC_WRAPPER=""
  echo "[linux-dev-env] 未检测到 sccache —— 已关闭 rustc-wrapper（RUSTC_WRAPPER=）"
fi

# 1b) 快链接器：装了 lld/mold 就用（GNU ld 是单线程，release 链接能占掉几分钟）
#     有则以 -fuse-ld 方式交给现有 cc 驱动，不改 .cargo/config.toml（Windows 段不受影响）。
if command -v ld.lld >/dev/null 2>&1; then
  export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-fuse-ld=lld"
  echo "[linux-dev-env] 使用 lld 链接（-fuse-ld=lld）"
elif command -v mold >/dev/null 2>&1; then
  export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-fuse-ld=mold"
  echo "[linux-dev-env] 使用 mold 链接（-fuse-ld=mold）"
else
  echo "[linux-dev-env] 未装 lld/mold —— 仍用 GNU ld（慢）。建议：sudo apt install -y lld"
fi

# 2) 本地解包前缀（无 root 安装的构建依赖）
if [ -d "$DEPS_PREFIX/usr/lib/x86_64-linux-gnu/pkgconfig" ]; then
  export PKG_CONFIG_PATH="$DEPS_PREFIX/usr/lib/x86_64-linux-gnu/pkgconfig:${PKG_CONFIG_PATH:-}"
  export PATH="$DEPS_PREFIX/usr/bin:${PATH}"   # patchelf 等打包工具
  # bindgen（pipewire crate）需要能定位 C 头：补 pipewire/spa + 系统 include + gcc 的 include
  GCC_INC="$(ls -d /usr/lib/gcc/x86_64-linux-gnu/*/include 2>/dev/null | tail -1)"
  export BINDGEN_EXTRA_CLANG_ARGS="-I$DEPS_PREFIX/usr/include/pipewire-0.3 -I$DEPS_PREFIX/usr/include/spa-0.2 -I/usr/include -I/usr/include/x86_64-linux-gnu ${GCC_INC:+-I$GCC_INC}"
  echo "[linux-dev-env] 已启用本地构建依赖前缀: $DEPS_PREFIX"
else
  echo "[linux-dev-env] 未发现本地依赖前缀（.linux-deps/）；若编译报缺 pipewire/ayatana，请先运行："
  echo "[linux-dev-env]   bash scripts/setup-linux-build-deps.sh   （无 sudo 也可用）"
fi

echo "[linux-dev-env] 环境就绪（RUSTC_WRAPPER='${RUSTC_WRAPPER:-<默认>}'）"
