#!/usr/bin/env bash
# ============================================================
#  setup-linux-build-deps.sh —— 解决 Linux 构建机缺少的构建依赖
#
#  覆盖：编译期（pipewire crate 经 bindgen 需 libpipewire/libspa 头文件 + libclang）
#        与打包期（tauri build 出 deb/AppImage 需 patchelf、appindicator）。
#
#  两种模式（自动选择）：
#    A. 有免密 sudo → 直接 apt-get install（一劳永逸，装到系统）
#    B. 无 sudo      → 免 root：apt-get download + dpkg-deb -x 解到仓库内 .linux-deps/，
#                      再由 scripts/linux-dev-env.sh 自动注入 PKG_CONFIG_PATH/PATH。
#
#  用法： bash scripts/setup-linux-build-deps.sh
# ============================================================
set -uo pipefail
cd "$(dirname "$0")/.."

PREFIX="${LINUX_DEPS_PREFIX:-$(pwd)/.linux-deps}"

# 需要 pkg-config 能解析的库（用于编译期）
PKG_NEEDS=(libpipewire-0.3 libspa-0.2 ayatana-appindicator3-0.1)
# 需要可执行文件（用于打包期）
BIN_NEEDS=(patchelf)
# 对应 Debian/Ubuntu 包名
APT_PKGS=(libpipewire-0.3-dev libspa-0.2-dev libayatana-appindicator3-dev patchelf)
# clang 二进制（bindgen 需要 libclang；本机若无 clang 但缺 libclang 才需装）
APT_PKGS_OPTIONAL=(clang)

miss_pkg()  { ! pkg-config --exists "$1" 2>/dev/null; }
miss_bin()  { ! command -v "$1" >/dev/null 2>&1; }

missing=0
for p in "${PKG_NEEDS[@]}"; do miss_pkg "$p" && { echo "缺失(库):  $p"; missing=1; }; done
for b in "${BIN_NEEDS[@]}"; do miss_bin "$b" && { echo "缺失(工具): $b"; missing=1; }; done
# 已解包前缀可满足时也算齐备
if [ -d "$PREFIX" ]; then
  for p in "${PKG_NEEDS[@]}"; do
    PKG_CONFIG_PATH="$PREFIX/usr/lib/x86_64-linux-gnu/pkgconfig" pkg-config --exists "$p" 2>/dev/null \
      && echo "已就绪(本地前缀): $p"
  done
fi

if [ "$missing" -eq 0 ]; then
  echo "[deps] 构建依赖齐备，无需处理。"
  exit 0
fi

echo
echo "[deps] 尝试模式 A：apt-get（需要免密 sudo）..."
if sudo -n true 2>/dev/null; then
  sudo apt-get update -y
  sudo apt-get install -y "${APT_PKGS[@]}" "${APT_PKGS_OPTIONAL[@]}"
  echo "[deps] 已通过 apt-get 安装完成。"
  exit 0
fi

echo "[deps] 无免密 sudo → 模式 B：免 root 解包到 $PREFIX"
command -v dpkg-deb >/dev/null 2>&1 || { echo "[deps] ✗ 缺少 dpkg-deb，无法免 root 解包；请在有 sudo 的机器上运行模式 A。"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$PREFIX"

for pkg in "${APT_PKGS[@]}"; do
  echo "  - 下载并解包: $pkg"
  ( cd "$TMP" && apt-get download "$pkg" >/dev/null 2>&1 ) || { echo "    ⚠ 下载失败: $pkg"; continue; }
done
for deb in "$TMP"/*.deb; do
  [ -e "$deb" ] || continue
  dpkg-deb -x "$deb" "$PREFIX"
done

# 关键：把解包出的 .pc 里的 prefix 重写到本地前缀。
# 为什么不能靠 PKG_CONFIG_SYSROOT_DIR：那会把 clang 的系统头搜索也重定向，
# 导致 bindgen 找不到 stdbool.h（pipewire crate 经 bindgen 生成绑定时会踩）。
for pc in "$PREFIX"/usr/lib/x86_64-linux-gnu/pkgconfig/*.pc; do
  [ -e "$pc" ] || continue
  sed -i "s#^prefix=.*#prefix=$PREFIX/usr#" "$pc"
done

# 关键：-dev 包只提供 `libX.so` 符号链接，其目标 `libX.so.N` 在**运行时包**里（不在本前缀中）。
# 链接期 `-lX` 需要能解析到目标，否则报 `cannot find -lX`。
# 这里把悬空的 .so 目标链接到系统同名运行时库。
LIBDIR="$PREFIX/usr/lib/x86_64-linux-gnu"
for so in "$LIBDIR"/*.so; do
  [ -L "$so" ] || continue
  target="$(basename "$(readlink "$so")")"
  [ -e "$LIBDIR/$target" ] && continue
  for sysdir in /usr/lib/x86_64-linux-gnu /usr/lib /lib/x86_64-linux-gnu; do
    if [ -e "$sysdir/$target" ]; then
      ln -sf "$sysdir/$target" "$LIBDIR/$target"
      echo "  ↳ 补链接: $target -> $sysdir/$target"
      break
    fi
  done
done

# 校验
echo "[deps] 校验本地前缀是否满足 pkg-config："
ok=1
for p in "${PKG_NEEDS[@]}"; do
  if PKG_CONFIG_PATH="$PREFIX/usr/lib/x86_64-linux-gnu/pkgconfig" pkg-config --exists "$p" 2>/dev/null; then
    echo "  ✓ $p"
  else
    echo "  ✗ $p（该包可能本机运行时已满足，或需在带 sudo 的机器安装）"
    ok=0
  fi
done

echo
if [ "$ok" -eq 1 ]; then
  echo "[deps] ✓ 完成。构建前请： source scripts/linux-dev-env.sh"
else
  echo "[deps] ⚠ 部分库未就绪。若仍报缺头，请在有 sudo 的机器上执行："
  echo "       sudo apt-get install -y ${APT_PKGS[*]} ${APT_PKGS_OPTIONAL[*]}"
fi
echo "[deps] 依赖前缀: $PREFIX"
