// Prompt 模板唯一位置。
//
// 所有 RAG 对话的系统指令、上下文拼装逻辑都集中在此文件，避免散落各处导致
// 「系统提示词 / RAG 标注」不一致（原 IDE MiniSearch 那套「RAG/语义」标注已迁移到此处）。

/** 固定系统指令（知识库助手）。 */
export const RAG_SYSTEM_PROMPT =
  '你是安得云荟本地知识库助手。仅依据下方【上下文】回答；若上下文不足，明确说明「知识库中未找到相关信息」，禁止编造。请附上来源标题。';

/** 注入 LLM 的上下文字符上限。 */
export const RAG_CONTEXT_MAX_CHARS = 6000;

export interface RagContextItem {
  source_title: string;
  text: string;
  score: number;
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * RAG 上下文构建器 + 对话消息组装。
 * 用法：add/set 检索结果 → buildContext() 得到拼接上下文 → buildMessages(question) 得到对话消息。
 */
export class RagPromptBuilder {
  private items: RagContextItem[] = [];

  add(item: RagContextItem): void {
    this.items.push(item);
  }

  set(items: RagContextItem[]): void {
    this.items = items;
  }

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }

  /** 按 maxChars 截断拼装【上下文】。 */
  buildContext(maxChars: number = RAG_CONTEXT_MAX_CHARS): string {
    if (this.items.length === 0) return '';
    const parts: string[] = [];
    let total = 0;
    for (const it of this.items) {
      const block = `【来源：${it.source_title}】（相似度 ${it.score.toFixed(3)}）\n${it.text}`;
      if (total + block.length > maxChars) {
        const remain = Math.max(0, maxChars - total);
        parts.push(block.slice(0, remain) + '\n…（上下文截断）');
        break;
      }
      parts.push(block);
      total += block.length;
    }
    return parts.join('\n\n---\n\n');
  }

  /** 组装完整对话消息（注入系统指令 + 上下文 + 用户问题）。 */
  buildMessages(
    question: string,
    maxChars: number = RAG_CONTEXT_MAX_CHARS,
  ): ChatTurn[] {
    const ctx = this.buildContext(maxChars);
    const system = ctx
      ? `${RAG_SYSTEM_PROMPT}\n\n【上下文】\n${ctx}`
      : RAG_SYSTEM_PROMPT;
    return [
      { role: 'system', content: system },
      { role: 'user', content: question },
    ];
  }
}
