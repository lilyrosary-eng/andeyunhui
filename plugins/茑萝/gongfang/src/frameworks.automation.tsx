/// <reference path="../../../global.d.ts" />
import React from 'react';
const { useCallback, useEffect, useState } = React;
import { AuditInput, AutomationTaskList, ScriptEditor, CollapsibleSection } from './frameworksShared';
import { tauriInvoke, CapabilityGrid, TechStackChips } from './frameworksShared';
import type { FitnessReport, AutionTemplatesReport, AutionTrajectoryReport, AutionDivergenceReport, AutionProbeReport, FrameworkMeta } from './frameworksShared';
// ============ 框架四：自动化测试 ============
const automationMeta: FrameworkMeta = {
  title: '自动化测试框架',
  subtitle: '行为模拟、人机混淆。已交付：贝塞尔轨迹 + 生理噪声 + SendInput 真实 HID 注入 + 模板适应度迁移 + 验证码识别（走视觉模型通道）。',
  posture: '攻防',
  capabilities: [
    '鼠标轨迹（三次贝塞尔 + 过冲回正，SendInput 真实注入）',
    '生理噪声（粉红噪声 + 疲劳抖动，随拟人化等级变化）',
    '键盘输入（正态分布按键/字符间隔）',
    '滚轮注入（视口滚动）',
    '行为模板 + 适应度评分与自动迁移（arc-swap 热交换）',
    '行为基线学习 + 探针幅度自适应调整',
    '图形验证码识别（复用主应用视觉 OCR 通道，多模态模型；未配置视觉模型时明确报错，不编造）',
    '滑块/点选验证码缺口定位（同一通道，要求模型输出坐标 JSON，可直接接鼠标轨迹注入）',
  ],
  capabilitiesPlanned: [
    '语音验证码旁路（需本地 Whisper 或云转写服务，当前无实现且涉及额外依赖/费用，暂不做）',
    'Ticket 窗口期预测复用（无实现方案）',
    '按键误触纠错',
    'Canvas 像素噪点反检测（现由爬虫 CDP 脚本承担）',
  ],
  techStack: [
    { name: 'winapi (SendInput)', license: 'MIT' },
    { name: 'arc-swap', license: 'MIT/Apache-2.0' },
    { name: 'tokio', license: 'MIT' },
  ],
  status: '部分交付',
};

