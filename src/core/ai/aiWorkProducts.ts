// AIWork（AIGC 专业模块）独立产物库 —— 本地持久化，与笔记模块彻底解耦。
// AIGC 产出物（文案 / 文档 / 表格 / 总结等）保存于此，支持产物列表、查看、复制、
// 导出文本文件、删除。产物仅存于本地 localStorage，不写入笔记库。
import { useCallback, useState } from 'react';
import { storage } from '@/core/storage';
import { uid } from '@/core/ai/util';

export interface AiWorkProduct {
  id: string;
  /** 保存时给产出取的简短名字（默认取标题行前 24 字） */
  title: string;
  /** 产出正文（Markdown / 纯文本） */
  content: string;
  createdAt: number;
}

const PRODUCTS_KEY = 'andeyunhui.aiwork.products';

export function loadProducts(): AiWorkProduct[] {
  return storage.getJSON<AiWorkProduct[]>(PRODUCTS_KEY, []).filter((p) => p && p.id && p.content != null);
}

export function saveProducts(list: AiWorkProduct[]): void {
  storage.setJSON(PRODUCTS_KEY, list.slice(0, 200));
}

/** 把一段产出存进产物库，返回新产物。title 为空则按首行推一个。 */
export function addProduct(content: string, title?: string): AiWorkProduct {
  const t = (title?.trim() || deriveProductTitle(content) || 'AI 产出').slice(0, 40);
  const p: AiWorkProduct = { id: uid(), title: t, content, createdAt: Date.now() };
  saveProducts([p, ...loadProducts()]);
  return p;
}

export function deleteProduct(id: string): void {
  saveProducts(loadProducts().filter((p) => p.id !== id));
}

/** AIWork 产物库状态 Hook —— 把产物列表 / 查看状态集中到宿主（Root）托管，
 *  以便共享侧栏（AiChatSidebar）复用同一份数据渲染产物列表，视图组件只拿当前查看的产物。 */
export function useAiWorkProducts() {
  const [products, setProducts] = useState<AiWorkProduct[]>(() => loadProducts());
  const [viewing, setViewing] = useState<AiWorkProduct | null>(null);

  /** 保存一段产出（供视图的「保存到产物库」触发），返回新产物 */
  const save = useCallback((content: string, title?: string) => {
    const p = addProduct(content, title);
    setProducts(loadProducts());
    return p;
  }, []);

  const remove = useCallback((id: string) => {
    deleteProduct(id);
    setProducts(loadProducts());
    setViewing((v) => (v?.id === id ? null : v));
  }, []);

  const view = useCallback((p: AiWorkProduct) => setViewing(p), []);
  const back = useCallback(() => setViewing(null), []);

  return { products, viewing, save, remove, view, back };
}

/** 从内容推导产物名：取首行去掉 Markdown 标题符号，截断到 24 字。 */
export function deriveProductTitle(content: string): string {
  const line = (content || '').split('\n').find((l) => l.trim());
  const t = (line || '').replace(/^[#>*\-\s]+/, '').trim();
  return t.length > 24 ? t.slice(0, 24) + '…' : t;
}