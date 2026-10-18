// 来源列表状态（主面板用）：内存 + 订阅，封装 rag_list_sources / rag_delete_source。
//
// 2026-10-18：此前 refresh() 失败时静默返回空数组（catch { sources = [] }），
// 「命令被沙箱拦截」和「知识库真的是空的」在 UI 上完全一样 —— 排查成本极高。
// 现在把错误同时写进 console.error 与 store.error，由面板显式展示。

import { ragDeleteSource, ragListSources, type RagSourceInfo } from '../api/host';

/** 手动知识库命名空间（与 AI 对话 / IDE / 攻防的记忆隔离）。 */
export const RAG_NS_GENERAL = 'general';

type Listener = (sources: RagSourceInfo[]) => void;
type ErrorListener = (error: string | null) => void;

class RagStore {
  private sources: RagSourceInfo[] = [];
  private error: string | null = null;
  private listeners = new Set<Listener>();
  private errorListeners = new Set<ErrorListener>();

  getSources(): RagSourceInfo[] {
    return this.sources;
  }

  getError(): string | null {
    return this.error;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  onError(l: ErrorListener): () => void {
    this.errorListeners.add(l);
    return () => {
      this.errorListeners.delete(l);
    };
  }

  private emit(): void {
    for (const l of this.listeners) l(this.sources);
  }

  private setError(msg: string | null): void {
    this.error = msg;
    for (const l of this.errorListeners) l(msg);
  }

  /** 从后端刷新来源列表。失败时**不再静默**：写 console.error 并广播错误。 */
  async refresh(): Promise<RagSourceInfo[]> {
    try {
      this.sources = await ragListSources(RAG_NS_GENERAL);
      this.setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[rag] 刷新来源失败:', msg);
      this.sources = [];
      this.setError(`来源列表读取失败：${msg}`);
    }
    this.emit();
    return this.sources;
  }

  /** 删除来源并刷新（带 namespace，后端会校验归属）。 */
  async remove(id: string): Promise<void> {
    try {
      await ragDeleteSource(id, RAG_NS_GENERAL);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[rag] 删除来源失败:', msg);
      this.setError(`删除失败：${msg}`);
      return;
    }
    await this.refresh();
  }
}

export const ragStore = new RagStore();