function AutomationPanel({ addLog }: { addLog: (i: AuditInput) => void }) {
  // 验证码识别（视觉模型通道）状态
  const [capDataUrl, setCapDataUrl] = useState('');
  const [capMode, setCapMode] = useState<'text' | 'slider'>('text');
  const [capBusy, setCapBusy] = useState(false);
  const [capResult, setCapResult] = useState<string | null>(null);
  const [capError, setCapError] = useState<string | null>(null);

  // 选图：pick_file 拿路径 → read_file_base64 拿 data URL（两者均已在沙箱白名单）
  const handlePickCaptcha = useCallback(async () => {
    setCapError(null);
    try {
      const files = await tauriInvoke<string[]>('pick_file', {
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
      });
      if (!files || files.length === 0) return;
      const dataUrl = await tauriInvoke<string>('read_file_base64', { filePath: files[0] });
      setCapDataUrl(dataUrl);
      setCapResult(null);
      addLog({ action: '验证码取图', target: files[0], status: 'success', detail: '已载入图片，待识别' });
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setCapError(`载入图片失败：${msg}`);
    }
  }, [addLog]);

  // 识别：复用主应用既有的视觉 OCR 命令（多模态模型），不引入本地 OCR 原生依赖
  const handleCaptchaRecognize = useCallback(async () => {
    if (!capDataUrl) {
      setCapError('请先选择验证码图片');
      return;
    }
    const m = /^data:([^;]+);base64,(.*)$/s.exec(capDataUrl);
    if (!m) {
      setCapError('图片数据格式异常（期望 data URL）');
      return;
    }
    const mime = m[1];
    const b64 = m[2];
    const prompt =
      capMode === 'text'
        ? '图中是图形验证码。只输出验证码字符本身（区分大小写、忽略干扰线），不要任何解释、标点或换行。'
        : '图中是滑块/点选验证码。请定位缺口（或点选目标）在图中的像素坐标，只输出 JSON：{"x":<整数>,"y":<整数>}，不要任何解释。';
    setCapBusy(true);
    setCapError(null);
    try {
      const text = await tauriInvoke<string>('ai_vision_ocr', {
        imageBase64: b64,
        imageMime: mime,
        prompt,
        profileId: null,
      });
      setCapResult(text);
      addLog({
        action: '验证码识别',
        target: capMode === 'text' ? '文本验证码' : '滑块定位',
        status: 'success',
        detail: text.slice(0, 60),
      });
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setCapError(msg);
      addLog({ action: '验证码识别', target: capMode, status: 'error', detail: msg });
    } finally {
      setCapBusy(false);
    }
  }, [capDataUrl, capMode, addLog]);

  // 拟人化等级状态
  const [humanizeLevel, setHumanizeLevel] = useState(5);
  const [currentTemplate, setCurrentTemplate] = useState<string | null>(null);
  const [humanizeBusy, setHumanizeBusy] = useState(false);
  const [humanizeError, setHumanizeError] = useState<string | null>(null);

  // 适应度报告状态
  const [fitness, setFitness] = useState<FitnessReport[]>([]);
  const [fitnessBusy, setFitnessBusy] = useState(false);
  const [fitnessError, setFitnessError] = useState<string | null>(null);
  const [migrateMsg, setMigrateMsg] = useState<string | null>(null);

  // 根据等级返回说明
  const levelDesc = (lv: number): { label: string; cls: string } => {
    if (lv === 0) return { label: '机械精度模式', cls: 'text-rose-600 dark:text-rose-400' };
    if (lv <= 3) return { label: '低拟人化', cls: 'text-amber-600 dark:text-amber-400' };
    if (lv <= 7) return { label: '中拟人化', cls: 'text-sky-600 dark:text-sky-400' };
    return { label: '高拟人化', cls: 'text-violet-600 dark:text-violet-400' };
  };

  const handleApplyLevel = useCallback(async () => {
    setHumanizeBusy(true);
    setHumanizeError(null);
    try {
      const name = await tauriInvoke<string>('gongfang_humanize', { level: humanizeLevel });
      setCurrentTemplate(name);
      addLog({
        action: '设置拟人化等级',
        target: `L${humanizeLevel}`,
        status: 'success',
        detail: `当前模板：${name}`,
      });
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setHumanizeError(msg);
      addLog({ action: '设置拟人化等级', target: `L${humanizeLevel}`, status: 'error', detail: msg });
    } finally {
      setHumanizeBusy(false);
    }
  }, [humanizeLevel, addLog]);

  const handleRefreshFitness = useCallback(async () => {
    setFitnessBusy(true);
    setFitnessError(null);
    try {
      const r = await tauriInvoke<FitnessReport[]>('gongfang_fitness');
      setFitness(r);
      addLog({
        action: '查询适应度报告',
        target: '自动化框架',
        status: 'success',
        detail: `共 ${r.length} 个模板`,
      });
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setFitnessError(msg);
      addLog({ action: '查询适应度报告', target: '自动化框架', status: 'error', detail: msg });
    } finally {
      setFitnessBusy(false);
    }
  }, [addLog]);

  const handleMigrate = useCallback(async () => {
    setHumanizeBusy(true);
    setMigrateMsg(null);
    try {
      const msg = await tauriInvoke<string>('gongfang_fitness_migrate');
      setMigrateMsg(msg);
      // migrate 返回 "已迁移到: <模板名>"，直接解析提取模板名
      const match = msg.match(/已迁移到:\s*(.+)$/);
      if (match) setCurrentTemplate(match[1].trim());
      addLog({
        action: '触发热迁移',
        target: '自动化框架',
        status: 'success',
        detail: msg,
      });
      // 自动刷新适应度报告
      await handleRefreshFitness();
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setFitnessError(msg);
      addLog({ action: '触发热迁移', target: '自动化框架', status: 'error', detail: msg });
    } finally {
      setHumanizeBusy(false);
    }
  }, [addLog, handleRefreshFitness]);

  const handleReset = useCallback(async () => {
    setHumanizeBusy(true);
    setMigrateMsg(null);
    try {
      await tauriInvoke('gongfang_fitness_reset');
      addLog({
        action: '重置适应度统计',
        target: '自动化框架',
        status: 'success',
      });
      // 自动刷新
      await handleRefreshFitness();
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setFitnessError(msg);
      addLog({ action: '重置适应度统计', target: '自动化框架', status: 'error', detail: msg });
    } finally {
      setHumanizeBusy(false);
    }
  }, [addLog, handleRefreshFitness]);

  // 拉取当前生效模板（gongfang_automation_templates，用于可视化标记"当前"）
  const loadCurrentTpl = useCallback(async () => {
    try {
      const r = await tauriInvoke<{ current: string }>('gongfang_automation_templates', {});
      if (r && r.current) setCurrentTemplate(r.current);
    } catch {
      /* 引擎未启动 / feature 未启用时静默 */
    }
  }, []);
  useEffect(() => { loadCurrentTpl(); }, [loadCurrentTpl]);

  // 自动化行为实验室
  const [labTemplates, setLabTemplates] = useState<AutionTemplatesReport | null>(null);
  const [labTplBusy, setLabTplBusy] = useState(false);
  const [trajStartX, setTrajStartX] = useState(100);
  const [trajStartY, setTrajStartY] = useState(100);
  const [trajEndX, setTrajEndX] = useState(700);
  const [trajEndY, setTrajEndY] = useState(500);
  const [trajTpl, setTrajTpl] = useState(0);
  const [trajResult, setTrajResult] = useState<AutionTrajectoryReport | null>(null);
  const [trajBusy, setTrajBusy] = useState(false);
  const [divTpl, setDivTpl] = useState(0);
  const [divResult, setDivResult] = useState<AutionDivergenceReport | null>(null);
  const [divBusy, setDivBusy] = useState(false);

  const handleLabTemplates = useCallback(async () => {
    setLabTplBusy(true);
    try { setLabTemplates(await tauriInvoke<AutionTemplatesReport>('gongfang_automation_templates', {})); }
    catch { setLabTemplates(null); } finally { setLabTplBusy(false); }
  }, []);

  const handleTrajectory = useCallback(async () => {
    setTrajBusy(true);
    try {
      setTrajResult(await tauriInvoke<AutionTrajectoryReport>('gongfang_automation_trajectory', {
        startX: trajStartX, startY: trajStartY, targetX: trajEndX, targetY: trajEndY, templateId: trajTpl,
      }));
    } catch { setTrajResult(null); } finally { setTrajBusy(false); }
  }, [trajStartX, trajStartY, trajEndX, trajEndY, trajTpl]);

  const handleDivergence = useCallback(async () => {
    setDivBusy(true);
    try {
      const pts = Array.from({ length: 20 }, (_, i) => ({ x: trajStartX + ((trajEndX - trajStartX) * i) / 19, y: trajStartY + ((trajEndY - trajStartY) * i) / 19, t_ms: i * 50 }));
      setDivResult(await tauriInvoke<AutionDivergenceReport>('gongfang_automation_divergence', { points: pts, templateId: divTpl }));
    } catch { setDivResult(null); } finally { setDivBusy(false); }
  }, [trajStartX, trajStartY, trajEndX, trajEndY, divTpl]);

  // 探针调整器实验
  const [probeSeq, setProbeSeq] = useState('T T T T F T T');
  const [probeResult, setProbeResult] = useState<AutionProbeReport | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);

  const parseProbe = (s: string): boolean[] => s.split(/[\s,]+/).map((t) => t.trim().toUpperCase()).filter(Boolean).map((t) => t[0] !== 'F');

  const handleProbe = useCallback(async () => {
    setProbeBusy(true);
    try {
      const b = parseProbe(probeSeq);
      if (!b.length) { setProbeResult(null); return; }
      setProbeResult(await tauriInvoke<AutionProbeReport>('gongfang_automation_probe', { successes: b }));
    } catch { setProbeResult(null); } finally { setProbeBusy(false); }
  }, [probeSeq]);

  const lvInfo = levelDesc(humanizeLevel);

  // Pivot 真实注入目标（绝对屏幕坐标）：未设置时数据面跳过注入，不做假坐标
  const [tgtX, setTgtX] = useState('800');
  const [tgtY, setTgtY] = useState('600');
  const [tgtMsg, setTgtMsg] = useState<string | null>(null);
  const [tgtBusy, setTgtBusy] = useState(false);

  const handleSetTarget = useCallback(async () => {
    const x = Number(tgtX);
    const y = Number(tgtY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { setTgtMsg('坐标必须为数字'); return; }
    setTgtBusy(true);
    try {
      await tauriInvoke('gongfang_automation_target', { x, y });
      setTgtMsg(`已设置注入目标 (${x}, ${y})`);
    } catch {
      setTgtMsg('设置失败：自动化 feature 未编译或内核未启动');
    } finally { setTgtBusy(false); }
  }, [tgtX, tgtY]);

  const handleClearTarget = useCallback(async () => {
    setTgtBusy(true);
    try {
      await tauriInvoke('gongfang_automation_target_clear');
      setTgtMsg('已清除注入目标（Pivot 将跳过真实注入）');
    } catch {
      setTgtMsg('清除失败');
    } finally { setTgtBusy(false); }
  }, []);

  // 找出成功率最高的模板（热迁移的目标）
  const bestIdx = fitness.length > 0
    ? fitness.reduce((best, cur, i) => cur.success_rate > fitness[best].success_rate ? i : best, 0)
    : -1;
  const bestFitName = bestIdx >= 0 ? fitness[bestIdx].name : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-5">
        {/* 框架标题 */}
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-[var(--element-bg)]">{automationMeta.title}</h2>
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-violet-500/15 text-violet-600 dark:text-violet-400">{automationMeta.posture}</span>
          <span className="px-2 py-0.5 rounded text-[11px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">{automationMeta.status}</span>
        </div>
        <p className="text-sm text-neutral-500 dark:text-stone-400 leading-relaxed">{automationMeta.subtitle}</p>

        {/* 行为模板库 */}
        <CollapsibleSection title="行为模板库" storageKey="fw_automation_lab_templates" defaultOpen={false} accent="info">
          <div className="space-y-2">
            <button onClick={handleLabTemplates} disabled={labTplBusy} className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40">
              {labTplBusy ? '加载中...' : '加载模板库'}
            </button>
            {labTemplates && (
              <div className="space-y-1">
                <div className="text-[10px] text-neutral-400">当前活跃模板：<span className="text-[var(--element-bg)] font-medium">{labTemplates.current}</span></div>
                {labTemplates.templates.map((t) => (
                  <div key={t.id} className="flex items-center gap-2 text-[11px] rounded border border-black/5 dark:border-stone-700/40 p-1">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${t.id === labTemplates.fitness.find((f) => f.name === labTemplates.current)?.id ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : ''}`}>{t.id}</span>
                    <span className="font-medium text-[var(--element-bg)]">{t.name}</span>
                    <span className="text-[10px] text-neutral-400">速度{t.speed_factor} 过冲{t.overshoot} 噪声{t.noise_amplitude} {t.tremor_frequency}Hz 轮询{t.poll_interval_ms}ms</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CollapsibleSection>

        {/* 轨迹生成 */}
        <CollapsibleSection title="轨迹生成演示（贝塞尔 + 生理噪声）" storageKey="fw_automation_lab_traj" defaultOpen={false} accent="info">
          <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
              <div><div className="text-[10px] text-neutral-400 mb-1">起点 X</div><input type="number" value={trajStartX} onChange={(e) => setTrajStartX(Number(e.target.value))} className="w-full px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]" /></div>
              <div><div className="text-[10px] text-neutral-400 mb-1">起点 Y</div><input type="number" value={trajStartY} onChange={(e) => setTrajStartY(Number(e.target.value))} className="w-full px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]" /></div>
              <div><div className="text-[10px] text-neutral-400 mb-1">模板</div><select value={trajTpl} onChange={(e) => setTrajTpl(Number(e.target.value))} className="w-full px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]"><option value={0}>普通</option><option value={1}>急躁</option><option value={2}>谨慎</option><option value={3}>游戏</option><option value={4}>疲劳</option></select></div>
              <div><div className="text-[10px] text-neutral-400 mb-1">目标 X</div><input type="number" value={trajEndX} onChange={(e) => setTrajEndX(Number(e.target.value))} className="w-full px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]" /></div>
              <div><div className="text-[10px] text-neutral-400 mb-1">目标 Y</div><input type="number" value={trajEndY} onChange={(e) => setTrajEndY(Number(e.target.value))} className="w-full px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]" /></div>
              <div className="flex items-end"><button onClick={handleTrajectory} disabled={trajBusy} className="btn-press w-full px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40">{trajBusy ? '生成中...' : '生成轨迹'}</button></div>
            </div>
            {trajResult && (
              <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-2 space-y-1">
                <div className="text-[10px] text-neutral-400">模板 {trajResult.template} · 生成 {trajResult.point_count} 点 · 时长 {trajResult.duration_ms}ms · 过冲{trajResult.overshoot} · 噪声{trajResult.noise_amplitude}</div>
                <div className="flex flex-wrap gap-1 pt-1">
                  {trajResult.sample.map((p, i) => (
                    <span key={i} className="px-1 py-0.5 rounded text-[9px] font-mono bg-black/5 dark:bg-white/10 text-neutral-500 dark:text-stone-400">({p.x.toFixed(0)}, {p.y.toFixed(0)})</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CollapsibleSection>

        {/* 行为散度对比 */}
        <CollapsibleSection title="行为散度对比（人类相似判定）" storageKey="fw_automation_lab_div" defaultOpen={false} accent="info">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-neutral-400">对照模板</span>
              <select value={divTpl} onChange={(e) => setDivTpl(Number(e.target.value))} className="px-2 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]"><option value={0}>普通</option><option value={1}>急躁</option><option value={2}>谨慎</option><option value={3}>游戏</option><option value={4}>疲劳</option></select>
              <button onClick={handleDivergence} disabled={divBusy} className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40">
                {divBusy ? '对比中...' : '对比直线匀速轨迹'}
              </button>
            </div>
            {divResult && (
              <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-2 space-y-1">
                <div className="flex items-center gap-2">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${divResult.multidim < 0.15 ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : divResult.multidim <= 0.4 ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'}`}>{divResult.verdict}</span>
                  <span className="text-[10px] text-neutral-400">多维散度 <span className="font-mono text-[var(--element-bg)]">{divResult.multidim}</span> · 单向 {divResult.single}</span>
                </div>
                <p className="text-[10px] text-neutral-400 leading-relaxed">直线匀速轨迹是典型自动化特征，对照拟人模板应判定为「可疑/异常」。</p>
              </div>
            )}
          </div>
        </CollapsibleSection>

        {/* 探针调整器实验 */}
        <CollapsibleSection title="探针调整器（噪声幅度自适应）" storageKey="fw_automation_lab_probe" defaultOpen={false} accent="info">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={probeSeq}
                onChange={(e) => setProbeSeq(e.target.value)}
                placeholder="T/F 序列：T=成功(未触发风控) F=失败(回退)"
                className="flex-1 px-2.5 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400"
              />
              <button onClick={handleProbe} disabled={probeBusy} className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40">{probeBusy ? '模拟中...' : '模拟'}</button>
            </div>
            <div className="flex flex-wrap gap-2">
              {[
                { label: '全成功', v: 'T T T T T T T T' },
                { label: '先成功再失败回退', v: 'T T T T F T T' },
                { label: '反复触发风控', v: 'T F T F T F' },
              ].map((p) => (
                <button key={p.label} onClick={() => { setProbeSeq(p.v); setProbeResult(null); }} className="btn-press px-2 py-1 rounded-lg text-[10px] text-neutral-500 dark:text-stone-400 border border-black/10 dark:border-stone-700/50">{p.label}</button>
              ))}
            </div>
            <p className="text-[10px] text-neutral-400">观察幅度从 0.5 起自动试探爬升，命中失败(F)回退到上次成功值并细化步长，未命中(T)继续加压制——模拟风控边界搜寻。</p>
            {probeResult && (
              <div className="bg-black/[0.03] dark:bg-white/[0.04] rounded p-2 space-y-1.5">
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-[var(--element-bg)] font-medium">最终幅度</span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-sky-500/15 text-sky-600 dark:text-sky-400">{probeResult.final_amplitude}</span>
                  <span className="ml-auto text-[10px] text-neutral-400">{probeResult.rollbacks} 次回退</span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {probeResult.steps.map((s, i) => (
                    <span key={i} className={`px-1.5 py-0.5 rounded text-[10px] font-mono ${s.ok ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'}`}>{s.amplitude_after.toFixed(2)}</span>
                  ))}
                </div>
                <div className="text-[10px] text-neutral-400">{probeResult.note}</div>
              </div>
            )}
          </div>
        </CollapsibleSection>

        {/* 核心能力（已交付 / 计划中 分栏） */}
        <CollapsibleSection title="核心能力" storageKey="fw_automation_capabilities" defaultOpen={false} accent="info">
          <CapabilityGrid meta={automationMeta} />
        </CollapsibleSection>

        {/* 技术选型 */}
        <CollapsibleSection title="技术选型（优先 MIT/Apache 协议）" storageKey="fw_automation_techstack" defaultOpen={false} accent="info">
          <TechStackChips items={automationMeta.techStack} />
        </CollapsibleSection>

        {/* 验证码识别（视觉模型通道，复用主应用既有 ai_vision_ocr） */}
        <CollapsibleSection
          title="验证码识别（视觉模型）"
          storageKey="fw_automation_captcha"
          defaultOpen={false}
          accent="info"
          right={
            <>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">真实可用</span>
              <span className="text-[10px] text-neutral-400">多模态模型 · 零本地依赖</span>
            </>
          }
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={handlePickCaptcha}
                className="btn-press px-3 py-1.5 rounded-lg text-xs text-neutral-600 dark:text-stone-300 border border-black/10 dark:border-stone-700/50 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                选择验证码图片
              </button>
              <div className="flex items-center rounded-lg border border-black/10 dark:border-stone-700/50 overflow-hidden">
                {(['text', 'slider'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setCapMode(m)}
                    className={`px-2.5 py-1.5 text-[11px] transition-colors ${
                      capMode === m
                        ? 'bg-[var(--element-bg)] text-white'
                        : 'text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5'
                    }`}
                  >
                    {m === 'text' ? '文本验证码' : '滑块/点选定位'}
                  </button>
                ))}
              </div>
              <button
                onClick={handleCaptchaRecognize}
                disabled={capBusy || !capDataUrl}
                className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              >
                {capBusy ? '识别中...' : '识别'}
              </button>
            </div>

            {capError && (
              <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-600 dark:text-rose-400 break-all">{capError}</div>
            )}

            {capDataUrl && (
              <div className="rounded-lg border border-black/5 dark:border-stone-700/50 bg-white/40 dark:bg-white/[0.02] p-2">
                <img src={capDataUrl} alt="验证码" className="max-h-32 rounded border border-black/5 dark:border-stone-700/50" />
              </div>
            )}

            {capResult && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2">
                <div className="text-[10px] text-neutral-400 mb-1">识别结果（可直接用于自动化流程）</div>
                <div className="text-[12px] font-mono text-emerald-700 dark:text-emerald-400 break-all">{capResult}</div>
              </div>
            )}

            <p className="text-[10px] text-neutral-400 leading-relaxed">
              走主应用既有的视觉 OCR 通道（需在全局设置 → 模型中配置支持图像的模型，或单独配置视觉模型）。
              文本模式输出验证码字符，滑块模式要求模型返回缺口坐标 JSON，可直接喂给下方「鼠标轨迹」用
              <span className="font-mono"> @automation_target </span> 生成人类轨迹后注入。
              未配置视觉模型时会明确报错，不会返回编造结果。
            </p>
          </div>
        </CollapsibleSection>

        {/* 拟人化等级控制 */}
        <CollapsibleSection
          title="行为拟人化等级（@humanize）"
          storageKey="fw_automation_humanize"
          defaultOpen={true}
          accent="info"
          right={<span className="text-[10px] text-neutral-400">arc-swap 策略热交换</span>}
        >
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={10}
                step={1}
                value={humanizeLevel}
                onChange={(e) => setHumanizeLevel(Number(e.target.value))}
                className="flex-1 h-1.5 bg-black/10 dark:bg-white/10 rounded-full appearance-none cursor-pointer accent-[var(--element-bg)]"
              />
              <div className="flex items-baseline gap-2 min-w-[120px]">
                <span className="text-2xl font-mono font-semibold text-[var(--element-bg)]">{humanizeLevel}</span>
                <span className={`text-xs font-medium ${lvInfo.cls}`}>{lvInfo.label}</span>
              </div>
              <button
                onClick={handleApplyLevel}
                disabled={humanizeBusy}
                className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              >
                {humanizeBusy ? '应用中...' : '应用'}
              </button>
            </div>
            {/* 等级刻度 */}
            <div className="flex justify-between text-[9px] text-neutral-400 px-1">
              <span>0 机械</span>
              <span>3</span>
              <span>5 中</span>
              <span>7</span>
              <span>10 疲劳</span>
            </div>
            {currentTemplate && (
              <div className="text-[11px] text-neutral-500 dark:text-stone-400">
                当前模板：<span className="font-mono text-[var(--element-bg)]">{currentTemplate}</span>
              </div>
            )}
            {humanizeError && (
              <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-500/10 rounded-lg px-2.5 py-1.5">
                {humanizeError}
              </div>
            )}
            <p className="text-[10px] text-neutral-400 leading-relaxed">
              等级越高，鼠标贝塞尔曲线噪声越大、键盘延迟越长，越接近人类疲劳/醉酒状态；L0 关闭所有噪声，用于压力测试。
            </p>
          </div>
        </CollapsibleSection>

        {/* 适应度报告 */}
        <CollapsibleSection
          title="模板适应度报告"
          storageKey="fw_automation_fitness"
          defaultOpen={true}
          accent="info"
          right={
            <div className="flex items-center gap-1.5">
              <button
                onClick={handleRefreshFitness}
                disabled={fitnessBusy}
                className="btn-press px-2.5 py-1 rounded-lg text-[11px] text-neutral-600 dark:text-stone-300 border border-black/10 dark:border-stone-700/50 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {fitnessBusy ? '刷新中...' : '刷新'}
              </button>
              <button
                onClick={handleMigrate}
                disabled={humanizeBusy || fitness.length === 0}
                title="切换到适应度最高的模板"
                className="btn-press px-2.5 py-1 rounded-lg text-[11px] text-white bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                热迁移
              </button>
              <button
                onClick={handleReset}
                disabled={humanizeBusy || fitness.length === 0}
                title="清空所有模板的适应度统计"
                className="btn-press px-2.5 py-1 rounded-lg text-[11px] text-rose-600 dark:text-rose-400 border border-rose-500/30 hover:bg-rose-500/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                重置
              </button>
            </div>
          }
        >
          {/* 热迁移机制提示 */}
          <div className="rounded bg-black/[0.03] dark:bg-white/[0.04] border border-black/5 dark:border-stone-700/40 px-2.5 py-2 space-y-1.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--element-bg)]">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                <path d="M13 2 3 14h6l-2 8 11-13h-6l1-7z" />
              </svg>
              热迁移机制
              {fitness.length > 0 && bestFitName && (
                <span className="ml-auto font-normal text-[10px] text-neutral-500 dark:text-stone-400 truncate min-w-0">
                  当前 <span className="font-mono text-[var(--element-bg)]">{currentTemplate ?? '—'}</span>
                  {currentTemplate === bestFitName ? (
                    <span className="ml-1 text-emerald-600 dark:text-emerald-400">已达最优</span>
                  ) : (
                    <>
                      <span className="ml-1">→ 最优 <span className="font-mono text-emerald-600 dark:text-emerald-400">{bestFitName}</span></span>
                      <button
                        onClick={handleMigrate}
                        disabled={humanizeBusy}
                        className="ml-1.5 px-1.5 py-0.5 rounded text-[9px] text-white bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40"
                      >
                        立即迁移
                      </button>
                    </>
                  )}
                </span>
              )}
            </div>
            <ul className="space-y-0.5 list-disc pl-4 text-[10px] leading-relaxed text-neutral-500 dark:text-stone-400">
              <li>自动触发：单模板样本 ≥5 时，失败率＞50% 或 平均散度＞0.5 → 自动切换到最高分模板</li>
              <li>评分：score = 成功率 × 权重 − 平均散度 × 0.5（散度越低越接近人类基线）</li>
              <li>不重启内核：arc-swap 原子切换策略指针，下一个 HID 报文即生效</li>
            </ul>
          </div>

          {migrateMsg && (
            <div className="text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 rounded-lg px-2.5 py-1.5">
              {migrateMsg}
            </div>
          )}
          {fitnessError && (
            <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-500/10 rounded-lg px-2.5 py-1.5">
              {fitnessError}
            </div>
          )}

          {/* 适应度可视化：成功率条形对比 + BEST/当前标记 */}
          {fitness.length > 0 && (
            <div className="space-y-1.5">
              {fitness.map((f, i) => {
                const isBest = i === bestIdx;
                const isCurrent = f.name === currentTemplate;
                const ratePct = f.success_rate * 100;
                const barColor = f.success_rate > 0.8
                  ? 'bg-emerald-500'
                  : f.success_rate > 0.5
                  ? 'bg-amber-500'
                  : 'bg-rose-500';
                const rateText = f.success_rate > 0.8
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : f.success_rate > 0.5
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-rose-600 dark:text-rose-400';
                return (
                  <div
                    key={f.id}
                    className={`rounded border px-2 py-1 transition-colors ${
                      isBest
                        ? 'border-emerald-500/40 bg-emerald-500/[0.04]'
                        : 'border-black/5 dark:border-stone-700/40'
                    } ${isCurrent ? 'ring-1 ring-violet-400/50' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-mono text-neutral-400 dark:text-stone-500 shrink-0">{f.id}</span>
                        <span className="font-medium text-[var(--element-bg)] truncate">{f.name}</span>
                        {isBest && <span className="shrink-0 px-1 rounded text-[9px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">BEST</span>}
                        {isCurrent && <span className="shrink-0 px-1 rounded text-[9px] bg-violet-500/15 text-violet-600 dark:text-violet-400">当前</span>}
                        <span className="shrink-0 text-[9px] text-neutral-400">偏离 {f.avg_divergence.toFixed(3)}</span>
                      </div>
                      <span className={`shrink-0 font-mono text-[10px] ${rateText}`}>{ratePct.toFixed(1)}%</span>
                    </div>
                    <div className="mt-1 h-1.5 rounded bg-black/5 dark:bg-white/10 overflow-hidden">
                      <div
                        className={`h-full rounded transition-[width] duration-300 ${barColor}`}
                        style={{ width: `${Math.max(2, Math.min(100, ratePct))}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {fitness.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-neutral-400 border-b border-black/5 dark:border-stone-700/50">
                    <th className="py-1.5 pr-3">ID</th>
                    <th className="py-1.5 pr-3">模板名</th>
                    <th className="py-1.5 pr-3">成功</th>
                    <th className="py-1.5 pr-3">失败</th>
                    <th className="py-1.5 pr-3">成功率</th>
                    <th className="py-1.5">平均偏离度</th>
                  </tr>
                </thead>
                <tbody>
                  {fitness.map((f, i) => {
                    const isBest = i === bestIdx;
                    const ratePct = (f.success_rate * 100).toFixed(1);
                    const rateCls = f.success_rate > 0.8
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : f.success_rate > 0.5
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-rose-600 dark:text-rose-400';
                    return (
                      <tr key={f.id} className={`border-b border-black/[0.03] dark:border-stone-700/30 ${isBest ? 'bg-emerald-500/[0.04]' : ''}`}>
                        <td className="py-1.5 pr-3 font-mono text-neutral-500 dark:text-stone-400">{f.id}</td>
                        <td className="py-1.5 pr-3 font-mono text-[var(--element-bg)]">
                          {f.name}
                          {isBest && (
                            <span className="ml-1.5 px-1 py-0.5 rounded text-[9px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">BEST</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-3 text-emerald-600 dark:text-emerald-400">{f.success}</td>
                        <td className="py-1.5 pr-3 text-rose-600 dark:text-rose-400">{f.failure}</td>
                        <td className={`py-1.5 pr-3 font-mono ${rateCls}`}>{ratePct}%</td>
                        <td className="py-1.5 font-mono text-neutral-500 dark:text-stone-400">{f.avg_divergence.toFixed(3)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            !fitnessBusy && !fitnessError && (
              <p className="text-[11px] text-neutral-400">暂无适应度数据。自动化任务执行时会自动累计成功/失败计数，热迁移将切换到成功率最高且偏离度最低的模板。</p>
            )
          )}
          <p className="text-[10px] text-neutral-400 leading-relaxed">
            热迁移：在运行时不重启内核的前提下，通过 arc-swap 切换策略指针到最优模板；偏离度越低，行为越接近真实人类。
          </p>
        </CollapsibleSection>

        {/* Pivot 真实注入目标（绝对屏幕坐标；未设置则数据面跳过注入，不做假坐标） */}
        <CollapsibleSection title="Pivot 注入目标" storageKey="fw_automation_pivot_target" defaultOpen={false} accent="info"
          right={<span className="text-[10px] text-neutral-400">SendInput 真实注入坐标</span>}
        >
          <div className="space-y-1.5">
            <div className="text-[10px] text-neutral-500 dark:text-stone-400 leading-relaxed">
              该坐标是 Pivot 阶段 <code className="px-1 rounded bg-black/5 dark:bg-white/10 font-mono">SendInput</code> 将真实鼠标移到的绝对屏幕位置（px）。
              未设置时内核<b>跳过真实注入</b>，不会往假坐标移动鼠标——一切轨迹只用于演示。设置后请谨慎使用。
            </div>
            <div className="flex items-center gap-1.5">
              <label className="text-[10px] text-neutral-400">X</label>
              <input type="number" value={tgtX} onChange={(e) => setTgtX(e.target.value)} className="w-20 px-2 py-1 rounded-lg text-[11px] bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]" />
              <label className="text-[10px] text-neutral-400">Y</label>
              <input type="number" value={tgtY} onChange={(e) => setTgtY(e.target.value)} className="w-20 px-2 py-1 rounded-lg text-[11px] bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)]" />
              <button onClick={handleSetTarget} disabled={tgtBusy} className="btn-press px-2.5 py-1 rounded-lg text-[11px] font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40">{tgtBusy ? '保存中...' : '设置目标'}</button>
              <button onClick={handleClearTarget} disabled={tgtBusy} className="btn-press px-2.5 py-1 rounded-lg text-[11px] text-rose-600 dark:text-rose-400 border border-rose-500/30 hover:bg-rose-500/10 disabled:opacity-40">清除</button>
            </div>
            {tgtMsg && <div className="text-[10px] text-neutral-500 dark:text-stone-400">{tgtMsg}</div>}
          </div>
        </CollapsibleSection>

        {/* P1：任务列表 + 模板对比（前端状态机 + 基于 fitness 找最优模板） */}
        <AutomationTaskList fitness={fitness} />

        {/* P2：脚本编辑器（CodeMirror 6 + 语法高亮 + 模板插入 + localStorage 持久化） */}
        <ScriptEditor storageKey="gongfang_automation_script" />
      </div>
    </div>
  );
}


export { AutomationPanel };
