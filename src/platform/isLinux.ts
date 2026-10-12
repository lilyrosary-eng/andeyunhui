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

/**
 * 是否启用「重合成特效」：backdrop-filter（实时取背模糊）/ 大半径 blur / 大面积实时模糊。
 *
 * 仅非 Linux 启用。原因：Linux(WebKitGTK) + Intel i915 核显下，这类实时滤镜会让合成器
 * **逐帧重做模糊并重新分配 GEM 缓冲**，实测把显存打满直接崩溃（沉浸播放页/漫游页都因此崩过）；
 * Windows 的 WebView2/Chromium 走 D3D 合成路径，天然没有这个问题。
 *
 * ★ 这是全应用**唯一**的重特效判据来源：所有重特效视图一律 `import { HEAVY_FX }`，
 *   禁止各自再写 `!isLinux()` / 各自嗅探 UA（否则就会出现「姊妹视图漏分流」——已发生过多次）。
 *
 * 另：index.css 里还有一层全局兜底（`html.is-linux *` 关闭 backdrop-filter，见 main.tsx 打的
 * 根 class），用于兜住纯 CSS/内联写的 backdrop-filter；本常量用于 JS 里需要按元素决策的场合
 * （如 `filter: blur()` 的封面/背景、`will-change`、`mask-image`）。
 */
export const HEAVY_FX = !isLinux();
