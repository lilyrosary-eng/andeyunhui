// 桌面版「四层记忆系统」设置面板：L1 核心档案 / L2 滚动摘要 / L3 语义检索 / L4 关系脉络。
// 嵌入端点配置复用安卓 semanticMemory 的 getEmbedConfig/setEmbedConfig（localStorage）。
//
// 文案渲染统一走共享 markdown 工具（src/lib/markdown）：支持 `**加粗**` / `行内代码` / `[链接](url)` / 列表，
// 与聊天消息保持一致的 markdown 体验。
import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useCompanionStore } from '@/core/stores/companionStore';
import { InlineSelect, type InlineSelectGroup } from '@/components/ui/inline-select';
import {
  describeEffectiveEmbed,
  syncCompanionToSemantic,
  pendingTurnCount,
} from '@/core/stores/semanticMemory';
import type { AiProfile } from '@/mobile/types/chat';
import { backfillChatMemory } from '@/core/stores/memoryBackfill';
import { requestSettingsTab } from '@/core/settings/settingsNav';
import { getAiChatMemoryEnabled, setAiChatMemoryEnabled } from '@/core/ai/useAiChat';
import { renderMarkdown, injectMarkdownStyles, attachMarkdownCopyHandler } from '@/lib/markdown';
import { Section } from '@/components/bricks/Section';

/** 生效来源的中文说法（与 describeEffectiveEmbed 的三种 src 一一对应）。 */
const SRC_LABEL: Record<'routing' | 'explicit' | 'auto', string> = {
  routing: '路由页选定',
  explicit: '手动端点（高级）',
  auto: '自动猜测（可能挑到别的供应商）',
};

