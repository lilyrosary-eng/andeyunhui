// 右键菜单各项的真正执行动作。
//
// 这里的每一条都只被菜单调用，不做二次封装：能直接调用现成 API 的（剪贴板 / opener /
// download_file）就直接调，需要照顾 React 受控组件的地方单独说明 —— 例如
// setRangeText 不会派发 input 事件，漏了这一步，粘贴进去的内容在保存时会被旧 state 覆盖掉。

import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { navigateTo } from '@/core/navigation/navigation';
import { parseDeepLink } from '@/core/navigation/deepLink';

const EDITABLE_SELECTOR = 'input,textarea,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';

function textFieldOf(el: Element | null): HTMLTextAreaElement | HTMLInputElement | null {
  const hit = el?.closest?.(EDITABLE_SELECTOR) || null;
  if (hit instanceof HTMLTextAreaElement || hit instanceof HTMLInputElement) return hit;
  return null;
}

function editableRoot(el: Element | null): HTMLElement | null {
  const hit = el?.closest?.('[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]') || null;
  return hit as HTMLElement | null;
}

async function writeText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch (err) {
    console.warn('[context-menu] 写入剪贴板失败:', err);
  }
}

export async function copyText(text: string): Promise<void> {
  await writeText(text);
}

/** 剪切：先复制成功再删源，复制失败就什么都不动（宁可没剪切，也不能把内容弄丢） */
export async function cutSelection(el: Element | null, text: string): Promise<void> {
  const field = textFieldOf(el);
  if (field) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.warn('[context-menu] 剪切前复制失败，已放弃删除:', err);
      return;
    }
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? field.value.length;
    field.focus();
    field.setRangeText('', start, end, 'start');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const root = editableRoot(el);
  if (root) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      console.warn('[context-menu] 剪切前复制失败，已放弃删除:', err);
      return;
    }
    root.focus();
    // execCommand 已废弃，但它是唯一保住浏览器撤销栈的路径；失败就退化为不删
    try { document.execCommand('cut'); } catch { /* 忽略 */ }
  }
}

export async function pasteInto(el: Element | null): Promise<void> {
  let text = '';
  try {
    text = await navigator.clipboard.readText();
  } catch (err) {
    console.warn('[context-menu] 读取剪贴板失败（多为权限未授予）:', err);
    return;
  }
  if (!text) return;
  const field = textFieldOf(el);
  if (field) {
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? field.value.length;
    field.focus();
    // setRangeText 不派发 input 事件，React 收不到 → 手动补一次，否则受控值还是旧的
    field.setRangeText(text, start, end, 'end');
    field.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  const root = editableRoot(el);
  if (root) {
    root.focus();
    try { document.execCommand('insertText', false, text); } catch { /* 忽略 */ }
  }
}

export function selectAllIn(el: Element | null): void {
  const field = textFieldOf(el);
  if (field) { field.focus(); field.select(); return; }
  const root = editableRoot(el);
  if (root) {
    root.focus();
    try { document.execCommand('selectAll'); } catch { /* 忽略 */ }
  }
}

/** 打开链接：深链走导航契约，其余交给系统浏览器（在 webview 里直接跳转会把应用换掉） */
export async function openHref(href: string): Promise<void> {
  const deep = parseDeepLink(href);
  if (deep) {
    const handled = await navigateTo(deep);
    if (!handled) console.warn('[context-menu] 深链没有模块接收:', deep.module);
    return;
  }
  try {
    await openUrl(href);
  } catch (err) {
    console.warn('[context-menu] 打开链接失败:', err);
  }
}

export async function copyImage(src: string): Promise<void> {
  try {
    const blob = await (await fetch(src)).blob();
    // 剪贴板图片事实标准只有 PNG；非 PNG 先过一遍 canvas 转码
    const png = blob.type === 'image/png' ? blob : await toPngBlob(blob);
    if (!png) return;
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  } catch (err) {
    console.warn('[context-menu] 复制图片失败:', err);
  }
}

async function toPngBlob(blob: Blob): Promise<Blob | null> {
  try {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    URL.revokeObjectURL(url);
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));
  } catch (err) {
    console.warn('[context-menu] 图片转 PNG 失败:', err);
    return null;
  }
}

/** 另存图片：远程地址走后端下载（带保存对话框），本地 asset 本来就在盘上，不显示这一项 */
export async function saveImageAs(src: string): Promise<void> {
  const fileName = (src.split(/[?#]/)[0].split(/[\\/]/).pop() || 'image.png').replace(/[\\/:*?"<>|]/g, '_');
  const target = await saveDialog({ defaultPath: fileName, filters: [{ name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
  if (!target) return;
  try {
    await invoke('download_file', { url: src, savePath: target });
  } catch (err) {
    console.warn('[context-menu] 另存图片失败:', err);
  }
}

export function openCommandPalette(): void {
  window.dispatchEvent(new CustomEvent('open-command-palette'));
}
