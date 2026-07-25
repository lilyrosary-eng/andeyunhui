// 来源列表状态（设置页用）：内存 + 订阅，封装 rag_list_sources / rag_delete_source。

import { ragDeleteSource, ragListSources, type RagSourceInfo } from '../api/host';

type Listener = (sources: RagSourceInfo[]) => void;

class RagStore {
  private sources: RagSourceInfo[] = [];
  private listeners = new Set<Listener>();

  getSources(): RagSourceInfo[] {
    return this.sources;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  private emit(): void {
    for (const l of this.listeners) l(this.sources);
  }

  /** 从后端刷新来源列表。 */
  async refresh(): Promise<RagSourceInfo[]> {
    try {
      this.sources = await ragListSources();
    } catch (e) {
      // 数据库尚未初始化等情况：静默返回空，不阻塞 UI
      console.warn('[rag] 刷新来源失败：', e);
      this.sources = [];
    }
    this.emit();
    return this.sources;
  }

  /** 删除来源并刷新。 */
  async remove(id: string): Promise<void> {
    await ragDeleteSource(id);
    await this.refresh();
  }
}

export const ragStore = new RagStore();
