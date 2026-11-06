// 把「右键命中的 DOM」翻译成 registry 用的纯数据描述。
//
// 单独成文件的原因：这一步是唯一碰 DOM 的判据层，把它和「该显示哪些项」分开后，
// 两边的错都能各自被单测钉住（这里用假元素测，不需要 jsdom）。

import type { ContextMenuTargetInfo } from './registry';

const EDITABLE_SELECTOR = 'input,textarea,[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';

function readHref(el: Element): string | null {
  const anchor = el.closest<HTMLAnchorElement>('a[href]');
  return anchor ? anchor.getAttribute('href') : null;
}

function readImageSrc(el: Element): string | null {
  const img = el.closest<HTMLImageElement>('img');
  // getAttribute 而不是 .src：.src 会被绝对化成完整 URL，本地路径判定会跑偏
  return img ? img.getAttribute('src') : null;
}

/**
 * 目标元素 → 上下文描述。
 * selectionText 与 moduleId 由调用方给出（选区是 document 级状态，模块是应用状态，
 * 都不该在这里现取 —— 否则这个函数就没法在 node 里测）。
 */
export function describeContextMenuTarget(
  el: Element,
  info: { selectionText: string; moduleId: string | null },
): ContextMenuTargetInfo {
  const editable = el.closest(EDITABLE_SELECTOR);
  const anchor = el.closest('a[href]');
  const image = el.closest('img');
  const governing = anchor || image || editable || el;
  const tag = (governing.tagName || el.tagName || '').toUpperCase();
  const readOnly = editable
    ? ((editable as HTMLInputElement).readOnly === true || (editable as HTMLInputElement).disabled === true)
    : false;

  return {
    tag,
    editable: !!editable,
    readOnly,
    linkHref: readHref(el),
    imageSrc: readImageSrc(el),
    selectionText: (info.selectionText || '').trim(),
    moduleId: info.moduleId,
  };
}

/** 当前选区文本（无选区或折叠时给空串） */
export function currentSelectionText(): string {
  try {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed) return '';
    return sel.toString();
  } catch {
    return '';
  }
}
