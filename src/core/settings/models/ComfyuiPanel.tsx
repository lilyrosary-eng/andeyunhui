// ComfyUI 本地生图面板（设置 → 模型 → 本地生图）。
// 三条用法并列：
//   ① 端点 + checkpoint + 提示词 → 内置最小 txt2img（原有快速通道）；
//   ② 工作流库：扫目录 → 选文件 →（UI 图自动转 API）→ 参数表单 → 按参生成，
//      复用用户在 ComfyUI 里调好的工作流（convert/params 为移植自 dsh-comfyui 的纯函数层）；
//   ③ 把一个工作流标记为「蓝图生图节点使用」（存路径，蓝图 image 节点运行时读取）。
// object_info 按端点做会话级缓存（数 MB，拉一次就够）。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Image as ImageIcon, FolderOpen, RefreshCw, FileJson, Wand2, Loader2, GitBranch, X, ScrollText, ShieldAlert, Activity, Square, ChevronDown } from 'lucide-react';
import { storage } from '@/core/storage';
import { KEYS } from '@/core/storage/keys';
import { convertGraphToApi } from '@/core/ai/comfyui/convert';
import { detectWorkflow } from '@/core/ai/comfyui/format';
import { getObjectInfo } from '@/core/ai/comfyui/objectInfo';
import { analyzeWorkflowParameters, applyWorkflowParameters } from '@/core/ai/comfyui/params';
import { loadSkillNotes, saveSkillNotes, skillSlug, skillSummary } from '@/core/ai/comfyui/skills';
import { customModulesOf, loadAllowedModules, saveAllowedModules } from '@/core/ai/media/customNodes';
import { MediaOutput } from '@/components/MediaOutput';
import { InlineSelect } from '@/components/ui/inline-select';
import type { Workflow, WorkflowParameter } from '@/core/ai/comfyui/params';

type TFunc = (k: string, vars?: Record<string, string | number>) => string;

interface WfFile {
  name: string;
  path: string;
  relative: string;
  size: number;
  modified_at: number;
}

/**
 * ComfyUI 报错的显示文本。
 *
 * 原来这里是 `String(e).slice(0, 200)`，**把最要紧的部分砍掉了** ——
 * ComfyUI 校验失败时真正可操作的信息在 `node_errors.<id>.errors[].details`
 * （例如 `clip, received_type(MODEL) mismatch input_type(CLIP)`），
 * 而 200 字符往往刚到 `"node_errors":{"2":{"class_type":"CLIP` 就断了，
 * 用户只能去翻 ComfyUI 服务端控制台。
 *
 * 现在：后端已把消息**按结构**整理成「结论 + 逐节点原因」（见 `format_comfy_submit_error`），
 * 所以前端只留一个**失控保护**上限；真的超了要**明说**被截断，而不是静默砍掉 ——
 * 静默截断会让人以为"信息就这些"，于是不知道还该去别处找线索。
 * （渲染处是 `whitespace-pre-wrap break-all`，长文本正常换行，不会撑坏布局。）
 */
function errText(e: unknown, limit = 1000): string {
  const s = String(e);
  return s.length > limit ? `${s.slice(0, limit)} …（已截断，完整报错见 ComfyUI 控制台）` : s;
}

