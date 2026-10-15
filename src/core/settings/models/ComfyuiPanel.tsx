// ComfyUI 本地生图面板（设置 → 模型 → 本地生图）。
// 三条用法并列：
//   ① 端点 + checkpoint + 提示词 → 内置最小 txt2img（原有快速通道）；
//   ② 工作流库：扫目录 → 选文件 →（UI 图自动转 API）→ 参数表单 → 按参生成，
//      复用用户在 ComfyUI 里调好的工作流（convert/params 为移植自 dsh-comfyui 的纯函数层）；
//   ③ 把一个工作流标记为「蓝图生图节点使用」（存路径，蓝图 image 节点运行时读取）。
// object_info 按端点做会话级缓存（数 MB，拉一次就够）。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { Image as ImageIcon, FolderOpen, RefreshCw, FileJson, Wand2, Loader2, GitBranch, X, ScrollText, ShieldAlert, Activity, Square } from 'lucide-react';
import { storage } from '@/core/storage';
import { KEYS } from '@/core/storage/keys';
import { convertGraphToApi } from '@/core/ai/comfyui/convert';
import { detectWorkflow } from '@/core/ai/comfyui/format';
import { getObjectInfo } from '@/core/ai/comfyui/objectInfo';
import { analyzeWorkflowParameters, applyWorkflowParameters } from '@/core/ai/comfyui/params';
import { loadSkillNotes, saveSkillNotes, skillSlug, skillSummary } from '@/core/ai/comfyui/skills';
import { customModulesOf, loadAllowedModules, saveAllowedModules } from '@/core/ai/media/customNodes';
import { MediaOutput } from '@/components/MediaOutput';
import type { Workflow, WorkflowParameter } from '@/core/ai/comfyui/params';

type TFunc = (k: string, vars?: Record<string, string | number>) => string;

interface WfFile {
  name: string;
  path: string;
  relative: string;
  size: number;
  modified_at: number;
}

export function ComfyuiPanel({ t }: { t: TFunc }) {
  // ① 内置最小流
  const [comfyuiUrl, setComfyuiUrl] = useState('http://127.0.0.1:8188');
  const [comfyuiCkpt, setComfyuiCkpt] = useState('');
  const [cmfyPrompt, setCmfyPrompt] = useState('');
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
  const [blueprintWf, setBlueprintWf] = useState('');
  const [blueprintSlug, setBlueprintSlug] = useState('');

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

  // 读配置（挂载时一次）
  useEffect(() => {
    setComfyuiUrl(storage.getString(KEYS.ai.comfyuiUrl.key, 'http://127.0.0.1:8188'));
    setComfyuiCkpt(storage.getString(KEYS.ai.comfyuiCkpt.key, ''));
    setWfDir(storage.getString(KEYS.ai.comfyuiWorkflowsDir.key, ''));
    setBlueprintWf(storage.getString(KEYS.ai.comfyuiBlueprintWf.key, ''));
    setBlueprintSlug(storage.getString(KEYS.ai.comfyuiBlueprintWfSlug.key, ''));
  }, []);

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
      const dataUrl = await invoke<string>('comfyui_generate_media', { prompt: p, comfyuiUrl, checkpoint: comfyuiCkpt });
      setImg(dataUrl);
    } catch (e) { setErr(String(e).slice(0, 200)); }
    finally { setBusy(false); }
  };

  const pickDir = async () => {
    try {
      const picked = await open({ directory: true });
      if (typeof picked === 'string' && picked) {
        setWfDir(picked);
        storage.setString(KEYS.ai.comfyuiWorkflowsDir.key, picked);
      }
    } catch (e) { setWfErr(String(e).slice(0, 150)); }
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
    } catch (e) { setWfErr(String(e).slice(0, 200)); }
    finally { setWfBusy(false); }
  };

  const useForBlueprint = () => {
    storage.setString(KEYS.ai.comfyuiBlueprintWf.key, selPath);
    storage.setString(KEYS.ai.comfyuiBlueprintWfSlug.key, notesSlug);
    setBlueprintWf(selPath);
    setBlueprintSlug(notesSlug);
  };
  const clearBlueprint = () => {
    storage.setString(KEYS.ai.comfyuiBlueprintWf.key, '');
    storage.setString(KEYS.ai.comfyuiBlueprintWfSlug.key, '');
    setBlueprintWf('');
    setBlueprintSlug('');
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
          <input className={`${inputCls} font-mono`} value={comfyuiCkpt} placeholder="sd_xl_base.safetensors" onChange={(e) => saveCkpt(e.target.value)} />
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
