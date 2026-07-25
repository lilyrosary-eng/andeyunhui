// 带引用对话组件（设置页内可见）：用户提问 → 语义检索 → 拼装 RAG 上下文 → 流式生成答案 + 引用来源。

const React = window.__HOST_REACT__;
const { useState, useRef } = React;

import { retrieve } from '../retrieve/retriever';
import { RagPromptBuilder } from '../prompt/rag-prompt';
import { streamAiChat } from '../api/host';

function genRequestId(): string {
  return 'rag_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function CitedChat() {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [powered, setPowered] = useState(false);
  const stopRef = useRef<null | (() => void)>(null);

  async function ask() {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setAnswer('');
    setCitations([]);
    setError('');
    setPowered(false);
    try {
      const res = await retrieve(q, { topK: 6 });
      const builder = new RagPromptBuilder();
      builder.set(
        res.results.map((r) => ({
          source_title: r.source_title,
          text: r.text,
          score: r.score,
        })),
      );
      const msgs = builder.buildMessages(q);
      setCitations(res.results.map((r) => r.source_title));
      if (res.results.length === 0) setPowered(true);

      stopRef.current = await streamAiChat({
        requestId: genRequestId(),
        messages: msgs,
        onDelta: (d) => setAnswer((prev) => prev + d),
        onDone: () => {
          setBusy(false);
          stopRef.current?.();
          stopRef.current = null;
        },
        onError: (e) => {
          setError(e);
          setBusy(false);
          stopRef.current?.();
          stopRef.current = null;
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <textarea
          value={question}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setQuestion(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask();
          }}
          placeholder="向知识库提问…（Ctrl/⌘+Enter 发送）"
          rows={2}
          className="flex-1 resize-none rounded-lg border border-neutral-200/60 dark:border-stone-600/60 bg-white/70 dark:bg-stone-800/70 px-3 py-2 text-sm text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-bg)]"
        />
        <button
          onClick={ask}
          disabled={busy || !question.trim()}
          className="btn-press px-4 rounded-lg bg-[var(--element-bg)] text-white text-sm disabled:opacity-50"
        >
          {busy ? '生成中…' : '提问'}
        </button>
      </div>

      {citations.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {citations.map((c, i) => (
            <span
              key={i}
              className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border border-amber-200/60 dark:border-amber-800/40"
              title={c}
            >
              📚 {c}
            </span>
          ))}
        </div>
      )}

      {powered && (
        <div className="text-xs text-neutral-400 dark:text-stone-500">
          知识库中未找到相关信息，以下回答由模型通用知识生成（可能不准确）。
        </div>
      )}

      {answer && (
        <div className="whitespace-pre-wrap rounded-lg border border-neutral-200/60 dark:border-stone-600/60 bg-white/50 dark:bg-stone-900/40 px-3 py-2 text-sm text-neutral-700 dark:text-stone-200 max-h-72 overflow-auto">
          {answer}
        </div>
      )}

      {error && (
        <div className="text-xs text-red-500">⚠ {error}</div>
      )}
    </div>
  );
}