export function ComfyuiPanel({ t }: { t: TFunc }) {
  // ① 内置最小流
  const [comfyuiUrl, setComfyuiUrl] = useState('http://127.0.0.1:8188');
  const [comfyuiCkpt, setComfyuiCkpt] = useState('');
  // 本机 ComfyUI 实际装了哪些 checkpoint。拉不到就退回**自由文本输入** ——
  // ComfyUI 没开时也要能填/保留一个名字，不能因为拿不到列表就让人没法配置。
  const [ckptList, setCkptList] = useState<string[]>([]);

  // ── 高级参数（可选）──────────────────────────────────────────────
  // 内建流程原先把这些**全部写死**（euler / normal / 20 步 / CFG 8.0 / 512×512），
  // 用户一样都改不了 —— 与"负向词写死""checkpoint 只能手打"是同一类问题的三个面。
  // 各项留空 = 用后端默认（不落盘空值，避免把"没填"和"填了空"混在一起）。
  const [advOpen, setAdvOpen] = useState(false);
  const [tiParams, setTiParams] = useState<Record<string, string>>({});
  // 采样器/调度器的候选值来自运行中的 ComfyUI（object_info 的 KSampler）。
  // null = 还没拉；空数组 = 拉了但拿不到（退化成自由输入）。
  const [enums, setEnums] = useState<{ sampler: string[]; scheduler: string[] } | null>(null);
  const [cmfyPrompt, setCmfyPrompt] = useState('');
  // 负向提示词。空 = 用后端内置质量词（见 Rust `DEFAULT_NEGATIVE_PROMPT`）——
  // 刻意不在这里复制那份文案：留空即默认，两边不会漂移。
  const [cmfyNegative, setCmfyNegative] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [img, setImg] = useState('');
  // ② 工作流库
  const [wfDir, setWfDir] = useState('');
  const [files, setFiles] = useState<WfFile[]>([]);
  const [scanning, setScanning] = useState(false);
  const [selPath, setSelPath] = useState('');
  const [wfBusy, setWfBusy] = useState(false);
  const [wfErr, setWfErr] = useState('');
  const [wfImg, setWfImg] = useState('');
  const [api, setApi] = useState<Workflow | null>(null);
  const [params, setParams] = useState<WorkflowParameter[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  // ③ 蓝图挂钩
  // 注意：只保留 blueprintWf 一份 state。slug（技能包备注）的真实读取方是
  // comfyuiConfig.ts / AiWorkflowView.tsx，都直接读 storage，不经过这里；
  // 曾经的 blueprintSlug state 是"只写不读"的镜像，已删除（单一来源=storage）。
  const [blueprintWf, setBlueprintWf] = useState('');

  // ── 自定义节点放行 ──────────────────────────────────────────────
  // 自定义节点可执行任意 Python。AI 自建工作流时，Rust 侧安全审计会把
  // 「非核心节点」（object_info 里 python_module != "nodes"）拦下并要求用户放行。
  // 放行**只能**来自这里的勾选——模型的工具参数无法自行放行。
  // ComfyUI 连通测试：拉一次 /object_info 就算连通（顺便知道节点数）。
  // 与供应商卡片的「测试连接」对齐 —— 每个可配的端点都该有一个"能不能用"的按钮。
  const [connBusy, setConnBusy] = useState(false);
  const [connMsg, setConnMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const testComfyConnection = async () => {
    setConnBusy(true);
    setConnMsg(null);
    try {
      const info = await getObjectInfo(comfyuiUrl.trim());
      setConnMsg({ ok: true, text: t('modelSettings.comfyui.connOk', { n: Object.keys(info).length }) });
      void loadCkpts();
    try {
      const raw = storage.getString(KEYS.ai.comfyuiBuiltinParams.key, '');
      if (raw.trim()) {
        const o = JSON.parse(raw) as Record<string, unknown>;
        const out: Record<string, string> = {};
        for (const k of ['sampler', 'scheduler', 'steps', 'cfg', 'width', 'height']) {
          const v = o?.[k];
          if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
        }
        setTiParams(out);
      }
    } catch {
      /* 存坏了就当没配 —— 不该因为一个 JSON 解析失败让面板崩掉 */
    }
    } catch (e) {
      setConnMsg({ ok: false, text: String(e) });
    } finally {
      setConnBusy(false);
    }
  };

  // 中断当前 ComfyUI 执行。
  // 生图可能跑很久（大模型 + 多步采样），此前生成中按钮是 disabled 的 ——
  // 也就是说**用户没有任何办法叫停**，只能等着。这里把生成中的按钮改成"中断"。
  // 后端 `comfyui_interrupt` 早就有了，但一直没有入口（本次审查查出的死命令之一）。
  const interruptGen = async () => {
    try {
      await invoke('comfyui_interrupt', { comfyuiUrl: comfyuiUrl.trim() });
      setErr(t('modelSettings.comfyui.interrupted'));
    } catch (e) {
      setErr(String(e));
    }
  };

  const [customModules, setCustomModules] = useState<Record<string, string[]> | null>(null);
  const [allowedModules, setAllowedModules] = useState<string[]>(() => loadAllowedModules());
  const [customBusy, setCustomBusy] = useState(false);
  const [customErr, setCustomErr] = useState('');

  /** 读取本机节点定义并归纳出自定义模块（模块名与审计口径逐字对齐）。 */
  const scanCustomNodes = useCallback(async () => {
    setCustomBusy(true);
    setCustomErr('');
    try {
      const info = await getObjectInfo(comfyuiUrl.trim());
      setCustomModules(customModulesOf(info));
    } catch (e) {
      setCustomErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomBusy(false);
    }
  }, [comfyuiUrl]);

  const toggleModule = useCallback((mod: string, on: boolean) => {
    setAllowedModules((prev) => {
      const next = on ? [...prev, mod] : prev.filter((m) => m !== mod);
      saveAllowedModules(next);
      return next;
    });
  }, []);
  // 技能包（工作流备注）：L1 列表摘要 + L2 详情编辑
  const [notes, setNotes] = useState('');
  const [notesSlug, setNotesSlug] = useState('');

  const saveUrl = (v: string) => { setComfyuiUrl(v); storage.setString(KEYS.ai.comfyuiUrl.key, v); };
  const saveCkpt = (v: string) => { setComfyuiCkpt(v); storage.setString(KEYS.ai.comfyuiCkpt.key, v); };
  /** 存高级参数。空值不落盘 —— 留空的语义是"用后端默认"，落空串会把它变成"填了个空值"。 */
  const saveParam = (k: string, v: string) => {
    const next = { ...tiParams, [k]: v };
    setTiParams(next);
    const clean: Record<string, string | number> = {};
    for (const [key, val] of Object.entries(next)) {
      const s = (val ?? '').trim();
      if (!s) continue;
      if (key === 'sampler' || key === 'scheduler') clean[key] = s;
      else {
        const n = Number(s);
        clean[key] = Number.isFinite(n) ? n : s;
      }
    }
    storage.setString(KEYS.ai.comfyuiBuiltinParams.key, Object.keys(clean).length ? JSON.stringify(clean) : '');
  };

  /**
   * 展开「高级参数」时**才**拉 object_info 取采样器/调度器枚举。
   *
   * 为什么懒加载：那份响应 6MB（3581 个节点）。打开设置页就拉一次是白白浪费，
   * 而真正需要它的人会点开这个区块。失败就退化成自由输入，不影响主流程。
   */
  const toggleAdvanced = async () => {
    const next = !advOpen;
    setAdvOpen(next);
    if (!next || enums) return;
    try {
      const info = (await getObjectInfo(comfyuiUrl.trim())) as Record<string, unknown>;
      const ksampler = info?.KSampler as Record<string, unknown> | undefined;
      const required = (ksampler?.input as Record<string, unknown> | undefined)?.required as
        | Record<string, unknown>
        | undefined;
      const listOf = (key: string): string[] => {
        const spec = required?.[key];
        const first = Array.isArray(spec) ? spec[0] : undefined;
        return Array.isArray(first) ? first.filter((x): x is string => typeof x === 'string') : [];
      };
      setEnums({ sampler: listOf('sampler_name'), scheduler: listOf('scheduler') });
    } catch {
      setEnums({ sampler: [], scheduler: [] });
    }
  };

  /**
   * 当前端点（ref 镜像）。`loadCkpts` 需要它，但**不能**把 `comfyuiUrl` 写进依赖数组：
   * 那会让 loadCkpts 每次改 URL 都换引用 → 挂载 effect（依赖 loadCkpts）重跑 →
   * 把用户正在输入的 URL 用存储里的旧值**重置掉**。用 ref 读就不产生响应式依赖。
   */
  const comfyuiUrlRef = useRef(comfyuiUrl);
  useEffect(() => { comfyuiUrlRef.current = comfyuiUrl; }, [comfyuiUrl]);

  /** 拉 checkpoints 列表（失败静默 → 退回自由文本输入）。测试连接成功后也会重新拉一次。 */
  const loadCkpts = useCallback(async () => {
    try {
      // ⚠️ comfyuiUrl 是**必填**（Rust 侧 `comfyui_url: String`）——
      //    漏了它会直接 "invalid args"，下拉永远拉不到列表而静默退化成自由输入。
      //    （这条是我自己写漏的，被本轮新增的参数名防线当场抓住。）
      const names = await invoke<string[]>('comfyui_list_models', {
        comfyuiUrl: comfyuiUrlRef.current.trim(),
        folder: 'checkpoints',
      });
      setCkptList(Array.isArray(names) ? names.filter((x) => typeof x === 'string' && x.trim()) : []);
    } catch {
      setCkptList([]);
    }
  }, []);
  const saveNegative = (v: string) => { setCmfyNegative(v); storage.setString(KEYS.ai.comfyuiNegative.key, v); };

  // 读配置（挂载时一次）
  useEffect(() => {
    setComfyuiUrl(storage.getString(KEYS.ai.comfyuiUrl.key, 'http://127.0.0.1:8188'));
    setComfyuiCkpt(storage.getString(KEYS.ai.comfyuiCkpt.key, ''));
    setCmfyNegative(storage.getString(KEYS.ai.comfyuiNegative.key, ''));
    void loadCkpts();
    setWfDir(storage.getString(KEYS.ai.comfyuiWorkflowsDir.key, ''));
    setBlueprintWf(storage.getString(KEYS.ai.comfyuiBlueprintWf.key, ''));
    // loadCkpts 是 useCallback(…, []) 的稳定引用，进依赖数组不会造成重复执行
  }, [loadCkpts]);

  // 备注防抖保存（400ms；空白=删除）
  useEffect(() => {
    if (!notesSlug) return;
    const timer = setTimeout(() => saveSkillNotes(notesSlug, notes), 400);
    return () => clearTimeout(timer);
  }, [notes, notesSlug]);

  const quickGenerate = async () => {
    const p = cmfyPrompt.trim();
    if (!p) { setErr(t('modelSettings.comfyui.needPrompt')); return; }
    setBusy(true); setErr(''); setImg('');
    try {
      // 高级参数只在真填了值时下发（留空 = 后端默认）
      const opts: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(tiParams)) {
        const s = (v ?? '').trim();
        if (!s) continue;
        const n = Number(s);
        opts[k] = (k === 'sampler' || k === 'scheduler') ? s : (Number.isFinite(n) ? n : s);
      }
      const dataUrl = await invoke<string>('comfyui_generate_media', {
        prompt: p, comfyuiUrl, checkpoint: comfyuiCkpt, negativePrompt: cmfyNegative,
        ...(Object.keys(opts).length ? { options: opts } : {}),
      });
      setImg(dataUrl);
    } catch (e) { setErr(errText(e)); }
    finally { setBusy(false); }
  };

  const pickDir = async () => {
    try {
      const picked = await open({ directory: true });
      if (typeof picked === 'string' && picked) {
        setWfDir(picked);
        storage.setString(KEYS.ai.comfyuiWorkflowsDir.key, picked);
      }
    } catch (e) { setWfErr(errText(e)); }
  };

  const scan = async () => {
    const dir = wfDir.trim();
    if (!dir) { setWfErr(t('modelSettings.comfyui.needDir')); return; }
    setScanning(true); setWfErr('');
    try {
      const list = await invoke<WfFile[]>('comfyui_scan_workflows', { dir });
      setFiles(list);
      if (!list.length) setWfErr(t('modelSettings.comfyui.scanEmpty'));
    } catch (e) { setFiles([]); setWfErr(t('modelSettings.comfyui.scanFailed') + ': ' + String(e).slice(0, 150)); }
    finally { setScanning(false); }
  };

  const adoptApi = useCallback((wf: Workflow, info?: Record<string, unknown>) => {
    setApi(wf);
    const ps = analyzeWorkflowParameters(wf, info);
    setParams(ps);
    // 预填默认值；random（seed）留空 → 每次运行随机
    const init: Record<string, unknown> = {};
    for (const p of ps) if (p.random !== true) init[p.name] = p.default;
    setValues(init);
  }, []);

  const loadWorkflow = async (f: WfFile) => {
    setSelPath(f.path); setWfErr(''); setWfImg(''); setApi(null); setParams([]); setValues({});
    const slug = skillSlug(f.relative);
    setNotesSlug(slug);
    setNotes(loadSkillNotes(slug));
    setWfBusy(true);
    try {
      const json = await invoke<unknown>('comfyui_read_workflow', { path: f.path });
      const kind = detectWorkflow(json);
      if (kind === 'ui') {
        setWfErr(t('modelSettings.comfyui.loadingObjectInfo'));
        const info = await getObjectInfo(comfyuiUrl);
        const res = convertGraphToApi(json, info);
        if (!res.ok) { setWfErr(t('modelSettings.comfyui.convertFailed') + ': ' + res.error); return; }
        adoptApi(res.workflow, info);
        setWfErr('');
      } else if (kind === 'api') {
        adoptApi(json as Workflow, await getObjectInfo(comfyuiUrl).catch(() => undefined));
        setWfErr('');
      } else {
        setWfErr(t('modelSettings.comfyui.formatUnknown'));
      }
    } catch (e) {
      setWfErr(t('modelSettings.comfyui.readFailed') + ': ' + String(e).slice(0, 150));
    } finally { setWfBusy(false); }
  };

  const generateWithWorkflow = async () => {
    if (!api) return;
    setWfBusy(true); setWfErr(''); setWfImg('');
    try {
      const finalWf = applyWorkflowParameters(api, params, values, await getObjectInfo(comfyuiUrl).catch(() => undefined));
      const dataUrl = await invoke<string>('comfyui_generate_media', { comfyuiUrl, workflow: finalWf });
      setWfImg(dataUrl);
    } catch (e) { setWfErr(errText(e)); }
    finally { setWfBusy(false); }
  };

  const useForBlueprint = () => {
    storage.setString(KEYS.ai.comfyuiBlueprintWf.key, selPath);
    storage.setString(KEYS.ai.comfyuiBlueprintWfSlug.key, notesSlug);
    setBlueprintWf(selPath);
    // slug 不落 state：读取方（comfyuiConfig / AiWorkflowView）都直接读 storage
  };
  const clearBlueprint = () => {
    storage.setString(KEYS.ai.comfyuiBlueprintWf.key, '');
    storage.setString(KEYS.ai.comfyuiBlueprintWfSlug.key, '');
    setBlueprintWf('');
  };

  // L1 披露：列表行展示各工作流备注摘要（扫完后算一次）
  const summaries = useMemo(() => {
    const m: Record<string, string> = {};
    for (const f of files) {
      const n = loadSkillNotes(skillSlug(f.relative));
      if (n) m[f.path] = skillSummary(n);
    }
    return m;
  }, [files]);

  const inputCls = 'w-full px-3 py-2 rounded-lg text-sm bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 outline-none focus:ring-2 focus:ring-[var(--element-border)]';
  const btnCls = 'shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-[var(--element-border)] text-white disabled:opacity-50';

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-stone-700 bg-white/60 dark:bg-stone-900/40 p-4 space-y-3">
      <div className="flex items-center gap-1.5 text-sm font-medium text-neutral-700 dark:text-stone-200">
        <ImageIcon size={14} />{t('modelSettings.comfyui.title')}
      </div>
      {/* 用途说明。加这一行的原因：这一屏字段密集（端点/Checkpoint/提示词/工作流目录/
          自定义节点放行），但**没有任何一句说清它是干嘛的**，用户会以为"难道直接在这渲染图片"。
          实际用途有两件：① 手动生图（下面那个「生成」按钮，也是唯一能确认 ComfyUI
          到底通不通的地方）；② 把你在 ComfyUI 里调好的工作流接给 AI 规划时复用。 */}
      <p className="text-[11px] leading-relaxed text-neutral-500 dark:text-stone-400">
        {t('modelSettings.comfyui.purpose')}
      </p>

      {/* ① 端点 + checkpoint（内置最小流） */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] text-neutral-500 dark:text-stone-400 mb-1.5 font-medium">{t('modelSettings.comfyui.endpoint')}</label>
          <input className={inputCls} value={comfyuiUrl} placeholder="http://127.0.0.1:8188" onChange={(e) => saveUrl(e.target.value)} />
        </div>
        <div>
          <label className="block text-[11px] text-neutral-500 dark:text-stone-400 mb-1.5 font-medium">{t('modelSettings.comfyui.checkpoint')}</label>
          {ckptList.length > 0 ? (
            /* 下拉里只有**真实存在**的模型（来自 ComfyUI 的 /models/checkpoints）。
               留空 = 自动（列表第一个）；选中 = 指定使用；AI 被点名具体模型时会覆盖这里。
               要退回"自动"用右侧的 ×。 */
            <InlineSelect
              value={comfyuiCkpt}
              onChange={saveCkpt}
              onClear={() => saveCkpt('')}
              clearTitle={t('modelSettings.comfyui.ckptBackToAuto')}
              title={t('modelSettings.comfyui.ckptHint')}
              placeholder={t('modelSettings.comfyui.ckptAutoNamed', { name: ckptList[0] })}
              searchThreshold={8}
              groups={[{ label: '', options: ckptList.map((n) => ({ value: n, label: n })) }]}
            />
          ) : (
            /* 拉不到列表（ComfyUI 没开 / 没装 checkpoint）→ 保留自由文本，别让人没法配 */
            <input className={`${inputCls} font-mono`} value={comfyuiCkpt}
              placeholder={t('modelSettings.comfyui.ckptAuto')}
              onChange={(e) => saveCkpt(e.target.value)} />
          )}
        </div>
      </div>
      {/* 连通测试：拉一次 /object_info 就算通了（顺便知道节点数）。
          与供应商卡片的「测试连接」对齐 —— 每个可配的端点都该有一个"能不能用"的按钮。 */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => void testComfyConnection()}
          disabled={connBusy || !comfyuiUrl.trim()}
          className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] border border-neutral-200 dark:border-stone-700 hover:bg-neutral-100 dark:hover:bg-stone-800 disabled:opacity-40"
        >
          {connBusy ? <Loader2 size={11} className="animate-spin" /> : <Activity size={11} />}
          {connBusy ? t('modelSettings.comfyui.connTesting') : t('modelSettings.comfyui.connTest')}
        </button>
        {connMsg && (
          <span
            className={`text-[11px] truncate max-w-[320px] ${connMsg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'}`}
            title={connMsg.text}
          >
            {connMsg.ok ? '✓' : '✗'} {connMsg.text}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <input className={`flex-1 ${inputCls}`} value={cmfyPrompt} placeholder={t('modelSettings.comfyui.promptPlaceholder')}
          onChange={(e) => setCmfyPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void quickGenerate(); }} />
        {/* 生成中 → 这个按钮变成「中断」。刻意不做成两个并排的按钮：位置固定、
            同一个位置"点下去要么开始要么停止"，比在忙时去找另一个按钮更直接。
            端点为空时禁用（连不上就没得生成）。 */}
        <button
          onClick={() => (busy ? void interruptGen() : void quickGenerate())}
          disabled={!busy && !comfyuiUrl.trim()}
          className={btnCls}
        >
          {busy ? <Square size={14} /> : <Wand2 size={14} />}
          {busy ? t('modelSettings.comfyui.interrupt') : t('modelSettings.comfyui.generate')}
        </button>
      </div>
      {/* 负向提示词。单独一行：正向那行右侧是「生成/中断」按钮，塞不下第二个框。
          留空 = 用后端内置质量词（这里**不复制**那份文案，留空即默认，两边不会漂移）。 */}
      <input className={inputCls} value={cmfyNegative}
        placeholder={t('modelSettings.comfyui.negativePlaceholder')}
        onChange={(e) => saveNegative(e.target.value)} />

      {/* 高级参数。默认折叠 —— 大多数人不用动，但"动不了"和"能改但收着"是两回事。
          ⚠️ 采样器/调度器的候选值来自运行中的 ComfyUI（展开时才拉，那份 object_info 有 6MB）。
          拉不到就退化成自由输入，不挡流程。 */}
      <button
        onClick={() => void toggleAdvanced()}
        className="flex items-center gap-1 text-[11px] text-neutral-500 dark:text-stone-400 hover:text-neutral-700 dark:hover:text-stone-200"
      >
        <ChevronDown size={12} className={`transition-transform ${advOpen ? 'rotate-180' : ''}`} />
        {t('modelSettings.comfyui.advTitle')}
      </button>
      {advOpen && (
        <div className="grid grid-cols-3 gap-2">
          {(['sampler', 'scheduler'] as const).map((k) => {
            const list = enums?.[k] ?? [];
            const label = t(`modelSettings.comfyui.adv${k === 'sampler' ? 'Sampler' : 'Scheduler'}`);
            return (
              <div key={k}>
                <label className="block text-[11px] text-neutral-500 dark:text-stone-400 mb-1.5 font-medium">{label}</label>
                {list.length > 0 ? (
                  <InlineSelect
                    value={tiParams[k] ?? ''}
                    onChange={(v) => saveParam(k, v)}
                    onClear={() => saveParam(k, '')}
                    clearTitle={t('modelSettings.comfyui.advDefault')}
                    placeholder={t('modelSettings.comfyui.advDefault')}
                    searchThreshold={8}
                    groups={[{ label: '', options: list.map((n) => ({ value: n, label: n })) }]}
                  />
                ) : (
                  <input className={inputCls} value={tiParams[k] ?? ''}
                    placeholder={t('modelSettings.comfyui.advDefault')}
                    onChange={(e) => saveParam(k, e.target.value)} />
                )}
              </div>
            );
          })}
          {([
            ['steps', 'advSteps', '1'],
            ['cfg', 'advCfg', '0.1'],
            ['width', 'advWidth', '8'],
            ['height', 'advHeight', '8'],
          ] as const).map(([k, labelKey, step]) => (
            <div key={k}>
              <label className="block text-[11px] text-neutral-500 dark:text-stone-400 mb-1.5 font-medium">
                {t(`modelSettings.comfyui.${labelKey}`)}
              </label>
              <input className={inputCls} type="number" step={step} value={tiParams[k] ?? ''}
                placeholder={t('modelSettings.comfyui.advDefault')}
                onChange={(e) => saveParam(k, e.target.value)} />
            </div>
          ))}
        </div>
      )}
      {err && <div className="text-[11px] text-red-500 whitespace-pre-wrap break-all">{err}</div>}
      {img && <MediaOutput src={img} alt={t('modelSettings.comfyui.resultAlt')} className="max-h-64 rounded-lg border border-neutral-200 dark:border-stone-700" />}

      <div className="border-t border-neutral-100 dark:border-stone-800 pt-3" />

      {/* ② 工作流库：目录 → 扫描 → 列表 */}
      <div className="flex items-center gap-1.5 text-xs font-medium text-neutral-600 dark:text-stone-300">
        <FileJson size={13} />{t('modelSettings.comfyui.workflowLib')}
      </div>
      <div className="flex items-center gap-2">
        <input className={`flex-1 ${inputCls} font-mono text-xs`} value={wfDir} placeholder={t('modelSettings.comfyui.dirPlaceholder')}
          onChange={(e) => { setWfDir(e.target.value); storage.setString(KEYS.ai.comfyuiWorkflowsDir.key, e.target.value); }} />
        <button onClick={() => void pickDir()} className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border border-neutral-300 dark:border-stone-600 text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5">
          <FolderOpen size={14} />{t('modelSettings.comfyui.pickDir')}
        </button>
        <button onClick={() => void scan()} disabled={scanning} className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border border-neutral-300 dark:border-stone-600 text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50">
          {scanning ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {scanning ? t('modelSettings.comfyui.scanning') : t('modelSettings.comfyui.scan')}
        </button>
      </div>
      {files.length > 0 && (
        <div className="max-h-48 overflow-y-auto rounded-lg border border-neutral-200 dark:border-stone-700 divide-y divide-neutral-100 dark:divide-stone-800">
          {files.map((f) => {
            const active = f.path === selPath;
            const isBp = f.path === blueprintWf;
            return (
              <button key={f.path} onClick={() => void loadWorkflow(f)}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 text-xs transition-colors ${active ? 'bg-violet-500/10' : 'hover:bg-black/5 dark:hover:bg-white/5'}`}>
                <FileJson size={13} className={active ? 'text-violet-500' : 'text-neutral-400'} />
                <span className={`min-w-0 flex-1 truncate ${active ? 'text-violet-600 dark:text-violet-400 font-medium' : 'text-neutral-700 dark:text-stone-200'}`}>{f.relative}</span>
                {summaries[f.path] && (
                  <span className="shrink-0 flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400 max-w-[180px]">
                    <ScrollText size={11} /><span className="truncate">{summaries[f.path]}</span>
                  </span>
                )}
                {isBp && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">{t('modelSettings.comfyui.blueprintBadge')}</span>}
                <span className="shrink-0 text-[10px] text-neutral-400">{(f.size / 1024).toFixed(1)}K · {new Date(f.modified_at * 1000).toLocaleString()}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* 选中工作流：备注（技能包 L2）+ 参数表单 + 生成 */}
      {selPath && (
        <div className="rounded-lg border border-neutral-200 dark:border-stone-700 p-3 space-y-2">
          <div className="flex items-center gap-2 text-[11px] text-neutral-500 dark:text-stone-400">
            <span className="font-mono truncate flex-1" title={selPath}>{selPath}</span>
            {api && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400">{t('modelSettings.comfyui.formatApi')}</span>}
          </div>
          <div>
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-neutral-500 dark:text-stone-400 mb-1">
              <ScrollText size={12} />{t('modelSettings.comfyui.notesTitle')}
            </div>
            <textarea
              className="w-full px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 outline-none focus:ring-2 focus:ring-[var(--element-border)] resize-y"
              rows={3}
              value={notes}
              placeholder={t('modelSettings.comfyui.notesPlaceholder')}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          {params.length > 0 && (
            <div className="grid grid-cols-2 gap-2">
              {params.map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-xs text-neutral-500 dark:text-stone-400">
                  <span className="w-20 shrink-0 truncate" title={`${p.name} · ${p.label}`}>{p.label || p.name}</span>
                  {p.type === 'boolean' ? (
                    <input type="checkbox" checked={values[p.name] === true}
                      onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.checked }))} />
                  ) : (
                    <input type={p.type === 'number' ? 'number' : 'text'} className="h-7 min-w-0 flex-1 rounded-lg border border-neutral-300/60 bg-white/60 px-2 text-xs text-neutral-800 outline-none focus:border-violet-400 dark:border-stone-700/60 dark:bg-stone-800/40 dark:text-stone-200"
                      value={values[p.name] === undefined ? '' : String(values[p.name])}
                      placeholder={p.random === true ? t('modelSettings.comfyui.randomEachRun') : String(p.default)}
                      onChange={(e) => {
                        const raw = e.target.value;
                        setValues((v) => ({ ...v, [p.name]: p.type === 'number' ? (raw === '' ? undefined : Number(raw)) : raw }));
                      }} />
                  )}
                </label>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <button onClick={() => void generateWithWorkflow()} disabled={wfBusy || !api} className={btnCls}>
              {wfBusy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
              {t('modelSettings.comfyui.generateWith')}
            </button>
            {blueprintWf === selPath ? (
              <button onClick={clearBlueprint} className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border border-neutral-300 dark:border-stone-600 text-neutral-500 hover:bg-black/5 dark:hover:bg-white/5">
                <X size={14} />{t('modelSettings.comfyui.clearBlueprint')}
              </button>
            ) : (
              <button onClick={useForBlueprint} disabled={!api} className="shrink-0 flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border border-neutral-300 dark:border-stone-600 text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50">
                <GitBranch size={14} />{t('modelSettings.comfyui.useForBlueprint')}
              </button>
            )}
          </div>
          {wfErr && <div className="text-[11px] text-red-500 whitespace-pre-wrap break-all">{wfErr}</div>}
          {wfImg && <MediaOutput src={wfImg} alt={t('modelSettings.comfyui.resultAlt')} className="max-h-64 rounded-lg border border-neutral-200 dark:border-stone-700" />}
        </div>
      )}
      {/* ── 自定义节点放行 ──────────────────────────────────────────
          自定义节点可执行任意 Python。AI 自建工作流时，安全审计会把未放行的模块拦下；
          放行只能在这里由用户勾选，模型的工具参数无法自行放行。 */}
      <div className="rounded-lg border border-amber-300/60 dark:border-amber-700/50 bg-amber-50/40 dark:bg-amber-900/10 p-3 space-y-2">
        <div className="flex items-center gap-2">
          <ShieldAlert size={14} className="text-amber-600 dark:text-amber-400" />
          <span className="text-xs font-medium text-neutral-700 dark:text-stone-200">
            {t('modelSettings.comfyui.allowTitle')}
          </span>
          <button
            onClick={() => void scanCustomNodes()}
            disabled={customBusy}
            className="ml-auto shrink-0 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border border-neutral-300 dark:border-stone-600 text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
          >
            {customBusy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            {t('modelSettings.comfyui.allowScan')}
          </button>
        </div>
        <p className="text-[11px] leading-relaxed text-neutral-500 dark:text-stone-400">
          {t('modelSettings.comfyui.allowHint')}
        </p>
        {customErr && <div className="text-[11px] text-red-500 break-all">{customErr}</div>}
        {customModules !== null && Object.keys(customModules).length === 0 && (
          <div className="text-[11px] text-neutral-400 dark:text-stone-500">
            {t('modelSettings.comfyui.allowEmpty')}
          </div>
        )}
        {customModules !== null && Object.keys(customModules).length > 0 && (
          <div className="max-h-44 overflow-y-auto space-y-1">
            {Object.entries(customModules).map(([mod, classes]) => (
              <label key={mod} className="flex items-start gap-2 text-[11px] text-neutral-600 dark:text-stone-300">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={allowedModules.includes(mod)}
                  onChange={(e) => toggleModule(mod, e.target.checked)}
                />
                <span className="min-w-0">
                  <span className="break-all font-medium">{mod}</span>
                  <span className="ml-1 text-neutral-400 dark:text-stone-500">
                    {t('modelSettings.comfyui.allowNodeCount', { n: classes.length })}
                  </span>
                </span>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
