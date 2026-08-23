// AIWork（AIGC 专业模块）独立产物库 —— 记录本地持久化(localStorage)，内容落盘为文件。
// 产出即自动导出为 {name}.md 到「保存主目录」（模块设置里选择），产物区仅存记录；
// 右键「保存」归档移出记录（文件保留）·「删除」移出记录并删本地文件 ·「收藏」「待决」把文件移到对应目录。
import { useCallback, useState } from 'react';
import { storage } from '@/core/storage';
import { uid } from '@/core/ai/util';
import {
  exportProductToFile,
  deleteProductFile,
  moveProductFile,
  loadProductDirs,
} from '@/core/ai/aiWorkProductFiles';

/** 产物媒介类型：当前产出以文本为主；图片/视频在展示层用矩形占位（预留）。 */
export type AiWorkProductKind = 'text' | 'image' | 'video';

export interface AiWorkProduct {
  id: string;
  /** 保存时给产出取的简短名字（默认取标题行前 24 字），也是导出的 .md 文件名 */
  title: string;
  /** 产出正文（Markdown / 纯文本） */
  content: string;
  /** 导出到主目录的本地文件绝对路径；空 = 未配置保存目录而未落盘 */
  path: string;
  /** 产物媒介类型（默认 text） */
  kind: AiWorkProductKind;
  createdAt: number;
}

const PRODUCTS_KEY = 'andeyunhui.aiwork.products';

function normalize(p: Partial<AiWorkProduct> & { id?: string; content?: string }): AiWorkProduct | null {
  if (!p || !p.id || p.content == null) return null;
  return {
    id: p.id,
    title: typeof p.title === 'string' && p.title ? p.title : 'AI 产出',
    content: p.content,
    path: typeof p.path === 'string' ? p.path : '',
    kind: p.kind === 'image' || p.kind === 'video' ? p.kind : 'text',
    createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
  };
}

export function loadProducts(): AiWorkProduct[] {
  return storage
    .getJSON<Array<Partial<AiWorkProduct>>>(PRODUCTS_KEY, [])
    .map(normalize)
    .filter((p): p is AiWorkProduct => p !== null);
}

export function saveProducts(list: AiWorkProduct[]): void {
  storage.setJSON(PRODUCTS_KEY, list.slice(0, 200));
}

/** 产出即落盘 + 记录：把 content 导出为 {title}.md 到主目录，返回带 path 的新产物。 */
export async function addProduct(content: string, title?: string, kind?: AiWorkProductKind): Promise<AiWorkProduct> {
  const t = (title?.trim() || deriveProductTitle(content) || 'AI 产出').slice(0, 40);
  const path = await exportProductToFile(content, t);
  const p: AiWorkProduct = { id: uid(), title: t, content, path, kind: kind ?? 'text', createdAt: Date.now() };
  saveProducts([p, ...loadProducts()]);
  return p;
}

export function deleteProduct(id: string): void {
  saveProducts(loadProducts().filter((p) => p.id !== id));
}

/** AIWork 产物库状态 Hook —— 宿主（Root）托管，共享侧栏产物区 + 视图共用同一份数据。 */
export function useAiWorkProducts() {
  const [products, setProducts] = useState<AiWorkProduct[]>(() => loadProducts());
  const [viewing, setViewing] = useState<AiWorkProduct | null>(null);

  const reload = useCallback(() => setProducts(loadProducts()), []);

  /** 保存一段产出（产出即落盘 + 记录） */
  const save = useCallback(async (content: string, title?: string, kind?: AiWorkProductKind) => {
    const p = await addProduct(content, title, kind);
    reload();
    return p;
  }, [reload]);

  /** 删除：移除记录 + 删除本地文件 */
  const remove = useCallback(async (id: string) => {
    const p = products.find((x) => x.id === id);
    if (p?.path) await deleteProductFile(p.path);
    deleteProduct(id);
    reload();
    setViewing((v) => (v?.id === id ? null : v));
  }, [products, reload]);

  /** 右键「保存」：仅归档移出记录，文件保留在主目录 */
  const archive = useCallback(async (id: string) => {
    deleteProduct(id);
    reload();
    setViewing((v) => (v?.id === id ? null : v));
  }, [reload]);

  /** 右键「收藏」：把文件移到收藏目录（记录保留）；目录未配置时仅保留记录 */
  const fav = useCallback(async (id: string) => {
    const p = products.find((x) => x.id === id);
    if (!p) return;
    const newPath = await moveProductFile(p.path, loadProductDirs().favDir);
    if (newPath && newPath !== p.path) {
      saveProducts(loadProducts().map((x) => (x.id === id ? { ...x, path: newPath } : x)));
      reload();
    }
  }, [products, reload]);

  /** 右键「待决」：把文件移到待决目录（记录保留）；目录未配置时仅保留记录 */
  const pending = useCallback(async (id: string) => {
    const p = products.find((x) => x.id === id);
    if (!p) return;
    const newPath = await moveProductFile(p.path, loadProductDirs().pendingDir);
    if (newPath && newPath !== p.path) {
      saveProducts(loadProducts().map((x) => (x.id === id ? { ...x, path: newPath } : x)));
      reload();
    }
  }, [products, reload]);

  const view = useCallback((p: AiWorkProduct) => setViewing(p), []);
  const back = useCallback(() => setViewing(null), []);

  return { products, viewing, save, remove, archive, fav, pending, view, back };
}

/** 从内容推导产物名：取首行去掉 Markdown 标题符号，截断到 24 字。 */
export function deriveProductTitle(content: string): string {
  const line = (content || '').split('\n').find((l) => l.trim());
  const t = (line || '').replace(/^[#>*\-\s]+/, '').trim();
  return t.length > 24 ? t.slice(0, 24) + '…' : t;
}