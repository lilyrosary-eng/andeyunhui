// 桌面版「四层记忆系统」设置面板：L1 核心档案 / L2 滚动摘要 / L3 语义检索 / L4 关系脉络。
// 嵌入端点配置复用安卓 semanticMemory 的 getEmbedConfig/setEmbedConfig（localStorage）。
//
// 文案渲染统一走共享 markdown 工具（src/lib/markdown）：支持 `**加粗**` / `行内代码` / `[链接](url)` / 列表，
// 与聊天消息保持一致的 markdown 体验。
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useCompanionStore } from '@/core/stores/companionStore';
import { getEmbedConfig, setEmbedConfig, syncCompanionToSemantic, type EmbedConfig } from '@/core/stores/semanticMemory';
import { getAiChatMemoryEnabled, setAiChatMemoryEnabled } from './useAiChat';
import { renderMarkdown, injectMarkdownStyles, attachMarkdownCopyHandler } from '@/lib/markdown';

const TOTAL = (c: { memories: unknown[]; core_memory?: unknown[] }) =>
  (c.memories?.length ?? 0) + (c.core_memory?.length ?? 0);

const inputCls =
  'w-full rounded-lg border border-black/10 bg-white/70 px-3 py-2 text-sm text-neutral-800 outline-none focus:border-sky-400 dark:border-white/10 dark:bg-stone-800/70 dark:text-stone-100';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-black/10 p-4 dark:border-white/10">
      <div className="mb-3 text-sm font-medium text-neutral-800 dark:text-stone-100">{title}</div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

/** 把一长串纯文本描述里的「关键词」用 markdown 包一下，避免被父级卡片宽度截断时无换行。 */
function LongDesc({ md }: { md: string }) {
  return (
    <div
      className="md-message text-[11px] text-neutral-500 dark:text-stone-400"
      dangerouslySetInnerHTML={{ __html: renderMarkdown(md) }}
    />
  );
}

