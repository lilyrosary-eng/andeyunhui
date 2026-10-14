import { useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, Plus, RefreshCw, Trash2, Search, Pencil, TestTube2, Check, X, Eye, EyeOff, ExternalLink } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { ModelUi, ProviderUi } from '../aiConfigCodec';
import { ModelEditorDrawer } from './ModelEditorDrawer';
import { capTags } from './capsTags';
import { newModelKey } from './providerMatch';
import { capacitySourceLabel } from './ModelEditorDrawer';

/** 手填的容量打个 ✎ —— 一眼看出「这个数是我自己填的、重扫不会覆盖」。 */
function sourceMark(source: string, value: string): string {
  return value.trim() && source === 'manual' ? '✎' : '';
}

const ROW_H = 40;

const inputCls =
  'w-full px-3 py-2 rounded-lg text-sm bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 text-neutral-800 dark:text-stone-100 outline-none focus:ring-2 focus:ring-[var(--element-border)] transition-colors';
const labelCls = 'block text-[11px] text-neutral-500 dark:text-stone-400 mb-1.5 font-medium';

/** 端点是本机回环地址 → 标「本地」，否则「云端」。不引 logo，见规格 §2。 */
function isLocal(baseUrl: string): boolean {
  return /127\.0\.0\.1|localhost|\[::1\]/i.test(baseUrl);
}

function formatContext(n: string): string {
  if (!n) return '';
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1000) return `${Math.round(v / 1000)}K`;
  return String(v);
}


export interface ProviderCardProps {
  provider: ProviderUi;
  expanded: boolean;
  onToggle: () => void;
  /** 供应商内是否有模型被选中 —— 决定标题栏的 ● */
  hasSelected: boolean;
  onSelectModel: (modelId: string) => void;
  onPatchModel: (modelId: string, patch: Partial<ModelUi>) => void;
  onAddModel: () => void;
  onRemoveModel: (modelId: string) => void;
  onOpenDiscover: () => void;
  onPatchProvider: (patch: Partial<ProviderUi>) => void;
  /** 地址输入完成（失焦 / 回车）——父级据此做「同 url 复用预设」的去重与自动命名。 */
  onCommitBaseUrl?: () => void;
  onRemoveProvider: () => void;
  /** 当前被选中的模型 id（来自父级 selection 状态），决定本卡片内每行的 ○/● */
  selectedModelId: string | null;
  /** 搜索命中的模型 id，滚动到它并高亮 */
  highlightModelId: string | null;
  /**
   * 「本批新增」的模型 id 集合——底色橙色高亮。
   * 非持久：父级在下一批新增 / 展开折叠 / 搜索 / 切 tab 时清空。
   */
  newModelIds?: Set<string>;
  /**
   * 「能力探测」开关是否开启（设置页全局开关，默认关）。
   *
   * 关闭时不渲染探测按钮：探测会**真发一次可能计费的请求**，入口不该在用户
   * 没明确同意前就摆在那里（与自定义节点放行同一口径：能力开关必须来自用户设置）。
   */
  probeEnabled?: boolean;
  t: (k: string, vars?: Record<string, string | number>) => string;
}

