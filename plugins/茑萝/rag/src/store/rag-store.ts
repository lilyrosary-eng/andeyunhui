// 来源列表状态（主面板用）：内存 + 订阅，封装 rag_list_sources / rag_delete_source。
//
// 2026-10-18：此前 refresh() 失败时静默返回空数组（catch { sources = [] }），
// 「命令被沙箱拦截」和「知识库真的是空的」在 UI 上完全一样 —— 排查成本极高。
// 现在把错误同时写进 console.error 与 store.error，由面板显式展示。

import { ragDeleteSource, ragListSources, type RagHit, type RagSourceInfo } from '../api/host';

/** 手动知识库命名空间（与 AI 对话 / IDE / 攻防的记忆隔离）。 */
export const RAG_NS_GENERAL = 'general';

/** 最近一次检索的结果（供「图谱」视图复用，避免重复检索）。 */
export interface LastResult {
  query: string;
  hits: RagHit[];
  /** 被阈值过滤掉的条数（图谱里显示"有 N 条被丢弃"）。 */
  dropped: number;
  at: number;
}

type Listener = (sources: RagSourceInfo[]) => void;
type ErrorListener = (error: string | null) => void;
type LastResultListener = (r: LastResult | null) => void;

/** 主面板视图（侧栏也能切换，所以状态放 store 而不是组件内）。 */
export type RagView = 'chat' | 'graph' | 'manage';
type ViewListener = (v: RagView) => void;
/** 侧栏「再问一次」把问题投递给对话面板。 */
type AskListener = (q: string) => void;

class RagStore {
  private sources: RagSourceInfo[] = [];
  private error: string | null = null;
  private last: LastResult | null = null;
  private listeners = new Set<Listener>();
  private errorListeners = new Set<ErrorListener>();
  private lastListeners = new Set<LastResultListener>();
  private view: RagView = 'chat';
  private viewListeners = new Set<ViewListener>();
  private askListeners = new Set<AskListener>();

  getView(): RagView {
    return this.view;
  }

  setView(v: RagView): void {
    if (this.view === v) return;
    this.view = v;
    for (const l of this.viewListeners) l(v);
  }

  subscribeView(l: ViewListener): () => void {
    this.viewListeners.add(l);
    return () => {
      this.viewListeners.delete(l);
    };
  }

  /** 侧栏「再问一次」：把问题投递给对话面板（面板自己负责填入输入框）。 */
  ask(q: string): void {
    for (const l of this.askListeners) l(q);
  }

  onAsk(l: AskListener): () => void {
    this.askListeners.add(l);
    return () => {
      this.askListeners.delete(l);
    };
  }

  getSources(): RagSourceInfo[] {
    return this.sources;
  }

  getError(): string | null {
    return this.error;
  }

  getLastResult(): LastResult | null {
    return this.last;
  }

  /** 记录最近一次检索（对话面板写入，图谱视图读取）。 */
  setLastResult(r: LastResult | null): void {
    this.last = r;
    for (const l of this.lastListeners) l(r);
  }

  subscribeLastResult(l: LastResultListener): () => void {
    this.lastListeners.add(l);
    return () => {
      this.lastListeners.delete(l);
    };
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
