/**
 * 原生拖放拿到的是**路径**，而很多既有 drop 逻辑吃的是 `File` 对象
 * （FileReader / File.arrayBuffer / formData）。
 *
 * 因为主窗口改成了 `dragDropEnabled: true`（wry 接管拖放、阻止 WebKit 导航），
 * DOM 的 drop 不再触发，`dataTransfer.files` 也拿不到了 —— 这些地方只能
 * 「路径 → 经后端读回字节 → 造一个 File」，保持下游逻辑零改动。
 *
 * 读取走已有的 `read_file_base64` 命令（Tauri 侧已注册）。
 */
import { invoke } from '@tauri-apps/api/core';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
  avif: 'image/avif', heic: 'image/heic', heif: 'image/heif', tiff: 'image/tiff',
  mp4: 'video/mp4', mkv: 'video/x-matroska', mov: 'video/quicktime',
  webm: 'video/webm', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg',
  m4a: 'audio/mp4', aac: 'audio/aac',
  pdf: 'application/pdf', epub: 'application/epub+zip',
  json: 'application/json', xml: 'application/xml', csv: 'text/csv',
  md: 'text/markdown', txt: 'text/plain', html: 'text/html', css: 'text/css',
  js: 'text/javascript', ts: 'text/typescript', tsx: 'text/typescript',
  py: 'text/x-python', rs: 'text/x-rust', go: 'text/x-go', sh: 'text/x-sh',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function basename(p: string): string {
  const seg = p.split(/[/\\]/).filter(Boolean);
  return seg[seg.length - 1] || 'file';
}

export function extOf(p: string): string {
  const n = basename(p);
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(i + 1).toLowerCase() : '';
}

export function mimeOf(p: string): string {
  return MIME_BY_EXT[extOf(p)] ?? 'application/octet-stream';
}

/** 路径 → base64 原始字节（不含 data: 前缀） */
async function readBase64(p: string): Promise<string> {
  return await invoke<string>('read_file_base64', { filePath: p });
}

/** 路径 → data URL（图片预览 / OCR 上传都用这个） */
export async function pathToDataUrl(p: string): Promise<string> {
  const b64 = await readBase64(p);
  return b64.startsWith('data:') ? b64 : `data:${mimeOf(p)};base64,${b64}`;
}

/** 路径 → File 对象（给只能吃 File 的既有逻辑，如 FileReader / arrayBuffer） */
export async function pathToFile(p: string): Promise<File> {
  const b64 = (await readBase64(p)).replace(/^data:[^;]+;base64,/, '');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], basename(p), { type: mimeOf(p) });
}

/** 路径 → 文本（笔记插入等） */
export async function pathToText(p: string): Promise<string> {
  return await invoke<string>('read_dropzone_file', { storedPath: p }).catch(async () => {
    // 回退：用 base64 自行解码
    const b64 = (await readBase64(p)).replace(/^data:[^;]+;base64,/, '');
    return new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  });
}
