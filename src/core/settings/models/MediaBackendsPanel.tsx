// 媒体后端面板（设置 → 模型 → 媒体后端）。
//
// 设计动机：生图 / 语音这类「媒体能力」的配置过去散落在两处——ComfyUI 端点在工作流
// 面板里，云端 image_model / tts_model 挂在各供应商档案里。用户配好后无从得知
// 「说画张图时到底会走哪条路」。本面板把两者统一成一份「后端清单」，并让每条能力
// （图像 / 语音）显式绑定一条有序链（方案 A · 单链），语义透明可预期：
//
//   - 路由按链顺序取**第一个配置完整**的后端（isBackendReady）；
//   - **降级只针对「未配置」**：链前面没配好就跳过；已选中的后端执行失败**不转下一个**
//     （用户显式配了本地后端就是想用本地——可能为隐私或额度，静默转云端属越权）；
//   - 清单与路由存 localStorage，随每次 agent 请求经 media 参数传给 Rust。
//
// 本面板只负责「编辑清单 + 排序路由」，不承载 ComfyUI 工作流库 / 供应商档案的编辑
// （那些仍在各自面板里），避免职责重复。
import { useCallback, useState } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, Image as ImageIcon, Volume2, Eye, RotateCcw } from 'lucide-react';
import {
  ALL_KINDS,
  ENABLED_KINDS,
  loadBackends,
  saveBackends,
  isBackendReady,
  type BackendKind,
  type MediaBackend,
  type MediaKind,
} from '@/core/ai/media/backends';
import { loadRoutes, saveRoutes, routeFor, defaultRoutes, type MediaRoutes } from '@/core/ai/media/routing';
import { resetMediaConfig } from '@/core/ai/media/migrate';

type TFunc = (k: string, vars?: Record<string, string | number>) => string;

/** 能力显示名。 */
const KIND_LABEL: Record<MediaKind, string> = {
  image: '图像',
  vision: '视觉',
  speech: '语音',
  video: '视频',
  music: '音乐',
};

const KIND_ICON: Record<MediaKind, typeof ImageIcon> = {
  image: ImageIcon,
  vision: Eye,
  speech: Volume2,
  video: ImageIcon,
  music: Volume2,
};

const newId = () => `mb_${Math.random().toString(36).slice(2, 8)}`;

function blankBackend(kind: BackendKind): MediaBackend {
  return {
    id: newId(),
    name: kind === 'comfyui' ? '本地 ComfyUI' : '云端媒体',
    kind,
    baseUrl: kind === 'comfyui' ? 'http://127.0.0.1:8188' : '',
    apiKey: '',
    caps: [],
    extras: {},
  };
}

