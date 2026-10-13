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
import { Image as ImageIcon, FolderOpen, RefreshCw, FileJson, Wand2, Loader2, GitBranch, X, ScrollText } from 'lucide-react';
import { storage } from '@/core/storage';
import { KEYS } from '@/core/storage/keys';
import { convertGraphToApi } from '@/core/ai/comfyui/convert';
import { detectWorkflow } from '@/core/ai/comfyui/format';
import { getObjectInfo } from '@/core/ai/comfyui/objectInfo';
import { analyzeWorkflowParameters, applyWorkflowParameters } from '@/core/ai/comfyui/params';
import { loadSkillNotes, saveSkillNotes, skillSlug, skillSummary } from '@/core/ai/comfyui/skills';
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
      <div className="flex items-center gap-2">
        <input className={`flex-1 ${inputCls}`} value={cmfyPrompt} placeholder={t('modelSettings.comfyui.promptPlaceholder')}
          onChange={(e) => setCmfyPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void quickGenerate(); }} />
        <button onClick={() => void quickGenerate()} disabled={busy} className={btnCls}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
          {busy ? t('modelSettings.comfyui.generating') : t('modelSettings.comfyui.generate')}
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
    </div>
  );
}
