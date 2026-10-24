#!/usr/bin/env bash
# deb-reversion.sh —— 只改 Debian 包版本，不动应用内部版本
#
# 为什么需要它（2026-10-24 用户定的规则）：
#   应用版本走 semver（Cargo / tauri.conf 只接受 x.y.z），而用户要的"小版本"是
#   `2.4.2.0.1` 这种 4~5 段式，里程碑才跳到 `2.4.3`。
#   两者不必一致：**包版本（DEBIAN/control 的 Version）**才决定 apt 升不升级，
#   应用内部版本（界面/日志里显示的）仍可以是 2.4.2。
#
# Debian 版本比较是逐段数值比较、段数多者更大 ⇒
#   2.4.2 < 2.4.2.0.1 < 2.4.2.0.2 < 2.4.3
# 完全符合"小步走、到时候一步到位"的诉求。
#
# 用法：
#   scripts/deb-reversion.sh <输入的 .deb> <新版本号>
#   例：scripts/deb-reversion.sh out/andeyunhui_2.4.2_amd64.deb 2.4.2.0.1
set -euo pipefail

DEB="${1:?用法: deb-reversion.sh <deb> <version>}"
VER="${2:?缺少版本号，如 2.4.2.0.1}"

[ -f "$DEB" ] || { echo "找不到 deb: $DEB" >&2; exit 2; }
case "$VER" in
  [0-9]*) : ;;
  *) echo "版本号必须以数字开头（Debian 规则）: $VER" >&2; exit 2 ;;
esac

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

dpkg-deb -R "$DEB" "$tmp/pkg" >/dev/null
old=$(awk -F': ' '/^Version:/{print $2}' "$tmp/pkg/DEBIAN/control")
sed -i "s|^Version: .*|Version: $VER|" "$tmp/pkg/DEBIAN/control"

out="$(dirname "$DEB")/$(basename "$DEB" | sed -E "s/_${old//./\\.}_/_${VER}_/")"
[ "$out" = "$DEB" ] && out="${DEB%.deb}_${VER}.deb"

dpkg-deb --root-owner-group -b "$tmp/pkg" "$out" >/dev/null

echo "[deb-reversion] $old -> $VER" >&2
echo "[deb-reversion] 输出: $out" >&2
echo "$out"
