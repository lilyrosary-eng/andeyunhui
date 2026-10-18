/// <reference path="../../../global.d.ts" />
import React from 'react';
const { useCallback, useState } = React;
import { AuditInput, DisassemblyView, CollapsibleSection } from './frameworksShared';
import { tauriInvoke, CapabilityGrid, TechStackChips, StatusCard } from './frameworksShared';
import type { CryptoReport, EncodeAnalysis, DfaGraph, BinaryAnalysis, SymbolSummary, FrameworkMeta } from './frameworksShared';
// ============ 框架二：逆向工程 ============
const reverseMeta: FrameworkMeta = {
  title: '逆向工程框架',
  subtitle: '协议分析、加解密绕过。已交付：加密算法识别（卡方检验）+ 多层编码链分析 + 协议 DFA 归纳 + 本地二进制真实反汇编 / WASM 结构解析（内置轨）。动态插桩不做（许可证偏好），Ghidra 深度轨按需再接入。',
  posture: '攻防',
  capabilities: [
    '加密算法特征向量库匹配（卡方检验，零依赖自实现）',
    '多层编码链识别与递归解码',
    '协议 DFA 归纳与执行（基于真实流量样本；无样本时明确报错）',
    '本地二进制静态分析：PE/ELF/Mach-O 段表 + 符号 + 导入导出',
    '真实反汇编（iced-x86，x86/x64）：实测 4.2MB PE 1.5s 出 79.7 万指令 / 22.3 万基本块 / 25.5 万 CFG 边',
    'WASM 结构解析（wasmparser）：节表 / 类型 / 导入导出 / 逐函数指令与控制块统计 / 数据段常量池；实测 16,807 函数模块 0.4s',
    '常量池提取（数据段字符串，Salt / URL / 错误信息等；实测同一 PE 出 300 条）',
    '控制流反混淆（petgraph 高介数分发块裁剪，已由内置轨喂入真实基本块）',
    '符号库持久化（<AppData>/gongfang/symbols.json，跨会话复用）',
  ],
  capabilitiesPlanned: [
    'Ghidra headless 深度轨（P-Code IR / 跨指令集）——按需接入：内置轨已覆盖 x86/x64 反汇编/CFG/常量池，接口与路径解析已对齐',
    'SIGTRAP 反调试对抗',
    '内存快照热加载脱壳（process_vm_readv）',
    'P-Code → Rust 伪代码翻译（AI 辅助）',
    'WASM 数据流图（DFG）重建——当前只做结构/规模/常量，不做 SSA 语义还原',
  ],
  techStack: [
    { name: 'iced-x86', license: 'MIT' },
    { name: 'object', license: 'MIT' },
    { name: 'wasmparser', license: 'Apache-2.0 WITH LLVM-exc.' },
    { name: 'petgraph', license: 'MIT' },
    { name: 'base64', license: 'MIT' },
    { name: 'tokio', license: 'MIT' },
    { name: 'ghidra_headless', license: 'Apache-2.0', integrated: false },
  ],
  status: '部分交付',
};

