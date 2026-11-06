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
  /**
   * 本次检索是否真的走了重排（2026-11-01）。
   * 图谱据此决定「节点半径/线宽」用重排分还是向量分，并在标题里标出排序方式。
   * 可选：老调用方（不传）按向量排序处理。
   */
  reranked?: boolean;
  at: number;
}

type Listener = (sources: RagSourceInfo[]) => void;
type ErrorListener = (error: string | null) => void;
type LastResultListener = (r: LastResult | null) => void;

/** 当前检索排序模式（侧栏灰字用；由检索设置卡片在保存/探测后广播）。 */
export interface RerankInfo {
  /** 一句话：「重排 20 → 6（…）」或「已降级为向量排序」。 */
  text: string;
  /** 是否真的启用了重排。 */
  usable: boolean;
}
type RerankInfoListener = (info: RerankInfo | null) => void;

/** 主面板视图（侧栏也能切换，所以状态放 store 而不是组件内）。 */
export type RagView = 'chat' | 'graph' | 'library' | 'manage' | 'reader';
/** 「看原文」的目标：来源 + 要高亮的字符区间（命中块在文档里的位置）。 */
export interface ReaderTarget {
  sourceId: string;
  /** 命中区间；缺省 = 只打开正文不高亮。 */
  start?: number;
  end?: number;
  /** 从哪次提问进来的，显示在阅读器标题行。 */
  query?: string;
}
type ReaderListener = (t: ReaderTarget | null) => void;
type ViewListener = (v: RagView) => void;
/** 侧栏「再问一次」把问题投递给对话面板。 */
type AskListener = (q: string) => void;
/** 导航聚焦：从命令面板/其它模块跳转到某个来源。 */
type FocusListener = (id: string | null) => void;

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
  private focusId: string | null = null;
  private focusListeners = new Set<FocusListener>();
  private reader: ReaderTarget | null = null;
  private readerListeners = new Set<ReaderListener>();
  /** 打开正文前的视图，「← 返回」回到它 */
  private readerFrom: RagView | null = null;
  private rerankInfo: RerankInfo | null = null;
  private rerankListeners = new Set<RerankInfoListener>();

  /** 检索排序模式（侧栏读；未设置时返回 null，由侧栏自己解析一次）。 */
  getRerankInfo(): RerankInfo | null {
    return this.rerankInfo;
  }

  /** 检索设置卡片保存/探测后广播当前模式。 */
  setRerankInfo(info: RerankInfo | null): void {
    this.rerankInfo = info;
    for (const l of this.rerankListeners) l(info);
  }

  subscribeRerank(l: RerankInfoListener): () => void {
    this.rerankListeners.add(l);
    return () => {
      this.rerankListeners.delete(l);
    };
  }

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

  /** 导航聚焦某条来源：切到管理视图并高亮。 */
  focusSource(id: string | null): void {
    this.focusId = id;
    this.setView('manage');
    for (const l of this.focusListeners) l(id);
  }

  /** 打开来源正文（引用 chip / 图谱节点点进来的「看原文」）。 */
  openReader(t: ReaderTarget): void {
    if (this.view !== 'reader') this.readerFrom = this.view;
    this.reader = t;
    this.setView('reader');
    for (const l of this.readerListeners) l(t);
  }

  /** 返回打开正文前的那个视图。 */
  closeReader(): void {
    this.setView(this.readerFrom ?? 'chat');
  }

  getReader(): ReaderTarget | null {
    return this.reader;
  }

  subscribeReader(l: ReaderListener): () => void {
    this.readerListeners.add(l);
    return () => {
      this.readerListeners.delete(l);
    };
  }

  getFocusId(): string | null {
    return this.focusId;
  }

  subscribeFocus(l: FocusListener): () => void {
    this.focusListeners.add(l);
    return () => {
      this.focusListeners.delete(l);
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