export function ProviderCard(props: ProviderCardProps) {
  const { provider: p, expanded, onToggle, t } = props;
  const [filter, setFilter] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const q = filter.trim();
  const models = q
    ? p.models.filter((m) => m.model.toLowerCase().includes(q.toLowerCase()) || m.label.toLowerCase().includes(q.toLowerCase()))
    : p.models;

  const virtualizer = useVirtualizer({
    count: models.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8,
  });

  const editing = editingId ? p.models.find((m) => m.id === editingId) ?? null : null;

  // 测试连接：用本供应商端点 + Key + 代表性模型（选中的优先，否则第一个）打一发 ping。
  // 复用后端 ai_test_connection（v2 重构时桌面漏接，移动端仍在用；后端命令未删）。
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // ── 视觉能力探测 ────────────────────────────────────────────────
  // 给单个模型发一张 1×1 测试图，看端点接不接受图片输入。
  // 结论的**落盘规则**与后端 `caps_probe` 的判据一致：
  //   supported / unsupported → 可确证，写回 caps.vision 并把来源标 provider
  //   unknown → 什么都不改（失败分不清是模型不支持还是限流/密钥/参数错，
  //             写进去就是一条永久脏记忆）
  const [probingId, setProbingId] = useState<string | null>(null);
  const [probeMsg, setProbeMsg] = useState<{ id: string; ok: boolean; text: string } | null>(null);

  const probeVision = async (m: ModelUi) => {
    const apiKey = p.api_key.trim();
    const baseUrl = p.base_url.trim();
    if (!apiKey) { setProbeMsg({ id: m.id, ok: false, text: t('modelSettings.needApiKey') }); return; }
    if (!/^https?:\/\//.test(baseUrl)) { setProbeMsg({ id: m.id, ok: false, text: t('modelSettings.badEndpoint') }); return; }
    setProbingId(m.id);
    setProbeMsg(null);
    try {
      const out = await invoke<{ verdict: 'supported' | 'unsupported' | 'unknown'; detail: string }>('ai_probe_vision', {
        profileId: m.id,
        baseUrl,
        apiKey,
        model: m.model,
      });
      if (out.verdict === 'supported' || out.verdict === 'unsupported') {
        props.onPatchModel(m.id, {
          caps: { ...m.caps, vision: out.verdict === 'supported', vision_source: 'provider' },
        });
      }
      setProbeMsg({ id: m.id, ok: out.verdict === 'supported', text: out.detail });
    } catch (e) {
      setProbeMsg({ id: m.id, ok: false, text: String(e) });
    } finally {
      setProbingId(null);
    }
  };

  const testConnection = async () => {
    const apiKey = p.api_key.trim();
    const baseUrl = p.base_url.trim();
    const target = p.models.find((m) => m.id === props.selectedModelId) ?? p.models[0];
    if (!apiKey) { setTestMsg({ ok: false, text: t('modelSettings.needApiKey') }); return; }
    if (!/^https?:\/\//.test(baseUrl)) { setTestMsg({ ok: false, text: t('modelSettings.badEndpoint') }); return; }
    if (!target) { setTestMsg({ ok: false, text: t('modelSettings.noModels') }); return; }
    setTesting(true);
    setTestMsg(null);
    try {
      const res = await invoke<string>('ai_test_connection', {
        config: {
          id: target.id,
          name: p.name || target.model,
          base_url: baseUrl,
          api_key: apiKey,
          model: target.model,
          vision_model: p.vision_model || null,
        },
      });
      setTestMsg({ ok: true, text: res });
    } catch (e) {
      setTestMsg({ ok: false, text: t('modelSettings.connFailed', { err: String(e) }) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-stone-700 bg-white/60 dark:bg-stone-900/40">
      {/* 标题栏 */}
      <div className="flex items-center gap-2 px-4 py-3">
        <button onClick={onToggle} className="flex items-center gap-2 flex-1 min-w-0 text-left" title={t('modelSettings.toggleProvider')}>
          {expanded ? <ChevronDown size={16} className="shrink-0" /> : <ChevronRight size={16} className="shrink-0" />}
          <span className={`shrink-0 ${props.hasSelected ? 'text-[var(--element-border)]' : 'text-neutral-300 dark:text-stone-600'}`}>●</span>
          <span className="truncate font-medium text-sm text-neutral-800 dark:text-stone-100">
            {p.name || t('modelSettings.unnamedProvider')}
          </span>
          <span className="shrink-0 text-[11px] px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-stone-800 text-neutral-500 dark:text-stone-400">
            {isLocal(p.base_url) ? t('modelSettings.local') : t('modelSettings.cloud')}
          </span>
        </button>
        <span className="shrink-0 truncate text-[11px] text-neutral-400 dark:text-stone-500 max-w-[40%]" title={p.base_url}>
          {p.base_url || t('modelSettings.noEndpoint')}
        </span>
        <span className="shrink-0 text-[11px] text-neutral-400 dark:text-stone-500">
          {t('modelSettings.modelCount', { n: p.models.length })}
        </span>
        <button
          onClick={props.onOpenDiscover}
          className="shrink-0 p-1.5 rounded hover:bg-neutral-100 dark:hover:bg-stone-800"
          title={t('modelSettings.rescan')}
        >
          <RefreshCw size={14} />
        </button>
        <button
          onClick={props.onRemoveProvider}
          className="shrink-0 p-1.5 rounded hover:bg-neutral-100 dark:hover:bg-stone-800 text-red-500"
          title={t('modelSettings.removeProvider')}
        >
          <Trash2 size={14} />
        </button>
      </div>

      {expanded && (
        <>
          {/* 端点配置：只在这时候暴露，避免折叠状态下塞满表单 */}
          <div className="px-4 pb-3 grid grid-cols-1 sm:grid-cols-2 gap-3 border-t border-neutral-100 dark:border-stone-800">
            <div>
              <label className={labelCls}>{t('modelSettings.providerLabel')}</label>
              <input className={inputCls} value={p.name} placeholder={t('modelSettings.unnamedProvider')}
                onChange={(e) => props.onPatchProvider({ name: e.target.value })} />
            </div>
            <div>
              <label className={labelCls}>{t('modelSettings.endpointLabel')}</label>
              {/* 失焦/回车才提交：避免每敲一个字符就去比对重复地址（半截 URL 会误判） */}
              <input className={inputCls} value={p.base_url} placeholder="https://api.deepseek.com/v1"
                onChange={(e) => props.onPatchProvider({ base_url: e.target.value })}
                onBlur={() => props.onCommitBaseUrl?.()}
                onKeyDown={(e) => { if (e.key === 'Enter') props.onCommitBaseUrl?.(); }} />
            </div>
            <div>
              <label className={labelCls}>{t('modelSettings.apiKeyLabel')}</label>
              <div className="relative">
                <input className={`${inputCls} pr-10`} type={showKey ? 'text' : 'password'} value={p.api_key} placeholder="sk-..."
                  autoComplete="off"
                  onChange={(e) => props.onPatchProvider({ api_key: e.target.value })} />
                <button
                  onClick={() => setShowKey((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-200 transition-colors"
                  title={showKey ? t('modelSettings.hide') : t('modelSettings.show')}
                >
                  {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
            {/* DeepSeek 充值入口：仅当端点是 deepseek 时显示（v2 重构漏搬，现恢复） */}
            {/deepseek/i.test(p.base_url) && (
              <div className="sm:col-span-2 flex items-center gap-2 flex-wrap">
                <button
                  onClick={() => { openUrl('https://platform.deepseek.com/top_up').catch(() => {}); }}
                  className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-[#4d6bfe]/10 text-[#4d6bfe] hover:bg-[#4d6bfe]/20 transition-colors"
                >
                  <ExternalLink size={13} />{t('modelSettings.deepseekTopup')}
                </button>
                <span className="text-[11px] text-neutral-400 dark:text-stone-500">{t('modelSettings.deepseekHint')}</span>
              </div>
            )}
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={labelCls}>{t('modelSettings.visionModelLabel')}</label>
                <input className={inputCls} value={p.vision_model}
                  onChange={(e) => props.onPatchProvider({ vision_model: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>{t('modelSettings.imageModel')}</label>
                <input className={inputCls} value={p.image_model}
                  onChange={(e) => props.onPatchProvider({ image_model: e.target.value })} />
              </div>
              <div>
                <label className={labelCls}>{t('modelSettings.ttsModel')}</label>
                <input className={inputCls} value={p.tts_model}
                  onChange={(e) => props.onPatchProvider({ tts_model: e.target.value })} />
              </div>
            </div>
            {/* 测试连接：验证端点 + Key + 代表性模型可达（整行横跨） */}
            <div className="sm:col-span-2 flex items-center gap-2 flex-wrap">
              <button
                onClick={() => void testConnection()}
                disabled={testing}
                className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-neutral-200 dark:border-stone-700 hover:bg-neutral-100 dark:hover:bg-stone-800 disabled:opacity-50"
                title={t('modelSettings.testConn')}
              >
                <TestTube2 size={13} />{testing ? t('modelSettings.testing') : t('modelSettings.testConn')}
              </button>
              {testMsg && (
                <span className={`text-[11px] flex items-center gap-1 break-all ${testMsg.ok ? 'text-emerald-500' : 'text-red-500'}`}>
                  {testMsg.ok ? <Check size={12} /> : <X size={12} />}{testMsg.text}
                </span>
              )}
            </div>
          </div>

          {/* 模型表 */}
          <div className="px-4 pb-3">
            <div className="flex items-center gap-2 mb-2">
              <div className="relative flex-1">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400" />
                <input
                  className="w-full pl-7 pr-3 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 outline-none focus:ring-2 focus:ring-[var(--element-border)]"
                  value={filter}
                  placeholder={t('modelSettings.searchModels')}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
              <button onClick={props.onAddModel}
                className="shrink-0 flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs border border-neutral-200 dark:border-stone-700 hover:bg-neutral-100 dark:hover:bg-stone-800">
                <Plus size={13} />{t('modelSettings.addModel')}
              </button>
            </div>

            {models.length === 0 ? (
              <div className="py-6 text-center text-xs text-neutral-400">
                {q ? t('modelSettings.noModelMatch') : t('modelSettings.noModels')}
              </div>
            ) : (
              <div ref={scrollRef} className="max-h-[320px] overflow-y-auto rounded-lg border border-neutral-100 dark:border-stone-800">
                <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                  {virtualizer.getVirtualItems().map((vi) => {
                    const m = models[vi.index];
                    const selected = m.id === props.selectedModelId;
                    const highlighted = m.id === props.highlightModelId;
                    // 本批新增：橙色底（非持久）。优先级高于「已选中」底色——
                    // 它承载的是「刚才这一批新加了什么」这个瞬时信息。
                    // key 带供应商命名空间：模型 id 就是模型名，跨供应商会重名。
                    const isNew = props.newModelIds?.has(newModelKey(p.id, m.id)) ?? false;
                    return (
                      <div
                        key={m.id}
                        style={{
                          position: 'absolute', top: 0, left: 0, width: '100%',
                          height: vi.size, transform: `translateY(${vi.start}px)`,
                        }}
                        className={`flex items-center gap-2 px-2.5 border-b border-neutral-100 dark:border-stone-800
                          ${isNew ? 'bg-amber-400/20' : selected ? 'bg-[var(--element-muted)]' : ''}
                          ${highlighted ? 'ring-1 ring-inset ring-[var(--element-border)]' : ''}`}
                      >
                        <button
                          onClick={() => props.onSelectModel(m.id)}
                          className="shrink-0 w-3 text-center"
                          title={selected ? t('modelSettings.selected') : t('modelSettings.selectModel')}
                        >
                          <span className={selected ? 'text-[var(--element-border)]' : 'text-neutral-300 dark:text-stone-600'}>
                            {selected ? '●' : '○'}
                          </span>
                        </button>
                        <span className="flex-1 truncate text-xs font-mono text-neutral-800 dark:text-stone-100" title={m.model}>
                          {m.label || m.model}
                        </span>
                        {/* 输入（上下文窗口）/ 输出（单次最大产出）两列：END 点只回 id 时靠兜底表填，
                            所以值可能是「识别出的」也可能是「手填的」，都可编辑。 */}
                        <span
                          className="shrink-0 flex items-center gap-1.5 text-[10px] text-neutral-400 tabular-nums"
                          title={[
                            t('modelSettings.lenHint'),
                            `${t('modelSettings.lenIn')}：${capacitySourceLabel(m.context_tokens, m.context_source, t) || '—'}`,
                            `${t('modelSettings.lenOut')}：${capacitySourceLabel(m.max_output_tokens, m.max_output_source, t) || '—'}`,
                          ].join('\n')}
                        >
                          <span>{t('modelSettings.lenIn')} {formatContext(m.context_tokens) || '—'}{sourceMark(m.context_source, m.context_tokens)}</span>
                          <span>{t('modelSettings.lenOut')} {formatContext(m.max_output_tokens) || '—'}{sourceMark(m.max_output_source, m.max_output_tokens)}</span>
                        </span>
                        <span className="shrink-0 flex gap-1">
                          {capTags(m.caps, t).map((tag) => (
                            <span key={tag} className="text-[10px] px-1 py-0.5 rounded bg-neutral-100 dark:bg-stone-800 text-neutral-500 dark:text-stone-400">
                              {tag}
                            </span>
                          ))}
                        </span>
                        {/* 探测视觉：仅在全局开关开启时出现（会真发一次可能计费的请求）。 */}
                        {props.probeEnabled && (
                          <button
                            onClick={(e) => { e.stopPropagation(); void probeVision(m); }}
                            disabled={probingId !== null}
                            className={`shrink-0 p-1 rounded hover:bg-neutral-100 dark:hover:bg-stone-800 disabled:opacity-40 ${
                              probeMsg?.id === m.id ? (probeMsg.ok ? 'text-emerald-600' : 'text-amber-600') : ''
                            }`}
                            title={
                              probingId === m.id
                                ? t('modelSettings.capsProbe.probing')
                                : probeMsg?.id === m.id
                                  ? probeMsg.text
                                  : t('modelSettings.capsProbe.probe')
                            }
                          >
                            {probingId === m.id
                              ? <RefreshCw size={12} className="animate-spin" />
                              : <TestTube2 size={12} />}
                          </button>
                        )}
                        <button onClick={() => setEditingId(m.id)}
                          className="shrink-0 p-1 rounded hover:bg-neutral-100 dark:hover:bg-stone-800"
                          title={t('modelSettings.editModel')}>
                          <Pencil size={12} />
                        </button>
                        <button onClick={() => props.onRemoveModel(m.id)}
                          className="shrink-0 p-1 rounded hover:bg-neutral-100 dark:hover:bg-stone-800 text-red-500"
                          title={t('modelSettings.removeModel')}>
                          <Trash2 size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <ModelEditorDrawer
        model={editing}
        onPatch={(full) => { if (editing) props.onPatchModel(editing.id, full); }}
        onClose={() => setEditingId(null)}
        onSave={(patch) => { if (editing) props.onPatchModel(editing.id, patch); setEditingId(null); }}
        t={t}
      />
    </div>
  );
}
