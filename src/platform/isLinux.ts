/**
 * 平台探测单例 —— Linux 桌面判定。
 *
 * 与同目录 `isMobile.ts` 遵守同一条**语义铁律**：
 *   **禁止在组件内各自 UA 嗅探，一律经此单例。**
 * （`isMobile.ts` 文件头原文；本文件是它的同构补充，不改动它以避免大面积改 import。）
 *
 * 判定策略：`navigator.userAgent`。WebKitGTK（Linux）的 UA 恒含 "Linux"，
 * Windows 的 WebView2 UA 不含 "Linux"，故双平台可靠。
 * 与 `isMobile.ts` 一致，后续若引入 `@tauri-apps/plugin-os` 的权威 `platform()`，
 * 可切换为「platform() 优先 + UA 兜底」，接口保持不变、下游零改动。
 *
 * # 为什么需要它（2026-10-08）
 *
 * 有几处「为绕开 Linux 特有的渲染/窗口问题而做的降级」，**在 Windows 上不该生效**
 * （否则等于用 Linux 的妥协去换 Windows 的观感）：
 *   - `RoamView` 的 backdrop-filter / 大半径 blur：Linux + Intel i915 核显下，
 *     它们会让合成器逐帧重做模糊并重新分配 GEM 缓冲，实测把 8G 打满直接 OOM；
 *     Windows 的 D3D 合成路径没有这个问题。
 *   - `musicPlayer` 的本地音源取址：Linux 必须走本地 HTTP 服务
 *     （WebKitGTK 的媒体加载器不接管 `asset://` 自定义 scheme），Windows 走
 *     `convertFileSrc` 即可。
 */

let cachedLinux: boolean | null = null;

/**
 * 是否运行在 Linux 桌面。
 * 单例缓存：首次调用后结果固化，避免重复 UA 正则匹配。
 */
export function isLinux(): boolean {
  if (cachedLinux !== null) return cachedLinux;
  // 防御性兜底：非浏览器环境（本项目不存在）返回 false
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  cachedLinux = /Linux/i.test(ua);
  return cachedLinux;
}