export function MediaBackendsPanel({ t: _t }: { t: TFunc }) {
  // 初始加载：惰性初始化（含首次打开时的默认路由补齐），避免 effect 内 setState 级联渲染。
  const [backends, setBackends] = useState<MediaBackend[]>(() => loadBackends());
  const [routes, setRoutes] = useState<MediaRoutes>(() => {
    const bs = loadBackends();
    const rs = loadRoutes();
    // 路由为空（用户从未排序过）→ 按清单 caps 生成默认单链
    if (Object.keys(rs).length === 0 && bs.length > 0) {
      const def = defaultRoutes(bs);
      saveRoutes(def);
      return def;
    }
    return rs;
  });

  const persist = useCallback((bs: MediaBackend[], rs: MediaRoutes) => {
    saveBackends(bs);
    saveRoutes(rs);
  }, []);

  const updateBackend = (id: string, patch: Partial<MediaBackend>) => {
    const next = backends.map((b) => (b.id === id ? { ...b, ...patch } : b));
    setBackends(next);
    persist(next, routes);
  };

  const updateExtras = (id: string, patch: Partial<MediaBackend['extras']>) => {
    const next = backends.map((b) => (b.id === id ? { ...b, extras: { ...b.extras, ...patch } } : b));
    setBackends(next);
    persist(next, routes);
  };

  const addBackend = (kind: BackendKind) => {
    const next = [...backends, blankBackend(kind)];
    setBackends(next);
    // 新后端按它声明的能力加入各链尾（用户可再调顺序）
    const rs = { ...routes };
    for (const k of ALL_KINDS) {
      if (rs[k] && !rs[k]!.includes(next[next.length - 1].id)) rs[k]!.push(next[next.length - 1].id);
    }
    persist(next, rs);
  };

  const removeBackend = (id: string) => {
    const next = backends.filter((b) => b.id !== id);
    const rs: MediaRoutes = {};
    for (const k of ALL_KINDS) {
      const filtered = routeFor(k, routes).filter((x) => x !== id);
      if (filtered.length) rs[k] = filtered;
    }
    setBackends(next);
    setRoutes(rs);
    persist(next, rs);
  };

  /** 切换某后端对某能力的能力声明（caps）。 */
  const toggleCap = (id: string, kind: MediaKind) => {
    const b = backends.find((x) => x.id === id);
    if (!b) return;
    const has = b.caps.includes(kind);
    const caps = has ? b.caps.filter((c) => c !== kind) : [...b.caps, kind];
    updateBackend(id, { caps });
    // 同步路由：取消能力时从链里移除；新增能力时加入链尾（若该能力已启用）
    const rs = { ...routes };
    if (has) {
      const filtered = routeFor(kind, rs).filter((x) => x !== id);
      if (filtered.length) rs[kind] = filtered;
      else delete rs[kind];
    } else {
      const cur = routeFor(kind, rs);
      rs[kind] = cur.includes(id) ? cur : [...cur, id];
    }
    setRoutes(rs);
    persist(backends.map((x) => (x.id === id ? { ...x, caps } : x)), rs);
  };

  /** 在链里上/下移一个后端。 */
  const moveInRoute = (kind: MediaKind, id: string, dir: -1 | 1) => {
    const cur = routeFor(kind, routes);
    const i = cur.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= cur.length) return;
    const next = [...cur];
    [next[i], next[j]] = [next[j], next[i]];
    const rs = { ...routes, [kind]: next };
    setRoutes(rs);
    persist(backends, rs);
  };

  const reset = () => {
    resetMediaConfig();
    setBackends([]);
    setRoutes({});
  };

  const inputCls =
    'w-full rounded-lg border border-black/10 dark:border-white/10 bg-white/60 dark:bg-white/5 px-2.5 py-1.5 text-[12px] outline-none focus:border-sky-400';
  const labelCls = 'text-[11px] text-neutral-500 dark:text-stone-400 mb-1 block';

  return (
    <div className="mt-6 rounded-2xl border border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02] p-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-[13px] font-medium text-neutral-800 dark:text-stone-200">媒体后端</h3>
        <button
          onClick={reset}
          className="flex items-center gap-1 text-[11px] text-neutral-500 dark:text-stone-400 hover:text-sky-500"
          title="清空清单与路由（下次启动会依旧配置重新迁移）"
        >
          <RotateCcw size={12} /> 重置
        </button>
      </div>
      <p className="text-[11px] text-neutral-500 dark:text-stone-400 mb-3 leading-relaxed">
        AI 对话里说「画张图」「念一下」时，会按下列**能力链**依次找第一个配置完整的后端。
        <span className="text-neutral-400 dark:text-stone-500">
          （链前面没配好会自动跳过；一旦选中某个后端，它执行失败就报错，不会偷偷改用后面那个——
          避免本地失败时误用云端产生费用。）
        </span>
      </p>

      {/* 后端清单 */}
      <div className="space-y-2 mb-4">
        {backends.length === 0 && (
          <div className="text-[11px] text-neutral-400 dark:text-stone-500 py-2">
            暂无后端。点下方按钮添加，或到「本地生图」配好 ComfyUI / 到供应商档案配好图片、语音模型后重启自动迁移。
          </div>
        )}
        {backends.map((b) => (
          <div key={b.id} className="rounded-xl border border-black/10 dark:border-white/10 p-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-600 dark:text-sky-400">
                {b.kind === 'comfyui' ? 'ComfyUI' : '云端'}
              </span>
              <input
                className={`${inputCls} flex-1`}
                value={b.name}
                onChange={(e) => updateBackend(b.id, { name: e.target.value })}
                placeholder="后端名称"
              />
              <button
                onClick={() => removeBackend(b.id)}
                className="text-neutral-400 hover:text-red-500 shrink-0"
                title="删除此后端"
              >
                <Trash2 size={14} />
              </button>
            </div>

            {b.kind === 'comfyui' && (
              <div className="grid grid-cols-2 gap-2 mb-2">
                <div>
                  <label className={labelCls}>端点</label>
                  <input
                    className={inputCls}
                    value={b.baseUrl}
                    onChange={(e) => updateBackend(b.id, { baseUrl: e.target.value })}
                    placeholder="http://127.0.0.1:8188"
                  />
                </div>
                <div>
                  <label className={labelCls}>Checkpoint（内置流用）</label>
                  <input
                    className={inputCls}
                    value={b.extras.ckpt ?? ''}
                    onChange={(e) => updateExtras(b.id, { ckpt: e.target.value })}
                    placeholder="sd_xl_base_1.0.safetensors"
                  />
                </div>
                <div>
                  <label className={labelCls}>蓝图工作流路径（可选）</label>
                  <input
                    className={inputCls}
                    value={b.extras.workflowPath ?? ''}
                    onChange={(e) => updateExtras(b.id, { workflowPath: e.target.value })}
                    placeholder="留空则用内置最小 txt2img"
                  />
                </div>
                <div>
                  <label className={labelCls}>技能包 slug（可选，失败写回）</label>
                  <input
                    className={inputCls}
                    value={b.extras.skillSlug ?? ''}
                    onChange={(e) => updateExtras(b.id, { skillSlug: e.target.value })}
                    placeholder="工作流技能包标识"
                  />
                </div>
              </div>
            )}

            {b.kind === 'openai' && (
              <div className="grid grid-cols-2 gap-2 mb-2">
                <div>
                  <label className={labelCls}>算力来源档案 id</label>
                  <input
                    className={inputCls}
                    value={b.extras.profileId ?? ''}
                    onChange={(e) => updateExtras(b.id, { profileId: e.target.value })}
                    placeholder="留空则用当前对话档案"
                  />
                </div>
              </div>
            )}
            {/* 模型名**不在**这里配：统一到下方「能力路由链」的对应行内联配置。
                同一个后端可能同时提供图像/视觉/语音，各能力用的模型名不同 ——
                放在后端卡片里会让用户按「后端」的思路填，而实际决策是按「能力」的；
                而且会出现「卡片里填了、链上又填一处」的双入口歧义。 */}

            {/* 能力声明 */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] text-neutral-500 dark:text-stone-400">提供能力：</span>
              {ALL_KINDS.map((k) => {
                const enabled = ENABLED_KINDS.includes(k);
                const on = b.caps.includes(k);
                return (
                  <button
                    key={k}
                    disabled={!enabled}
                    onClick={() => toggleCap(b.id, k)}
                    title={enabled ? '' : '首期暂未开放'}
                    className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                      on
                        ? 'border-sky-400 text-sky-600 dark:text-sky-400 bg-sky-500/10'
                        : 'border-black/10 dark:border-white/10 text-neutral-400 dark:text-stone-500'
                    } ${enabled ? '' : 'opacity-40 cursor-not-allowed'}`}
                  >
                    {KIND_LABEL[k]}
                  </button>
                );
              })}
              <span
                className={`ml-auto text-[11px] ${
                  isBackendReady(b, b.caps[0] ?? 'image')
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-amber-600 dark:text-amber-400'
                }`}
              >
                {b.caps.length === 0
                  ? '未声明能力'
                  : b.kind === 'comfyui'
                    ? b.baseUrl.trim()
                      ? '已配置'
                      : '缺端点'
                    : '已配置'}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-2 mb-5">
        <button
          onClick={() => addBackend('comfyui')}
          className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border border-black/10 dark:border-white/10 hover:border-sky-400 hover:text-sky-500"
        >
          <Plus size={12} /> ComfyUI 后端
        </button>
        <button
          onClick={() => addBackend('openai')}
          className="flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-lg border border-black/10 dark:border-white/10 hover:border-sky-400 hover:text-sky-500"
        >
          <Plus size={12} /> 云端后端
        </button>
      </div>

      {/* 能力路由链 */}
      <div className="space-y-3">
        {ENABLED_KINDS.map((k) => {
          const Icon = KIND_ICON[k];
          const chain = routeFor(k, routes);
          const rows = chain
            .map((id) => backends.find((b) => b.id === id))
            .filter((b): b is MediaBackend => !!b);
          return (
            <div key={k}>
              <div className="flex items-center gap-1.5 mb-1">
                <Icon size={13} className="text-neutral-500 dark:text-stone-400" />
                <span className="text-[12px] text-neutral-700 dark:text-stone-300">{KIND_LABEL[k]}能力链</span>
              </div>
              {rows.length === 0 ? (
                <div className="text-[11px] text-neutral-400 dark:text-stone-500 pl-4">
                  未配置——对话里调用「{KIND_LABEL[k]}」相关工具会提示未配置。
                </div>
              ) : (
                <ol className="pl-4 space-y-1">
                  {rows.map((b, i) => {
                    const ready = isBackendReady(b, k);
                    return (
                      <li key={b.id} className="flex items-center gap-2">
                        <span className="text-[11px] text-neutral-400 dark:text-stone-500 w-4 shrink-0">{i + 1}.</span>
                        <span
                          className="text-[11px] text-neutral-700 dark:text-stone-300 w-24 shrink-0 truncate"
                          title={b.name}
                        >
                          {b.name}
                        </span>
                        {/* ★ 「这个能力用哪个模型」的**唯一**入口。
                            放在能力链行内而不是后端卡片里 —— 决策本来就是按「能力」做的：
                            同一个后端可能同时供图像/视觉/语音，三者模型名各不相同。 */}
                        {b.kind === 'openai' ? (
                          <input
                            className="flex-1 min-w-0 px-2 py-1 rounded text-[11px] bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 text-neutral-800 dark:text-stone-100 outline-none focus:ring-1 focus:ring-[var(--element-border)]"
                            value={b.extras.models?.[k] ?? ''}
                            onChange={(e) =>
                              updateExtras(b.id, { models: { ...b.extras.models, [k]: e.target.value } })
                            }
                            placeholder={`${KIND_LABEL[k]}模型名（留空则用算力来源档案的默认）`}
                          />
                        ) : (
                          <span className="flex-1 min-w-0 text-[11px] text-neutral-400 dark:text-stone-500 truncate" title={b.baseUrl}>
                            {b.baseUrl || '未填端点'}
                          </span>
                        )}
                        <span
                          className={`shrink-0 text-[10px] ${
                            ready ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'
                          }`}
                        >
                          {ready ? '就绪' : '未配置（会跳过）'}
                        </span>
                        <button
                          onClick={() => moveInRoute(k, b.id, -1)}
                          disabled={i === 0}
                          className="shrink-0 text-neutral-400 hover:text-sky-500 disabled:opacity-30"
                          title="上移"
                        >
                          <ChevronUp size={12} />
                        </button>
                        <button
                          onClick={() => moveInRoute(k, b.id, 1)}
                          disabled={i === rows.length - 1}
                          className="shrink-0 text-neutral-400 hover:text-sky-500 disabled:opacity-30"
                          title="下移"
                        >
                          <ChevronDown size={12} />
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
