// 桌面版「四层记忆系统」设置面板：L1 核心档案 / L2 滚动摘要 / L3 语义检索 / L4 关系脉络。
// 嵌入端点配置复用安卓 semanticMemory 的 getEmbedConfig/setEmbedConfig（localStorage）。
import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useCompanionStore } from '@/mobile/stores/companionStore';
import { getEmbedConfig, setEmbedConfig, syncCompanionToSemantic, type EmbedConfig } from '@/mobile/stores/semanticMemory';

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

export function AiChatMemorySettings() {
  const companion = useCompanionStore((s) => s.companion);
  const [cfg, setCfg] = useState<EmbedConfig>(() => getEmbedConfig() ?? { endpoint: '', apiKey: '', model: 'text-embedding-3-small' });
  const [synced, setSynced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

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
      setTestMsg({ ok: false, text: `� ${String(e).slice(0, 140)}（${ms} ms）` });
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
        <ul className="space-y-1.5 text-xs text-neutral-600 dark:text-stone-300">
          <li>L1 核心档案：你在伴侣编辑里维护的「核心档案」，长期稳定的人设基础。</li>
          <li>L2 滚动摘要：对话摘要滚动写入伴侣记忆，构成关系脉络。</li>
          <li>L3 语义检索：把摘要与核心档案嵌入向量库，对话时检索相关记忆注入。</li>
          <li>L4 关系脉络：把关系演化与互动要点嵌入向量库，让 AI 理解关系是如何发展的。</li>
        </ul>
        {companion && (
          <div className="text-xs text-neutral-500 dark:text-stone-400">
            当前伴侣「{companion.name}」共 {TOTAL(companion)} 条记忆（含 {companion.core_memory?.length ?? 0} 条核心档案）。
          </div>
        )}
      </Section>

      <Section title="L3 / L4 语义嵌入端点">
        <div className="space-y-1.5 text-xs text-neutral-600 dark:text-stone-300">
          <div>
            Windows 与手机的关键差异：桌面端嵌入走 Rust 代理（<code className="px-1 rounded bg-black/5 dark:bg-white/5">rag_embed_api</code>），
            <b className="text-emerald-600 dark:text-emerald-400">本地 Ollama 完全免费、离线可用</b>，不像手机受沙箱限制只能走云端。
          </div>
          <div className="text-xs text-neutral-500 dark:text-stone-400">
            RAG 需要<b>专门的嵌入模型</b>（如 <code>nomic-embed-text</code> / <code>text-embedding-3-small</code> / <code>bge-*</code>），而不是聊天模型——
            聊天模型是 next-token 自回归，没有 <code>/embeddings</code> 接口，也不输出可直接比对的语义向量。
            嵌入模型和聊天模型可以共用同一个 Ollama / 同一个 base_url，只要它同时跑着两类模型即可，
            <b>所以单个 Ollama 实例就够用</b>（聊天走 <code>/api/chat</code>，RAG 走 <code>/api/embeddings</code>）。
          </div>
          <ul className="list-disc pl-4 text-xs text-neutral-500 dark:text-stone-400 space-y-0.5">
            <li>
              <b>默认（推荐）</b>：<code className="px-1 rounded bg-black/5 dark:bg-white/5">http://localhost:11434/api/embeddings</code> +
              模型 <code>nomic-embed-text</code>（需先启动 Ollama 并 <code>ollama pull nomic-embed-text</code>）。
            </li>
            <li>
              <b>云端</b>：填入 OpenAI 兼容的 <code>/v1/embeddings</code> 与 key（也可下方留空 → 自动复用当前算力来源）。
            </li>
            <li>
              都没有也能用——对话注入会回退到关键词匹配，只是跨话题召回弱一些。
            </li>
          </ul>
        </div>
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
