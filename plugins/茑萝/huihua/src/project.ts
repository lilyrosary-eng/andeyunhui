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

export async function loadAutosave(): Promise<string | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null);
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

export async function saveAutosave(json: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(json, KEY);
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