const TOTAL = (c: { memories: unknown[]; core_memory?: unknown[] }) =>
  (c.memories?.length ?? 0) + (c.core_memory?.length ?? 0);

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
  const [synced, setSynced] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [memoryOn, setMemoryOn] = useState(() => getAiChatMemoryEnabled());
  const update = useCompanionStore((s) => s.update);
  /**
   * 算力档案（providers × models 展平）+ active + 路由页选的嵌入模型名 ——
   * 这三样就是运行时 `describeEffectiveEmbed` 的全部输入，所以这里的显示
   * 与实际会打的端点不可能不一致。
   */
  const [profiles, setProfiles] = useState<AiProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [routingName, setRoutingName] = useState('');

  // 共享 markdown 样式 + 代码块复制按钮（幂等挂一次）
  useEffect(() => {
    injectMarkdownStyles();
    return attachMarkdownCopyHandler();
  }, []);

  // 拉取 AI 模型档案列表（用于「当前伴侣绑定哪个模型」下拉 + 嵌入端点生效来源显示）
  useEffect(() => {
    void Promise.all([
      invoke<{ profiles?: AiProfile[]; active?: string | null }>('ai_get_profiles'),
      invoke<{ media_models?: { embedding?: string | null } }>('ai_get_config').catch(() => null),
    ])
      .then(([d, c]) => {
        setProfiles(Array.isArray(d?.profiles) ? d.profiles : []);
        setActiveId(d?.active ?? null);
        setRoutingName((c?.media_models?.embedding ?? '').trim());
      })
      .catch(() => setProfiles([]));
  }, []);

  // ===== 历史对话回填 + 待重试队列可见性 =====
  const [backfilling, setBackfilling] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState(() => pendingTurnCount());

  const runBackfill = async () => {
    setBackfilling(true);
    setBackfillMsg({ ok: true, text: '回填中…' });
    try {
      const r = await backfillChatMemory((done, total) =>
        setBackfillMsg({ ok: true, text: `回填中 ${done}/${total}…` }),
      );
      setBackfillMsg({
        ok: r.failed === 0 && r.queued === 0,
        text: `扫到 ${r.sessions} 个会话 / ${r.turns} 轮：新写入 ${r.written}，已存在跳过 ${r.skippedExisting}，待重试 ${r.queued}，失败 ${r.failed}`,
      });
      setPending(pendingTurnCount());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[backfill] 回填失败:', msg);
      setBackfillMsg({ ok: false, text: `回填失败：${msg}` });
    } finally {
      setBackfilling(false);
    }
  };

  /**
   * 当前真正会用的嵌入端点（与运行时同一个函数算出来的，界面上不再自己排优先级）。
   */
  const embed = useMemo(() => describeEffectiveEmbed(profiles, activeId, routingName), [profiles, activeId, routingName]);

  /** 模型档案按厂商分组（全站统一的下拉要 groups；原生 optgroup 的标题不跟滚） */
  const profileGroups = useMemo<InlineSelectGroup[]>(() => {
    const byProvider = new Map<string, AiProfile[]>();
    for (const p of profiles) {
      const key = p.name || '未命名供应商';
      byProvider.set(key, [...(byProvider.get(key) ?? []), p]);
    }
    return [
      { label: '', options: [{ value: '', label: '（全局默认）' }] },
      ...[...byProvider.entries()].map(([label, list]) => ({
        label,
        options: list.map((p) => ({
          value: p.id,
          label: p.model || p.id,
          shortLabel: `${label} · ${p.model || p.id}`,
        })),
      })),
    ];
  }, [profiles]);

  /** 验证嵌入端点可用性：复用 `rag_embed_api` 发一句短文本，拿回 dim + 时延。
   *  与全局设置里 ai_test_connection 不一样——那个验证 chat 端点；
   *  这里验证的是「能否做 RAG」。测的是**当前生效那一条**，不是某个输入框。
   */
  const testEmbed = async () => {
    if (testing) return;
    if (!embed) {
      setTestMsg({ ok: false, text: '没有可用的嵌入端点（未配置）——先到 设置 → 模型 → 嵌入模型 选一个' });
      return;
    }
    setTesting(true);
    setTestMsg(null);
    const t0 = performance.now();
    try {
      const res = await invoke<{ embeddings: number[][]; dim?: number }>('rag_embed_api', {
        texts: ['hi'],
        endpoint: embed.endpoint,
        apiKey: embed.apiKey || null,
        model: embed.model || null,
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

      <Section title="L3 / L4 语义嵌入">
        {/* 2026-11-05：这一栏原来的三个手填输入框删掉了。同一份嵌入配置此前长在
            这张面板、RAG 插件卡片、移动端设置三处，且优先级与运行时相反 ——
            "多个入口配同一件事"正是用户指出的问题。
            唯一入口现在是 设置 → 模型 → 「嵌入模型（RAG 记忆 / 知识库）」。
            这里只负责显示"当前真正会用哪一条" + 检测 + 跳转。 */}
        <div className="mb-3 rounded-lg border border-emerald-200/60 bg-emerald-50/60 px-3 py-2 text-[12px] leading-relaxed text-emerald-800 dark:border-emerald-800/40 dark:bg-emerald-950/30 dark:text-emerald-300">
          嵌入端点只在 <b>设置 → 模型 → 嵌入模型</b> 一处配置。
          优先级：<b>路由页选定 &gt; 手动端点（高级）&gt; 自动猜测</b>。
        </div>
        <div className="mb-3 rounded-lg border border-neutral-200/60 bg-white/60 px-3 py-2 text-[12px] dark:border-stone-700 dark:bg-stone-800/50">
          <div className="text-neutral-500 dark:text-stone-400">
            当前生效：
            <b className="ml-1 text-neutral-700 dark:text-stone-200">
              {embed ? SRC_LABEL[embed.src] : '未配置（记忆沉淀与摄取都不会执行）'}
            </b>
            {embed?.note ? <span className="ml-1 text-neutral-400">（{embed.note}）</span> : null}
          </div>
          <div className="mt-0.5 break-all font-mono text-[11px] text-neutral-500 dark:text-stone-400">
            {embed ? embed.endpoint + ' · ' + embed.model : '—'}
          </div>
          {embed?.src === 'auto' && (
            <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
              这是自动猜出来的端点，未必是你想要的那一个 —— 建议到上面那处显式选定。
            </div>
          )}
        </div>
        <LongDesc
          md={[
            'RAG 需要**专门的嵌入模型**（如 `text-embedding-qwen3-embedding-0.6b` / `nomic-embed-text` / `bge-*`），不是聊天模型 —— 聊天模型没有 `/embeddings` 接口，也不输出可直接比对的语义向量。',
            '',
            '嵌入模型可以和聊天模型共用同一个 `base_url`（LM Studio / Ollama 同时挂着两类模型就行），**不用单独再起一个服务**。',
            '换过嵌入模型之后，旧向量的维度与新模型不一致就会**检索不到**（数据没丢）：到知识库「管理」点「重建」，或在这里点「回填历史对话」。',
          ].join('\n')}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-press rounded-lg bg-sky-500 px-3 py-1.5 text-sm text-white"
            onClick={() => requestSettingsTab('model')}
          >
            打开 设置 → 模型
          </button>
          <button
            type="button"
            disabled={testing}
            onClick={() => void testEmbed()}
            className="btn-press inline-flex items-center gap-1.5 rounded-lg border border-sky-300 px-3 py-1.5 text-sm text-sky-600 hover:bg-sky-50 disabled:opacity-60 dark:border-sky-500/50 dark:text-sky-300 dark:hover:bg-sky-500/10"
          >
            {testing ? '测试中…' : '测试当前端点'}
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
            {/* 全站统一的模型选择器：厂商分组 + 粘性标题（原生 select 的 optgroup 标题不跟滚） */}
            <InlineSelect
              value={companion.profile_id ?? ''}
              onChange={(v) => void update({ ...companion, profile_id: v || null })}
              placeholder="（全局默认）"
              title="模型档案"
              className="w-full justify-between"
              groups={profileGroups}
            />
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

      <Section title="历史对话回填">
        <div className="text-xs text-neutral-500 dark:text-stone-400">
          把磁盘上已有的会话重新配对成「用户 + 助手」轮次，补写进向量库（L3）。
          幂等：同一段正文不会重复入库，重复点不会堆重复记录。
        </div>
        {pending > 0 && (
          <div className="text-xs text-amber-600 dark:text-amber-400">
            有 {pending} 轮在待重试队列里（当时嵌入端点不可用）。端点恢复或下次启动会自动补写，也可点下面按钮立刻重试。
          </div>
        )}
        <button
          type="button"
          disabled={backfilling}
          className="btn-press rounded-lg border border-black/10 px-3 py-1.5 text-sm text-neutral-600 disabled:opacity-50 dark:border-white/10 dark:text-stone-300"
          onClick={() => void runBackfill()}
        >
          {backfilling ? '回填中…' : '回填历史对话'}
        </button>
        {backfillMsg && (
          <div className={`text-xs ${backfillMsg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}>
            {backfillMsg.text}
          </div>
        )}
      </Section>
    </div>
  );
}