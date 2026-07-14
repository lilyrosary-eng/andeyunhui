// 预览加载界面（全局设置 → 关于）：点选浅色/深色即全屏打开对应的哥特风加载页，
// 并提供一个「返回」按钮（点击或 Esc 或点击任意处）退出预览。
//
// 关键修复（根治「第二次开始少了点什么」）：把 wait-page 渲染放进独立 <iframe srcdoc>（同源），
// 每次打开都是**全新 document**，加载页自带的 <style>/<script>/requestAnimationFrame/
// setInterval/window.__BOOT_HOSTED__/getElementById 全部隔离在 iframe 内，
// 零跨预览状态污染；rAF / 计时器随 iframe 销毁一并回收，cleanup 只需移除节点，
// 不再需要劫持 setInterval 或手动清理样式（旧实现把内容直接注入主窗口共享 document，会跨预览泄漏）。
//
// 关键（防止"点不了"）：
// 1) 「返回」按钮仍挂载到主 document.body，z-index 最高，任何情况下都点得到；
// 2) 覆盖层（iframe pointer-events:none）本身点击即关闭，Esc 亦关闭，三重保险。

type BootTheme = 'light' | 'dark';

// 复用构建期由 vite.config.ts 生成的 base64（与 index.html 启动页同一可信源）。
// 注意：此前用 `?raw` 导入 wait-page 的 .html，Vite 生产构建会把 .html 当 HTML 入口拦截、
// ?raw 静默失效（dev 正常、build 丢内容），导致打包后预览为空。改用生成模块绕开该坑。
import { WAITING_LIGHT_B64, WAITING_DARK_B64 } from './_waitingPages.generated';

function decodeWaitingPage(b64: string): string {
  // atob() 返回 Latin-1 二进制字符串，需用 TextDecoder 正确解码 UTF-8（否则中文乱码）
  const binStr = atob(b64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

const lightPageHtml = decodeWaitingPage(WAITING_LIGHT_B64);
const darkPageHtml = decodeWaitingPage(WAITING_DARK_B64);

const PREVIEW_ID = 'boot-preview';
const RETURN_ID = 'boot-preview-return';



// 保存当前活动的清理函数，保证重复调用 / 快捷键都能正确移除
let activeCleanup: (() => void) | null = null;

/**
 * 清理可能残留的预览覆盖层（例如旧版本返回按钮失灵时卡住的全屏层）。
 * 在应用挂载时调用一次，避免残留层一直挡住所有点击。
 */
export function clearStaleBootPreview(): void {
  const o = document.getElementById(PREVIEW_ID);
  const rb = document.getElementById(RETURN_ID);
  if (o && o.parentNode) o.parentNode.removeChild(o);
  if (rb && rb.parentNode) rb.parentNode.removeChild(rb);
  activeCleanup = null;
}

/** 构造「返回」按钮（始终挂到 body、层级最高、可点） */
function makeReturnButton(onClose: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = RETURN_ID;
  btn.type = 'button';
  btn.textContent = '← 返回';
  btn.setAttribute('aria-label', '返回设置');
  btn.style.cssText =
    'position:fixed;top:18px;left:18px;z-index:2147483647;' +
    'display:inline-flex;align-items:center;gap:6px;' +
    'padding:8px 14px;border-radius:10px;cursor:pointer;' +
    'pointer-events:auto;' +
    'font:500 14px/1 system-ui,-apple-system,"PingFang SC",sans-serif;' +
    'color:#fff;background:rgba(20,20,26,.42);' +
    'border:1px solid rgba(255,255,255,.28);' +
    'backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);' +
    'transition:background .2s ease;';
  btn.onmouseenter = () => {
    btn.style.background = 'rgba(20,20,26,.62)';
  };
  btn.onmouseleave = () => {
    btn.style.background = 'rgba(20,20,26,.42)';
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    onClose();
  };
  return btn;
}

export function previewBootScreen(theme: BootTheme): void {

  // 若已有预览残留（例如上次没关掉），先彻底清掉再重建，避免覆盖层卡死挡住所有点击
  if (activeCleanup) {
    activeCleanup();
    activeCleanup = null;
  }
  const existing = document.getElementById(PREVIEW_ID);
  if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
  const existingBtn = document.getElementById(RETURN_ID);
  if (existingBtn && existingBtn.parentNode) existingBtn.parentNode.removeChild(existingBtn);

  const overlay = document.createElement('div');
  overlay.id = PREVIEW_ID;
  // 背景与加载页 body 一致（var 取 :root，兜底写死同值，避免 iframe 加载前透出主程序背景）
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:99999;overflow:hidden;' +
    'background:linear-gradient(160deg, var(--bg, #f4f2ec), var(--bg-2, #ece9e1));';

  // 关键修复：预览渲染放进独立 <iframe srcdoc>（同源）。每次打开都是**全新 document**，
  // 加载页自带的 <style>/<script>/requestAnimationFrame/setInterval/window.__BOOT_HOSTED__/
  // getElementById 全部隔离在 iframe 内，零跨预览状态污染 —— 根治「第二次开始少了点什么」。
  // rAF / 计时器随 iframe 销毁一并回收，cleanup 只需移除节点，不再劫持 setInterval 或清理样式。
  const iframe = document.createElement('iframe');
  iframe.setAttribute('srcdoc', theme === 'dark' ? darkPageHtml : lightPageHtml);
  // pointer-events:none：加载页无可交互元素，点击穿透到 overlay 仍可「点任意处关闭」；
  // 不影响 iframe 内 CSS 动画 / rAF / 计时器运行。
  iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;pointer-events:none;';
  overlay.appendChild(iframe);

  // 全局 Esc 退出
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') cleanupFull();
  };

  const cleanupFull = () => {
    window.removeEventListener('keydown', onKey);
    const o = document.getElementById(PREVIEW_ID);
    if (o && o.parentNode) o.parentNode.removeChild(o);
    const rb = document.getElementById(RETURN_ID);
    if (rb && rb.parentNode) rb.parentNode.removeChild(rb);
    activeCleanup = null;
  };
  activeCleanup = cleanupFull;

  overlay.addEventListener('click', cleanupFull);
  window.addEventListener('keydown', onKey);

  document.body.appendChild(overlay);

  // 同步挂载「返回」按钮（不等加载），确保任何情况下都能退出
  document.body.appendChild(makeReturnButton(cleanupFull));
}
