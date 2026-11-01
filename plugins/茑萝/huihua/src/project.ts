import type { BlendMode } from './types';

export interface HuihuaProjectLayer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  dataUrl: string;
}

export interface HuihuaProject {
  format: 'huihua-project';
  version: 1;
  doc: { w: number; h: number; name: string };
  activeId: string;
  layers: HuihuaProjectLayer[];
  savedAt: number;
}

export interface HuihuaProjectV2Layer {
  id: string;
  name: string;
  visible: boolean;
  opacity: number;
  blend: BlendMode;
  offset: number;
  length: number;
}

export interface HuihuaProjectV2 {
  format: 'huihua-project-binary';
  version: 2;
  doc: { w: number; h: number; name: string };
  activeId: string;
  layers: HuihuaProjectV2Layer[];
  savedAt: number;
}

export const PROJECT_MAGIC = 'HUIHUA2\0';
export const PROJECT_HEADER_OFFSET = 12;

const DB_NAME = 'huihua-project';
const STORE = 'kv';
const KEY = 'autosave';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const factory = window.indexedDB;
    if (!factory) { reject(new Error('IndexedDB 不可用')); return; }
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
}

export async function loadAutosave(): Promise<ArrayBuffer | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => {
        const value = req.result;
        if (value instanceof ArrayBuffer) resolve(value);
        else if (typeof value === 'string') {
          resolve(new TextEncoder().encode(value).buffer as ArrayBuffer);
        } else resolve(null);
      };
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

export async function saveAutosave(data: ArrayBuffer): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    });
  } catch {
    /* 自动保存失败不打断绘制 */
  }
}

export async function clearAutosave(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
    });
  } catch {
    /* 忽略 */
  }
}

export function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图层图片解码失败'));
    img.src = dataUrl;
  });
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