function ReversePanel({ addLog }: { addLog: (i: AuditInput) => void }) {
  // 加密识别状态
  const [hexInput, setHexInput] = useState('');
  const [cryptoReport, setCryptoReport] = useState<CryptoReport | null>(null);
  const [cryptoBusy, setCryptoBusy] = useState(false);
  const [cryptoError, setCryptoError] = useState<string | null>(null);

  // 编码/哈希识别状态
  const [encInput, setEncInput] = useState('');
  const [encResult, setEncResult] = useState<EncodeAnalysis | null>(null);
  const [encChain, setEncChain] = useState<EncodeAnalysis[] | null>(null);
  const [encBusy, setEncBusy] = useState(false);

  // 协议状态机可视化状态
  const [pUrl, setPUrl] = useState('');
  const [pGraph, setPGraph] = useState<DfaGraph | null>(null);
  const [pBusy, setPBusy] = useState(false);

  // 二进制静态分析（内置轨：本地文件真实反汇编）
  const [binPath, setBinPath] = useState('');
  const [binBusy, setBinBusy] = useState(false);
  const [binResult, setBinResult] = useState<BinaryAnalysis | null>(null);
  const [binError, setBinError] = useState<string | null>(null);

  // 选择本地二进制（走沙箱放行的 pick_file）
  const handlePickBinary = useCallback(async () => {
    try {
      const files = await tauriInvoke<string[]>('pick_file');
      if (files && files.length > 0) {
        setBinPath(files[0]);
        setBinError(null);
      }
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setBinError(`选择文件失败：${msg}`);
    }
  }, []);

  // 二进制静态分析：真实反汇编（非伪汇编）
  const handleBinaryAnalyze = useCallback(async () => {
    const p = binPath.trim();
    if (!p) {
      setBinError('请先选择文件或填写二进制路径');
      return;
    }
    setBinBusy(true);
    setBinError(null);
    try {
      const r = await tauriInvoke<BinaryAnalysis>('gongfang_binary_analyze', { path: p, includeGraph: false });
      setBinResult(r);
      addLog({
        action: '二进制静态分析',
        target: p,
        status: 'success',
        detail: `${r.format}/${r.arch} · ${r.instruction_count} 指令 · ${r.block_count} 基本块 · 常量池 ${r.strings.length}`,
      });
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setBinError(msg);
      addLog({ action: '二进制静态分析', target: p, status: 'error', detail: msg });
    } finally {
      setBinBusy(false);
    }
  }, [binPath, addLog]);

  const handleEncodeAnalyze = useCallback(async () => {
    const input = encInput.trim();
    if (!input) return;
    setEncBusy(true);
    try {
      const r = await tauriInvoke<EncodeAnalysis>('gongfang_encode_analyze', { input });
      setEncResult(r);
      addLog({ action: '编码/哈希识别', target: r.kind, status: 'success', detail: r.label });
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      addLog({ action: '编码/哈希识别', target: encInput.trim(), status: 'error', detail: msg });
    } finally {
      setEncBusy(false);
    }
  }, [encInput, addLog]);

  // 多层/递归解码（base64(hex(base64(…))) 剥洋葱）
  const handleEncodeChain = useCallback(async () => {
    const input = encInput.trim();
    if (!input) return;
    setEncBusy(true);
    try {
      const chain = await tauriInvoke<EncodeAnalysis[]>('gongfang_encode_chain', { input, maxLayers: 8 });
      setEncChain(chain);
      addLog({ action: '多层解码', target: `共 ${chain.length} 层`, status: 'success' });
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      addLog({ action: '多层解码', target: encInput.trim(), status: 'error', detail: msg });
    } finally {
      setEncBusy(false);
    }
  }, [encInput, addLog]);

  // 协议状态机：加载 DFA 图数据（必须指定目标 —— 后端不再返回示例状态机）
  const handleProtocolGraph = useCallback(async () => {
    const url = pUrl.trim();
    if (!url) {
      addLog({ action: '协议状态机', target: '—', status: 'error', detail: '请先填写目标 URL（无目标时不返回示例状态机）' });
      return;
    }
    setPBusy(true);
    try {
      const g = await tauriInvoke<DfaGraph>('gongfang_protocol_graph', { url });
      setPGraph(g);
      addLog({ action: '协议状态机', target: url, status: 'success', detail: `${g.state_count} 状态 · ${g.transition_count} 转移` });
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      addLog({ action: '协议状态机', target: url, status: 'error', detail: msg });
    } finally {
      setPBusy(false);
    }
  }, [pUrl, addLog]);

  // 渲染 DFA 为 SVG（圆周布局）
  const renderProtocolGraph = (g: DfaGraph | null): React.ReactNode => {
    if (!g || g.nodes.length === 0) {
      return <p className="text-[11px] text-neutral-400">目标尚未学习状态机。用协议学习器学习后此处展示其 DFA；当前留空。</p>;
    }
    const W = 520, H = 300, cx = 260, cy = 150, r = Math.min(W, H) / 2 - 70;
    const pos = new Map<number, { x: number; y: number }>();
    g.nodes.forEach((node, i) => {
      const a = (Math.PI * 2 * i) / g.nodes.length - Math.PI / 2;
      pos.set(node.id, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    });
    const edgeEls = g.edges.map((e, idx) => {
      const p1 = pos.get(e.from), p2 = pos.get(e.to);
      if (!p1 || !p2) return null;
      let d: string; let lx: number; let ly: number;
      if (e.from === e.to) {
        d = `M ${p1.x - 30} ${p1.y - 6} Q ${p1.x - 56} ${p1.y - 50} ${p1.x + 6} ${p1.y - 28}`;
        lx = p1.x - 26; ly = p1.y - 36;
      } else {
        const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const len = Math.hypot(dx, dy) || 1;
        const ox = (-dy / len) * 24, oy = (dx / len) * 24;
        lx = mx + ox; ly = my + oy;
        d = `M ${p1.x} ${p1.y} Q ${lx} ${ly} ${p2.x} ${p2.y}`;
      }
      return (
        <g key={idx}>
          <path d={d} fill="none" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.2" markerEnd="url(#dfaArrow)" />
          <circle cx={lx} cy={ly} r={9} fill="var(--element-bg)" />
          <text x={lx} y={ly + 3} textAnchor="middle" fontSize="8" fill="#fff" fontFamily="monospace">{e.label}</text>
        </g>
      );
    });
    const nodeEls = g.nodes.map((node) => {
      const p = pos.get(node.id);
      if (!p) return null;
      return (
        <g key={node.id}>
          {node.initial && <circle cx={p.x} cy={p.y} r={20} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.2" />}
          <circle cx={p.x} cy={p.y} r={node.accept ? 15 : 12}
            fill={node.accept ? 'rgba(16,185,129,0.15)' : 'rgba(0,0,0,0.05)'}
            stroke={node.accept ? '#10b981' : node.initial ? '#0ea5e9' : 'currentColor'}
            strokeWidth={node.accept ? 2.4 : 1.4}
          />
          {node.accept && <circle cx={p.x} cy={p.y} r={9} fill="none" stroke="#10b981" strokeOpacity="0.5" strokeWidth="1" />}
          <text x={p.x} y={p.y + 3.5} textAnchor="middle" fontSize="11" fill="currentColor" fontFamily="monospace">{node.id}</text>
        </g>
      );
    });
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-h-[320px]" role="img" aria-label="协议状态机 DFA">
        <defs>
          <marker id="dfaArrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 z" fill="currentColor" />
          </marker>
        </defs>
        {edgeEls}{nodeEls}
      </svg>
    );
  };

  // 符号库查询状态
  const [symUrl, setSymUrl] = useState('');
  const [symbols, setSymbols] = useState<SymbolSummary[]>([]);
  const [symBusy, setSymBusy] = useState(false);
  const [symError, setSymError] = useState<string | null>(null);

  const handleCryptoIdentify = useCallback(async () => {
    const trimmed = hexInput.replace(/\s+/g, '');
    if (!trimmed) {
      setCryptoError('请输入 hex 字符串');
      return;
    }
    if (!/^[0-9a-fA-F]+$/.test(trimmed)) {
      setCryptoError('包含非 hex 字符（仅允许 0-9, a-f, A-F）');
      return;
    }
    if (trimmed.length % 2 !== 0) {
      setCryptoError('hex 长度必须为偶数');
      return;
    }
    setCryptoBusy(true);
    setCryptoError(null);
    try {
      const r = await tauriInvoke<CryptoReport>('gongfang_crypto_identify', { hexData: trimmed });
      setCryptoReport(r);
      addLog({
        action: '加密识别',
        target: `${r.data_len} 字节`,
        status: 'success',
        detail: r.matched_algorithm
          ? `匹配 ${r.matched_algorithm}（置信度 ${((r.confidence ?? 0) * 100).toFixed(0)}%）`
          : `未匹配已知算法（卡方=${r.chi_square.toFixed(1)}, 熵=${r.entropy.toFixed(2)}）`,
      });
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setCryptoError(msg);
      addLog({ action: '加密识别', target: 'hex 数据', status: 'error', detail: msg });
    } finally {
      setCryptoBusy(false);
    }
  }, [hexInput, addLog]);

  const handleSymbolsQuery = useCallback(async () => {
    setSymBusy(true);
    setSymError(null);
    try {
      const url = symUrl.trim() || null;
      const r = await tauriInvoke<SymbolSummary[]>('gongfang_symbols', { url });
      setSymbols(r);
      addLog({
        action: '符号库查询',
        target: symUrl.trim() || '全部',
        status: 'success',
        detail: `共 ${r.length} 个符号`,
      });
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      setSymError(msg);
      addLog({ action: '符号库查询', target: symUrl.trim() || '全部', status: 'error', detail: msg });
    } finally {
      setSymBusy(false);
    }
  }, [symUrl, addLog]);

  // 把识别结果存为符号（写入持久化符号库）
  const handleSaveSymbol = useCallback(async () => {
    if (!encResult) return;
    const target = symUrl.trim() || pUrl.trim() || 'inline';
    const isEnc = ['hex', 'base64', 'base32', 'url'].includes(encResult.kind);
    const nameSource = encResult.is_text && encResult.preview ? encResult.preview.slice(0, 20).replace(/\s+/g, '_') : encResult.kind;
    const name = `${nameSource}_${encResult.kind}`;
    setSymBusy(true);
    try {
      await tauriInvoke('gongfang_symbol_add', { req: { url: target, name, kind: isEnc ? 'protocol' : 'crypto' } });
      addLog({ action: '存为符号', target, status: 'success', detail: name });
      await handleSymbolsQuery();
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? String(e);
      addLog({ action: '存为符号', target, status: 'error', detail: msg });
    } finally {
      setSymBusy(false);
    }
  }, [encResult, symUrl, pUrl, addLog, handleSymbolsQuery]);

  // 置信度百分比（0-1 → 0-100）
  const confidencePct = cryptoReport?.confidence != null
    ? Math.round(cryptoReport.confidence * 100)
    : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-5">
        {/* 框架标题 */}
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-[var(--element-bg)]">{reverseMeta.title}</h2>
          <span className="px-2 py-0.5 rounded text-xs font-medium bg-violet-500/15 text-violet-600 dark:text-violet-400">{reverseMeta.posture}</span>
          <span className="px-2 py-0.5 rounded text-[11px] bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">{reverseMeta.status}</span>
        </div>
        <p className="text-sm text-neutral-500 dark:text-stone-400 leading-relaxed">{reverseMeta.subtitle}</p>

        {/* 核心能力（已交付 / 计划中 分栏） */}
        <CollapsibleSection title="核心能力" storageKey="fw_reverse_capabilities" defaultOpen={false} accent="info">
          <CapabilityGrid meta={reverseMeta} />
        </CollapsibleSection>

        {/* 技术选型 */}
        <CollapsibleSection title="技术选型（优先 MIT/Apache 协议）" storageKey="fw_reverse_techstack" defaultOpen={false} accent="info">
          <TechStackChips items={reverseMeta.techStack} />
        </CollapsibleSection>

        {/* 加密识别 */}
        <CollapsibleSection
          title="加密算法识别（卡方检验 + 特征向量库）"
          storageKey="fw_reverse_crypto"
          defaultOpen={true}
          accent="info"
          right={<span className="text-[10px] text-neutral-400">零依赖自实现 · 替代 DFA/Gröbner</span>}
        >
          <div className="space-y-2">
            <textarea
              value={hexInput}
              onChange={(e) => setHexInput(e.target.value)}
              placeholder="粘贴 hex 字符串（空格/换行会自动忽略），如 6e3a5f2c8b1d4a7e..."
              rows={3}
              className="w-full px-2.5 py-1.5 rounded-lg text-xs font-mono bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-[var(--element-bg)] resize-y"
            />
            <div className="flex items-center gap-2">
              <button
                onClick={handleCryptoIdentify}
                disabled={cryptoBusy || !hexInput.trim()}
                className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              >
                {cryptoBusy ? '识别中...' : '识别算法'}
              </button>
              <button
                onClick={() => { setHexInput(''); setCryptoReport(null); setCryptoError(null); }}
                disabled={!hexInput.trim() && !cryptoReport}
                className="btn-press px-2.5 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 border border-black/10 dark:border-stone-700/50 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40"
              >
                清空
              </button>
              <span className="text-[10px] text-neutral-400">
                {hexInput.replace(/\s+/g, '').length} 字符 · {hexInput.replace(/\s+/g, '').length / 2} 字节
              </span>
            </div>
            {cryptoError && (
              <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-500/10 rounded-lg px-2.5 py-1.5">
                {cryptoError}
              </div>
            )}
          </div>

          {/* 加密识别结果 */}
          {cryptoReport && (
            <div className="space-y-2 pt-1">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <StatusCard label="数据长度" value={`${cryptoReport.data_len} 字节`} />
                <StatusCard label="块大小" value={cryptoReport.block_size ? `${cryptoReport.block_size} 字节` : '—'} valueCls="font-mono text-[11px]" />
                <StatusCard
                  label="分布判定"
                  value={cryptoReport.is_uniform ? '均匀（疑似加密）' : '非均匀（疑似编码）'}
                  valueCls={cryptoReport.is_uniform ? 'text-amber-600 dark:text-amber-400' : 'text-sky-600 dark:text-sky-400'}
                />
                <StatusCard
                  label="卡方值"
                  value={cryptoReport.chi_square.toFixed(1)}
                  valueCls={cryptoReport.chi_square > 300 ? 'text-rose-600 dark:text-rose-400' : ''}
                />
                <StatusCard
                  label="香农熵"
                  value={cryptoReport.entropy.toFixed(3)}
                  valueCls={cryptoReport.entropy > 7.5 ? 'text-amber-600 dark:text-amber-400' : ''}
                />
                <StatusCard
                  label="匹配算法"
                  value={cryptoReport.matched_algorithm ?? '未匹配'}
                  valueCls={cryptoReport.matched_algorithm ? 'text-emerald-600 dark:text-emerald-400 font-mono text-[11px]' : ''}
                />
              </div>
              {cryptoReport.matched_algorithm && confidencePct != null && (
                <div className="bg-black/[0.03] dark:bg-white/[0.03] rounded-lg p-2.5 border border-black/5 dark:border-stone-700/50">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-neutral-400">置信度</span>
                    <span className="text-xs font-mono text-[var(--element-bg)]">{confidencePct}%</span>
                  </div>
                  <div className="h-1.5 bg-black/5 dark:bg-white/10 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-500 rounded-full transition-all"
                      style={{ width: `${confidencePct}%` }}
                    />
                  </div>
                </div>
              )}
              <p className="text-[10px] text-neutral-400 leading-relaxed">
                卡方值 &gt; 300 → p &lt; 0.05 非均匀分布（可能非标准加密）；熵 &gt; 7.5 → 高熵（疑似加密或压缩）。
              </p>
            </div>
          )}
        </CollapsibleSection>

        {/* 编码/哈希识别（粘贴任意字符串，自动识别 hex/base64/url/明文/哈希） */}
        <CollapsibleSection
          title="编码 / 哈希 / 明文识别"
          storageKey="fw_reverse_encode"
          defaultOpen={true}
          accent="info"
          right={<span className="text-[10px] text-neutral-400">自动分类 + 尝试解码</span>}
        >
          <div className="space-y-2">
            <textarea
              value={encInput}
              onChange={(e) => setEncInput(e.target.value)}
              placeholder="粘贴任意字符串：hex / base64 / URL 编码 / 哈希 / 明文…"
              rows={3}
              className="w-full px-2.5 py-1.5 rounded-lg text-xs font-mono bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-[var(--element-bg)] resize-y"
            />
            <button
              onClick={handleEncodeAnalyze}
              disabled={encBusy || !encInput.trim()}
              className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
            >
              {encBusy ? '识别中...' : '识别'}
            </button>
            <button
              onClick={handleEncodeChain}
              disabled={encBusy || !encInput.trim()}
              title="对 base64(hex(base64(…))) 等多层包裹逐层解码"
              className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-violet-500 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
            >
              {encBusy ? '解码中...' : '多层解码'}
            </button>
            <p className="text-[10px] text-neutral-400 leading-relaxed">
              例：Base64 文本 → 解码；偶数长度 hex → 解码；32/40/64 位 hex → 反推 MD5/SHA-1/SHA-256。
            </p>

            {encResult && (
              <div className="rounded-lg border border-black/10 dark:border-stone-700/50 overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 bg-black/[0.03] dark:bg-white/[0.05] border-b border-black/5 dark:border-stone-700/50">
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-violet-500/15 text-violet-600 dark:text-violet-400">{encResult.kind}</span>
                  <span className="text-xs text-[var(--element-bg)]">{encResult.label}</span>
                  <span className="ml-auto text-[10px] text-neutral-400 tabular-nums">熵 {encResult.entropy.toFixed(2)}</span>
                </div>
                <div className="px-3 py-2 space-y-1.5">
                  {encResult.is_text && encResult.preview && (
                    <pre className="max-h-40 overflow-auto text-[11px] font-mono text-neutral-600 dark:text-stone-300 bg-black/[0.03] dark:bg-white/[0.05] rounded p-2 whitespace-pre-wrap break-all">
                      {encResult.preview}
                    </pre>
                  )}
                  {!encResult.is_text && encResult.decoded && encResult.decoded.length > 0 && (
                    <div className="text-[10px] text-neutral-400">
                      解码 {encResult.decoded.length} 字节（非文本）：{encResult.decoded.slice(0, 24).map((b) => b.toString(16).padStart(2, '0')).join(' ')}{encResult.decoded.length > 24 ? '…' : ''}
                    </div>
                  )}
                  {encResult.hash_algo && (
                    <div className="text-[10px] text-neutral-400">哈希算法：{encResult.hash_algo}</div>
                  )}
                  {encResult.stream_hint && (
                    <div className="text-[10px] text-neutral-400">
                      文件/压缩流特征：<span className="px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-600 dark:text-sky-400 font-mono">{encResult.stream_hint}</span>
                    </div>
                  )}
                  <div className="pt-1">
                    <button
                      onClick={handleSaveSymbol}
                      title={`保存到符号库（目标：${symUrl.trim() || pUrl.trim() || 'inline'}）`}
                      className="btn-press px-2 py-1 rounded-lg text-[10px] text-violet-600 dark:text-violet-400 border border-violet-500/30 hover:bg-violet-500/10 transition-colors"
                    >
                      保存为符号
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* 多层解码链 */}
            {encChain && encChain.length > 0 && (
              <div className="space-y-1">
                <div className="text-[10px] text-neutral-400">多层解码链（{encChain.length} 层）：</div>
                {encChain.map((layer, i) => (
                  <div key={i} className="flex items-start gap-2 rounded bg-black/[0.03] dark:bg-white/[0.04] border border-black/5 dark:border-stone-700/40 p-1.5">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-violet-500/15 text-violet-600 dark:text-violet-400 shrink-0">{i + 1}·{layer.kind}</span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] text-neutral-400">{layer.label}</div>
                      {layer.preview && <pre className="text-[10px] font-mono text-[var(--element-bg)] whitespace-pre-wrap break-all mt-0.5">{layer.preview}</pre>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CollapsibleSection>

        {/* 协议状态机（L* 学习结果可视化） */}
        <CollapsibleSection
          title="协议状态机"
          storageKey="fw_reverse_protocol"
          defaultOpen={false}
          accent="info"
          right={
            pGraph && pGraph.state_count > 0 ? (
              <span className="text-[10px] text-neutral-400">
                {pGraph.state_count} 状态 · {pGraph.transition_count} 转移
              </span>
            ) : (
              <span className="text-[10px] text-neutral-400">未学习</span>
            )
          }
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={pUrl}
                onChange={(e) => setPUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleProtocolGraph()}
                placeholder="目标 URL（必填；未学习的目标返回空图）"
                className="flex-1 px-2.5 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-[var(--element-bg)]"
              />
              <button
                onClick={handleProtocolGraph}
                disabled={pBusy}
                className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
              >
                {pBusy ? '加载中...' : '加载'}
              </button>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-neutral-400">
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full border border-sky-500" />起始</span>
              <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full border-2 border-emerald-500" />接受</span>
              <span className="flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--element-bg)]" />转移符号(hex)</span>
            </div>
            <div className="rounded-lg border border-black/10 dark:border-stone-700/50 bg-white/40 dark:bg-white/[0.02] p-2">
              {renderProtocolGraph(pGraph)}
            </div>
          </div>
        </CollapsibleSection>

        {/* 符号库查询 */}
        <CollapsibleSection
          title="符号库查询（跨会话复用资产）"
          storageKey="fw_reverse_symbols"
          defaultOpen={true}
          accent="info"
          right={<span className="text-[10px] text-neutral-400">内存 HashMap · @reset 仅清断点</span>}
        >
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={symUrl}
              onChange={(e) => setSymUrl(e.target.value)}
              placeholder="目标 URL（留空查询全部）"
              className="flex-1 px-2.5 py-1.5 rounded-lg text-xs bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-[var(--element-bg)]"
            />
            <button
              onClick={handleSymbolsQuery}
              disabled={symBusy}
              className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
            >
              {symBusy ? '查询中...' : '查询'}
            </button>
          </div>
          {symError && (
            <div className="text-xs text-rose-600 dark:text-rose-400 bg-rose-500/10 rounded-lg px-2.5 py-1.5">
              {symError}
            </div>
          )}
          {symbols.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-neutral-400 border-b border-black/5 dark:border-stone-700/50">
                    <th className="py-1.5 pr-3">URL</th>
                    <th className="py-1.5 pr-3">符号名</th>
                    <th className="py-1.5 pr-3">地址</th>
                    <th className="py-1.5 pr-3">类型</th>
                    <th className="py-1.5">元信息</th>
                  </tr>
                </thead>
                <tbody>
                  {symbols.map((s, i) => (
                    <tr key={i} className="border-b border-black/[0.03] dark:border-stone-700/30 align-top">
                      <td className="py-1.5 pr-3 font-mono text-neutral-500 dark:text-stone-400 max-w-[160px] truncate" title={s.url}>{s.url || '—'}</td>
                      <td className="py-1.5 pr-3 font-mono text-[var(--element-bg)]">{s.name}</td>
                      <td className="py-1.5 pr-3 font-mono text-neutral-500 dark:text-stone-400">0x{s.address.toString(16).padStart(8, '0')}</td>
                      <td className="py-1.5 pr-3">
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-violet-500/15 text-violet-600 dark:text-violet-400">{s.kind}</span>
                      </td>
                      <td className="py-1.5 text-neutral-500 dark:text-stone-400 max-w-[200px]">
                        {Object.keys(s.meta).length === 0
                          ? '—'
                          : Object.entries(s.meta).map(([k, v]) => (
                              <span key={k} className="inline-block mr-2 font-mono text-[10px]">
                                <span className="text-neutral-400">{k}=</span>
                                <span className="text-[var(--element-bg)]">{v}</span>
                              </span>
                            ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {symbols.length === 0 && !symBusy && !symError && symUrl !== '' && (
            <p className="text-[11px] text-neutral-400">该 URL 暂无已学习符号。逆向过程中识别到的函数/S盒/协议字段会自动入库。</p>
          )}
        </CollapsibleSection>

        {/* P2：二进制静态分析（内置轨：本地文件真实反汇编，替代「伪反汇编」的编排需求） */}
        <CollapsibleSection
          title="二进制静态分析（内置轨）"
          storageKey="fw_reverse_binanalyze"
          defaultOpen={false}
          accent="info"
          right={
            <>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">真实反汇编</span>
              <span className="text-[10px] text-neutral-400">object + iced-x86 · 纯 Rust/MIT</span>
            </>
          }
        >
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={binPath}
                onChange={(e) => setBinPath(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleBinaryAnalyze()}
                placeholder="本地二进制路径（PE/ELF/Mach-O，仅 x86/x64 反汇编）"
                className="flex-1 px-2.5 py-1.5 rounded-lg text-xs font-mono bg-white dark:bg-stone-800 border border-black/10 dark:border-stone-700/50 text-[var(--element-bg)] placeholder:text-neutral-400 focus:outline-none focus:ring-1 focus:ring-[var(--element-bg)]"
              />
              <button
                onClick={handlePickBinary}
                className="btn-press px-3 py-1.5 rounded-lg text-xs text-neutral-600 dark:text-stone-300 border border-black/10 dark:border-stone-700/50 hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0"
              >
                选择文件
              </button>
              <button
                onClick={handleBinaryAnalyze}
                disabled={binBusy}
                className="btn-press px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-[var(--element-bg)] hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity shrink-0"
              >
                {binBusy ? '分析中...' : '分析'}
              </button>
            </div>

            {binError && (
              <div className="px-3 py-2 rounded-lg bg-rose-500/10 border border-rose-500/30 text-xs text-rose-600 dark:text-rose-400 break-all">
                {binError}
              </div>
            )}

            {binResult && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  <StatusCard label="格式 / 架构" value={`${binResult.format} · ${binResult.arch}`} />
                  <StatusCard label="入口" value={`0x${binResult.entry.toString(16)}`} valueCls="font-mono text-[12px]" />
                  <StatusCard label="指令数" value={binResult.instruction_count} />
                  <StatusCard label="基本块 / CFG 边" value={`${binResult.block_count} / ${binResult.edge_count}`} />
                  <StatusCard label="函数（符号+调用目标）" value={binResult.functions.length} />
                  <StatusCard label="常量池字符串" value={binResult.strings.length} />
                  <StatusCard label="导入 / 导出" value={`${binResult.imports.length} / ${binResult.exports.length}`} />
                  <StatusCard
                    label="反混淆后真实块"
                    value={binResult.deobfuscation ? binResult.deobfuscation.real_block_count : '—'}
                    valueCls="font-mono text-[12px]"
                  />
                </div>

                {/* WASM 专属结构块（仅当输入是 WebAssembly） */}
                {binResult.wasm && (
                  <div className="rounded-lg border border-black/5 dark:border-stone-700/50 bg-white/40 dark:bg-white/[0.02] p-2 space-y-2">
                    <div className="text-[10px] text-neutral-400">WebAssembly 结构（wasmparser · 不做 DFG 还原、不执行模块）</div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <StatusCard label="类型 / 函数" value={`${binResult.wasm.type_count} / ${binResult.wasm.function_count}`} />
                      <StatusCard label="指令 / 调用" value={`${binResult.wasm.total_instrs} / ${binResult.wasm.total_calls}`} />
                      <StatusCard label="内存 / 表 / 全局" value={`${binResult.wasm.memories} / ${binResult.wasm.tables} / ${binResult.wasm.globals}`} />
                      <StatusCard label="代码段 / 数据段" value={`${Math.round(binResult.wasm.code_bytes / 1024)}KB / ${binResult.wasm.data_segments} 段`} />
                    </div>
                    <div>
                      <div className="text-[10px] text-neutral-400 mb-1">函数（按指令数取前 10）</div>
                      <div className="space-y-0.5 max-h-44 overflow-y-auto">
                        {[...binResult.wasm.functions]
                          .sort((a, b) => b.instrs - a.instrs)
                          .slice(0, 10)
                          .map((f) => (
                            <div key={f.index} className="flex items-center gap-2 text-[11px] font-mono">
                              <span className="text-neutral-400 shrink-0 w-24">func[{f.index}]</span>
                              <span className="text-neutral-600 dark:text-stone-300 flex-1">{f.instrs} 指令 · {f.blocks} 控制块 · {f.calls} 调用 · {f.locals} 局部</span>
                              <span className="text-neutral-400 tabular-nums">{f.size}B</span>
                            </div>
                          ))}
                      </div>
                    </div>
                    {binResult.wasm.custom_sections.length > 0 && (
                      <div className="text-[10px] text-neutral-400 break-all">
                        自定义节：{binResult.wasm.custom_sections.join(' / ')}
                      </div>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {!binResult.wasm && (
                    <div className="rounded-lg border border-black/5 dark:border-stone-700/50 bg-white/40 dark:bg-white/[0.02] p-2">
                      <div className="text-[10px] text-neutral-400 mb-1">段（前 8）</div>
                      <div className="space-y-0.5 max-h-40 overflow-y-auto">
                        {binResult.sections.slice(0, 8).map((s) => (
                          <div key={s.name} className="flex items-center gap-2 text-[11px] font-mono">
                            <span className={`w-1 h-1 rounded-full shrink-0 ${s.executable ? 'bg-emerald-500' : s.data ? 'bg-sky-500' : 'bg-neutral-300'}`} />
                            <span className="text-neutral-600 dark:text-stone-300 truncate flex-1">{s.name}</span>
                            <span className="text-neutral-400 tabular-nums">{s.size}B</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className={`rounded-lg border border-black/5 dark:border-stone-700/50 bg-white/40 dark:bg-white/[0.02] p-2 ${binResult.wasm ? 'sm:col-span-2' : ''}`}>
                    <div className="text-[10px] text-neutral-400 mb-1">
                      {binResult.wasm ? `导入 / 导出（${binResult.wasm.imports.length} / ${binResult.wasm.exports.length}）前 12` : '函数（前 12，按地址）'}
                    </div>
                    <div className="space-y-0.5 max-h-40 overflow-y-auto">
                      {(binResult.wasm
                        ? [...binResult.wasm.imports.map((n) => `import ${n}`), ...binResult.wasm.exports.map((n) => `export ${n}`)]
                        : binResult.functions.map((f) => `0x${f.address.toString(16)} ${f.name}`)
                      ).slice(0, 12).map((line, i) => (
                        <div key={`${i}-${line.slice(0, 16)}`} className="text-[11px] font-mono text-neutral-600 dark:text-stone-300 truncate" title={line}>{line}</div>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="rounded-lg border border-black/5 dark:border-stone-700/50 bg-white/40 dark:bg-white/[0.02] p-2">
                  <div className="text-[10px] text-neutral-400 mb-1">常量池（前 20，按长度降序）</div>
                  <div className="space-y-0.5 max-h-52 overflow-y-auto">
                    {binResult.strings.slice(0, 20).map((s, i) => (
                      <div key={`${i}-${s.slice(0, 24)}`} className="text-[11px] font-mono text-neutral-600 dark:text-stone-300 break-all">{s}</div>
                    ))}
                  </div>
                </div>

                {binResult.warnings.length > 0 && (
                  <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-700 dark:text-amber-400 space-y-0.5">
                    {binResult.warnings.map((w, i) => (
                      <div key={i}>· {w}</div>
                    ))}
                  </div>
                )}
                <p className="text-[10px] text-neutral-400 leading-relaxed">
                  engine={binResult.engine} · 线性扫描 + 领导者切块，不做函数边界精确重建；ARM 等非 x86 架构仅出段/符号/常量池。
                  Ghidra 深度轨（P-Code IR / 跨指令集）尚未接入。
                </p>
              </div>
            )}
          </div>
        </CollapsibleSection>

        {/* P2：符号表（IDA/Ghidra 风格符号列表 + 真实符号元信息；伪反汇编已移除） */}
        <DisassemblyView symbols={symbols} />
      </div>
    </div>
  );
}


export { ReversePanel };
