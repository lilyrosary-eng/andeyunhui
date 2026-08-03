/**
 * 平台探测单例 —— Android v1 唯一事实来源。
 *
 * 设计依据：ANDROID-V1-HANDOFF.md §5.4.2。
 * 语义铁律：禁止在组件内各自 UA 嗅探，一律经此单例。
 *
 * 判定策略（T01 阶段）：
 *   navigator.userAgent 兜底判定。Android WebView 的 UA 恒含 "Android"，
 *   Windows WebView2 的 UA 不含 "Android"，故 UA 判定在双平台均可靠。
 *
 * 🔧 后续若引入 @tauri-apps/plugin-os（权威 platform() API），可将本实现
 *    切换为「platform() 优先 + UA 兜底」，接口（isAndroid / isDesktop）保持不变，
 *    下游零改动。§5.4.2 注释明确允许此降级路径。
 *
 * 桌面端 isAndroid() 恒返回 false —— 这是平台隔离墙的基石，
 * 所有「移动端不加载」的桌面组件分支都依赖此恒真性。
 */

let cachedAndroid: boolean | null = null;

/**
 * 是否运行在 Android 平台。
 * 单例缓存：首次调用后结果固化，避免重复 UA 正则匹配。
 */
export function isAndroid(): boolean {
  if (cachedAndroid !== null) return cachedAndroid;
  // 兜底：navigator.userAgent。SSR / 非浏览器环境（本项目不存在，但防御性处理）下返回 false。
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  cachedAndroid = /Android/i.test(ua);
  return cachedAndroid;
}

/** 桌面 = 非 Android（本项目 v1 不做 iOS）。 */
export const isDesktop = (): boolean => !isAndroid();