export function AiChatMemorySettings() {
  const companion = useCompanionStore((s) => s.companion);
  const [cfg, setCfg] = useState<EmbedConfig>(() => getEmbedConfig() ?? { endpoint: '', apiKey: '', model: 'text-embedding-3-small' });
  const [synced, setSynced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [memoryOn, setMemoryOn] = useState(() => getAiChatMemoryEnabled());
  const update = useCompanionStore((s) => s.update);
  const [profiles, setProfiles] = useState<Array<{ id: string; name: string; model?: string }>>([]);

  // 共享 markdown 样式 + 代码块复制按钮（幂等挂一次）
  useEffect(() => {
    injectMarkdownStyles();
    return attachMarkdownCopyHandler();
  }, []);

  // 拉取 AI 模型档案列表（用于「当前伴侣绑定哪个模型」下拉）
  useEffect(() => {
    void invoke<{ profiles: Array<{ id: string; name: string; model?: string }> }>('ai_get_profiles')
      .then((d) => setProfiles(Array.isArray(d?.profiles) ? d.profiles : []))
      .catch(() => setProfiles([]));
  }, []);

  const saveEmbed = () => {
    setEmbedConfig(cfg);
    setSynced(false);
  };

  /** 验证嵌入端点可用性：直接复用 rag_embed_api 发短句 "hi"，拿回 dim + 时延。
   *  与全局设置里 ai_test_connection 不一样——那个验证 chat 端点；
   *  这里验证的是「能否做 RAG」：只要端点支持 /embeddings 接口（Ollama / OpenAI 兼容）并能返回非空向量即可。
   */
  const testEmbed = async () => {
    if (testing) return;
    setTesting(true);
    setTestMsg(null);
    const t0 = performance.now();
    try {
      const res = await invoke<{ embeddings: number[][]; dim?: number }>('rag_embed_api', {
        texts: ['hi'],
        endpoint: cfg.endpoint?.trim() || null,
        apiKey: cfg.apiKey || null,
        model: cfg.model?.trim() || null,
      });
      const dim = res.dim ?? res.embeddings?.[0]?.length ?? 0;
      const ms = Math.round(performance.now() - t0);
      if (!dim) {
        setTestMsg({ ok: false, text: `端点返回空向量（${ms} ms），可能不是有效的嵌入模型` });
      } else {
        setTestMsg({ ok: true, text: `✓ 连接成功 · 向量维度 ${dim} · ${ms} ms` });
      }
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      const errMsg = e instanceof Error ? e.message : String(e);
      setTestMsg({ ok: false, text: `${errMsg.slice(0, 140)}（${ms} ms）` });
    } finally {
      setTesting(false);
    }
  };

  const syncNow = async () => {
    if (companion) {
      await syncCompanionToSemantic(companion);
      setSynced(true);
    }
  };

  return (
    <div className="space-y-4">
      <Section title="记忆层级">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-sky-200/60 bg-sky-50/50 px-3 py-2 dark:border-sky-500/30 dark:bg-sky-500/10">
          {/* 修复点：左侧用 flex-1 + min-w-0 占据可用宽度并允许内部断行/换行，
              不再被固定宽度 + 单行截断成省略号 */}
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-neutral-800 dark:text-stone-100">永久对话记忆</div>
            <LongDesc md={'每轮对话自动沉淀进向量库（namespace `ai-chat`），下次对话时**检索相关历史**注入，做到跨会话长期记忆。'} />
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={memoryOn}
            onClick={() => { const v = !memoryOn; setMemoryOn(v); setAiChatMemoryEnabled(v); }}
            className={
              'btn-press relative h-6 w-11 flex-shrink-0 rounded-full transition-colors ' +
              (memoryOn ? 'bg-sky-500' : 'bg-neutral-300 dark:bg-stone-600')
            }
          >
            <span
              className={
                'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ' +
                (memoryOn ? 'translate-x-5' : 'translate-x-0.5')
              }
            />
          </button>
        </div>

        {/* 改用 markdown：L1/L2/L3/L4 标签自动加粗，链接可点击 */}
        <LongDesc
          md={[
            '- **L1 核心档案**：你在伴侣编辑里维护的「核心档案」，长期稳定的人设基础。',
            '- **L2 滚动摘要**：对话摘要滚动写入伴侣记忆，构成关系脉络。',
            '- **L3 语义检索**：把摘要与核心档案嵌入向量库，对话时检索相关记忆注入。',
            '- **L4 关系脉络**：把关系演化与互动要点嵌入向量库，让 AI 理解关系是如何发展的。',
          ].join('\n')}
        />

        {companion && (
          <div className="text-xs text-neutral-500 dark:text-stone-400">
            当前伴侣「{companion.name}」共 {TOTAL(companion)} 条记忆（含 {companion.core_memory?.length ?? 0} 条核心档案）。
          </div>
        )}
      </Section>

      <Section title="L3 / L4 语义嵌入端点">
        <LongDesc
          md={[
            '**Windows 与手机的关键差异**：桌面端嵌入走 Rust 代理 `rag_embed_api`，**本地 Ollama 完全免费、离线可用**，不像手机受沙箱限制只能走云端。',
            '',
            'RAG 需要**专门的嵌入模型**（如 `nomic-embed-text` / `text-embedding-3-small` / `bge-*`），而不是聊天模型——聊天模型是 next-token 自回归，没有 `/embeddings` 接口，也不输出可直接比对的语义向量。',
            '嵌入模型和聊天模型可以共用同一个 Ollama / 同一个 `base_url`，只要它同时跑着两类模型即可，**所以单个 Ollama 实例就够用**（聊天走 `/api/chat`，RAG 走 `/api/embeddings`）。',
            '',
            '- **默认（推荐）**：`http://localhost:11434/api/embeddings` + 模型 `nomic-embed-text`（需先启动 Ollama 并 `ollama pull nomic-embed-text`）。',
            '- **云端**：填入 OpenAI 兼容的 `/v1/embeddings` 与 key（也可下方留空 → 自动复用当前算力来源）。',
            '- **都没有也能用**——对话注入会回退到关键词匹配，只是跨话题召回弱一些。',
          ].join('\n')}
        />
        <label className="block">
          <div className="mb-1 text-xs text-neutral-500 dark:text-stone-400">Endpoint（含 /embeddings）</div>
          <input
            className={inputCls}
            placeholder="https://api.openai.com/v1/embeddings"
            value={cfg.endpoint}
            onChange={(e) => setCfg({ ...cfg, endpoint: e.target.value })}
          />
        </label>
        <label className="block">
          <div className="mb-1 text-xs text-neutral-500 dark:text-stone-400">API Key</div>
          <input
            className={inputCls}
            type="password"
            placeholder="sk-..."
            value={cfg.apiKey}
            onChange={(e) => setCfg({ ...cfg, apiKey: e.target.value })}
          />
        </label>
        <label className="block">
          <div className="mb-1 text-xs text-neutral-500 dark:text-stone-400">Embedding 模型</div>
          <input
            className={inputCls}
            value={cfg.model}
            onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-press rounded-lg bg-sky-500 px-3 py-1.5 text-sm text-white"
            onClick={saveEmbed}
          >
            保存嵌入端点
          </button>
          <button
            type="button"
            disabled={testing}
            onClick={() => void testEmbed()}
            className="btn-press inline-flex items-center gap-1.5 rounded-lg border border-sky-300 px-3 py-1.5 text-sm text-sky-600 hover:bg-sky-50 disabled:opacity-60 dark:border-sky-500/50 dark:text-sky-300 dark:hover:bg-sky-500/10"
          >
            {testing ? '测试中…' : '测试嵌入连接'}
          </button>
          {testMsg && (
            <span
              className={
                'text-xs ' +
                (testMsg.ok
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-rose-500 dark:text-rose-400')
              }
            >
              {testMsg.text}
            </span>
          )}
        </div>
      </Section>

      {companion && (
        <Section title="AI 聊天模型">
          <div className="text-xs text-neutral-500 dark:text-stone-400">
            为「{companion.name}」绑定专属 AI 模型档案。群聊时每位伴侣按各自绑定的模型独立发言；留空则回落全局默认档案。
          </div>
          <label className="block">
            <div className="mb-1 text-xs text-neutral-500 dark:text-stone-400">模型档案</div>
            <select
              className={inputCls}
              value={companion.profile_id ?? ''}
              onChange={(e) => {
                const profile_id = e.target.value || null;
                void update({ ...companion, profile_id });
              }}
            >
              <option value="">（全局默认）</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.id}{p.model ? ` · ${p.model}` : ''}
                </option>
              ))}
            </select>
          </label>
        </Section>
      )}

      <Section title="同步到语义库">
        <div className="text-xs text-neutral-500 dark:text-stone-400">
          把当前伴侣的核心档案与最近摘要摄取进向量库（L3/L4），发起对话时自动检索注入。
        </div>
        <button
          type="button"
          className="btn-press rounded-lg border border-black/10 px-3 py-1.5 text-sm text-neutral-600 dark:border-white/10 dark:text-stone-300"
          onClick={() => void syncNow()}
        >
          {synced ? '已同步 ✓' : '立即同步'}
        </button>
      </Section>
    </div>
  );
}