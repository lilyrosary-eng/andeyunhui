/// <reference path="../../../global.d.ts" />
import React from "react";
// 攻防模块 · 四大框架面板
// 爬虫框架：内核已就绪，接入实际 Tauri 命令（启动/停止/状态/指令注入）。
// 逆向导：符号库/协议图/二进制静态分析（内置轨，含 WASM）已接入 Tauri 命令；
// 动态插桩（Frida 等）已明确不做（LGPL 系原生库与本项目许可偏好冲突），不再列为待办。
// 注意：这里不再 `const { useState } = React`——本文件只用 React 的类型标注，
// hooks 由各面板文件自行从 React 解构（见 frameworks.*.tsx 头部）。
// 也不再 import frameworkExtras / professionalExtras：这两个模块只在本文件底部转出，
// 正文无本地消费方。而 `AuditInput`（audit 的类型）与 `CollapsibleSection`（ui）
// 在下面的 FrameworkPlaceholder 里是真的本地消费方，import 必须保留。
import type { AuditInput } from './audit';
import { CollapsibleSection } from './ui';

// ============ Tauri invoke 封装 ============
// 统一走沙箱 hostApi.invoke（已加入 pluginSandbox 白名单），不直连 __TAURI_INTERNALS__
const hostApi = window.__HOST_API__ as {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
};
const tauriInvoke = <T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  hostApi.invoke(cmd, args) as Promise<T>;

// ============ 攻防状态类型（与 Rust 端 GongfangStatus 对齐） ============
interface Strategy {
  phase: 'Idle' | 'Recon' | 'Exploit' | 'Pivot' | 'Clean';
  qps: number;
  per_ip_concurrency: number;
  tls_profile: string;
  stealth_level: number;
  focus_url: string | null;
  use_browser: boolean;
  proxy_pool_tag: string;
  generation: number;
}

interface GongfangStatus {
  running: boolean;
  strategy: Strategy;
  reward: number;
  error_rate: number;
  features: { crawler: boolean; reverse: boolean; pentest: boolean; automation: boolean; gateway: boolean; tls_impersonate: boolean };
}

// ============ 爬虫实际爬取结果类型（与 Rust 端 FetchResult 对齐） ============
interface FetchResult {
  url: string;
  status: number;
  content_type: string;
  content_length: number;
  title: string | null;
  body_preview: string;
  links: string[];
  duration_ms: number;
  error: string | null;
}

// ============ 渗透框架结果类型（与 Rust 端 commands.rs 字段对齐） ============
interface ScanPort {
  host: string;
  ip: string;
  port: number;
  protocol: string;
  service: string | null;
  tls: boolean | null;
}

interface ScanResult {
  host: string;
  open_ports: ScanPort[];
  duration_ms: number;
  error: string | null;
  naabu_path: string | null;
}

interface WafDetectResult {
  url: string;
  waf_name: string | null;
  engine: string;
  entropy: number;
  status_code: number;
  signals: string[];
}

// ============ 技术栈指纹结果类型（与 Rust 端 fingerprint.rs TechFingerprint 对齐） ============
interface TechFingerprint {
  servers: string[];
  languages: string[];
  frameworks: string[];
  cdns: string[];
  cookies: string[];
  security_headers_present: string[];
  security_headers_missing: string[];
}

// ============ HTTP 方法枚举 / 常见路径探测（与 Rust 端 recon.rs 对齐） ============
interface MethodReport {
  allowed: string[];
  risky: string[];
}
interface PathProbeItem {
  path: string;
  status: number;
  note: string;
}
interface ErrorPageReport {
  probe_path: string;
  status: number;
  fingerprints: string[];
}
interface MutationResult {
  name: string;
  payload: string;
  keyword_blocked: boolean;
  bypassed_rules: string[];
}
interface HppReport {
  probe: string;
  aggregate: string;
  description: string;
  payload: string;
}
interface DbPayloadReport {
  input: string;
  database: string;
  confidence: string;
  payloads: string[];
}

// ============ 逆向框架结果类型 ============
interface CryptoReport {
  data_len: number;
  block_size: number | null;
  chi_square: number;
  is_uniform: boolean;
  entropy: number;
  matched_algorithm: string | null;
  confidence: number | null;
}

// ============ 编码/哈希识别结果类型（与 Rust 端 detect.rs EncodeAnalysis 对齐） ============
interface EncodeAnalysis {
  kind: string;
  label: string;
  decoded: number[] | null;
  is_text: boolean;
  entropy: number;
  hash_algo: string | null;
  stream_hint: string | null;
  preview: string | null;
}

// ============ 协议状态机可视化类型（与 Rust 端 protocol.rs DfaGraph 对齐） ============
interface DfaNode {
  id: number;
  initial: boolean;
  accept: boolean;
}
interface DfaEdge {
  from: number;
  to: number;
  label: string;
}
interface DfaGraph {
  nodes: DfaNode[];
  edges: DfaEdge[];
  state_count: number;
  transition_count: number;
}

// 二进制静态分析结果（与 Rust 端 reverse::disasm::BinaryAnalysis 对齐）
interface BinSection { name: string; address: number; size: number; executable: boolean; data: boolean }
interface BinFunction { name: string; address: number; size: number; source: string }
interface BinDeobf { original_block_count: number; dispatcher_count: number; real_block_count: number; real_edge_count: number }
// WASM 模块结构（与 Rust 端 reverse::wasm::WasmSummary 对齐）
interface WasmFunction { index: number; locals: number; instrs: number; blocks: number; calls: number; size: number }
interface WasmSummary {
  version: number;
  type_count: number;
  imports: string[];
  exports: string[];
  memories: number;
  tables: number;
  globals: number;
  function_count: number;
  functions: WasmFunction[];
  total_instrs: number;
  total_calls: number;
  code_bytes: number;
  data_segments: number;
  data_bytes: number;
  strings: string[];
  custom_sections: string[];
  warnings: string[];
}
interface BinaryAnalysis {
  file: string;
  format: string;
  arch: string;
  entry: number;
  is_64bit: boolean;
  sections: BinSection[];
  functions: BinFunction[];
  block_count: number;
  edge_count: number;
  instruction_count: number;
  strings: string[];
  imports: string[];
  exports: string[];
  deobfuscation: BinDeobf | null;
  wasm: WasmSummary | null;
  engine: string;
  warnings: string[];
}

// OpenAPI / Swagger 参数边界推演（与 Rust 端 pentest::openapi 对齐）
interface ApiBoundary { value: string; kind: string; why: string }
interface ApiParam { name: string; location: string; required: boolean; schema_type: string; enum_values: string[]; candidates: ApiBoundary[] }
interface ApiEndpoint { method: string; path: string; operation_id: string | null; body_schema: string | null; params: ApiParam[] }
interface ApiReport {
  spec_version: string;
  title: string | null;
  servers: string[];
  endpoint_count: number;
  endpoints: ApiEndpoint[];
  schema_count: number;
  security_schemes: string[];
  warnings: string[];
}

// 自适应变异（UCB1 多臂老虎机，与 Rust 端 pentest::mutation 对齐）
interface MutationArm { arm: number; name: string; plays: number; mean_reward: number; ucb: number | null }
interface MutationSelection {
  ctx: string;
  arm: number;
  arm_name: string;
  payload: string;
  exploring: boolean;
  total_plays: number;
  arms: MutationArm[];
}

interface SymbolSummary {
  url: string;
  name: string;
  address: number;
  kind: string;
  meta: Record<string, string>;
}

// ============ 自动化框架结果类型 ============
interface FitnessReport {
  id: number;
  name: string;
  success: number;
  failure: number;
  success_rate: number;
  avg_divergence: number;
}

// ============ 自动化行为实验室 ============
interface AutionTemplate {
  id: number; name: string; speed_factor: number; overshoot: number;
  noise_amplitude: number; tremor_frequency: number; poll_interval_ms: number; weight: number;
}
interface AutionTemplatesReport {
  templates: AutionTemplate[];
  fitness: { id: number; name: string; success: number; failure: number; success_rate: number; avg_divergence: number }[];
  current: string;
}
interface AutionTrajectoryReport {
  template: string; template_id: number; point_count: number; raw_point_count: number;
  duration_ms: number; overshoot: number; noise_amplitude: number; tremor_frequency: number;
  start: number[]; target: number[];
  sample: { x: number; y: number; t_ms: number }[];
}
interface AutionDivergenceReport {
  template: string; multidim: number; single: number; verdict: string;
}
interface AutionProbeReport {
  min: number; max: number; initial_step: number;
  steps: { ok: boolean; amplitude_before: number; amplitude_after: number }[];
  rollbacks: number; final_amplitude: number; note: string;
}

// ============ 网关框架结果类型（与 Rust 端 commands.rs 字段对齐） ============
interface GatewayNodeSummary {
  url: string;
  region: string;
  reputation: number;          // 信誉评分 [0, 100]
  error_rate: number;          // 错误率 [0, 1]
  ewma_rtt: number;            // EWMA RTT（毫秒）
  rtt_gradient: number;        // RTT 梯度（毫秒/样本）
  is_failing: boolean;         // 是否即将故障
}

interface GatewayStatusResult {
  policy_version: number;
  routing: string;             // direct / proxy / stealth
  routing_cn: string;          // 直连 / 代理 / 隐身
  bandwidth_ratio: number;     // [0.05, 1.0]
  request_timeout_ms: number;
  max_concurrent: number;
  effective_ts: number;        // Unix 毫秒
  node_count: number;
  redundancy_ratio: number;    // N+1 冗余比例
  current_entropy: number;     // 请求熵
  active_node: GatewayNodeSummary | null;
}

// ============ 节点信誉评分（与 Rust 端 gateway/pool.rs ReputationBreakdown 对齐） ============
interface ReputationBreakdown {
  reputation: number;
  error_penalty: number;
  rtt_penalty: number;
  gradient_penalty: number;
  is_failing: boolean;
}

// ============ 网关仿真（与 Rust 端三个 gongfang_gateway_*_sim 命令对齐） ============
interface TrafficReport {
  lambda_req_per_sec: number;
  expected_interval_ms: number | null;
  count: number;
  avg_ms: number;
  min_ms: number;
  max_ms: number;
  intervals_ms: number[];
}
interface RouteNode {
  url: string;
  region: string;
  reputation: number;
  error_penalty: number;
  rtt_penalty: number;
  gradient_penalty: number;
  is_failing: boolean;
}
interface RouteSimReport {
  nodes: RouteNode[];
  selected: string | null;
  active: number;
  standby: number;
  redundancy_ratio: number;
}
interface StrategySimReport {
  routing: string;
  routing_cn: string;
  ratio: number;
  request_timeout_ms: number;
  max_concurrent: number;
  high_priority_bypass: boolean;
  est_interval_silent_ms: number;
  est_interval_burst_ms: number;
}

// ============ 隐身整形实验室（gateway 三个 demo 命令） ============
interface OsFp { os: string; user_agent: string; accept_language: string; accept: string; browser: string; }
interface ShapingAdvice {
  interval_ms: number;
  in_burst: boolean;
  fingerprint: OsFp;
  header_order: string[];
  needs_noise: boolean;
  noise_path: string | null;
  current_entropy: number;
}
interface ObfuscateReport { original: string; obfuscated: string; }
interface EntropyReport {
  threshold: number;
  entropy: number;
  needs_noise: boolean;
  count: number;
  noise_path: string | null;
  verdict: string;
}
interface CurlReport {
  command: string;
  interval_ms: number;
  in_burst: boolean;
  fingerprint: string;
  header_order: string[];
  mode: string;
  note: string;
}

type InjectType = 'Focus' | 'Bypass' | 'Pause' | 'Resume';

interface FrameworkMeta {
  title: string;
  subtitle: string;
  posture: '攻' | '防' | '攻防';   // 攻防定位
  /** **已交付**能力：有后端实现，且能通过命令/面板实际使用 */
  capabilities: string[];
  /** 计划中：尚无后端实现，或已实现但未接入生产路径（如实标注，不混进上面一栏） */
  capabilitiesPlanned: string[];
  /** 技术选型（优先 MIT/Apache）；`integrated: false` = 仅登记，尚未接入 */
  techStack: { name: string; license: string; integrated?: boolean }[];
  status: string;                  // 当前状态
}

// ============ 能力清单（已交付 / 计划中 两栏） ============
// 单一实现：五个框架面板统一用，避免各写一份导致口径不一（曾在 UI 上把规划当能力展示）
function CapabilityGrid({ meta }: { meta: FrameworkMeta }) {
  return (
    <div className="space-y-3">
      <div>
        <div className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400 mb-1.5">
          已交付（{meta.capabilities.length}）
        </div>
        <div className="grid grid-cols-2 gap-2">
          {meta.capabilities.map((cap) => (
            <div key={cap} className="flex items-start gap-2 text-[13px] text-neutral-600 dark:text-stone-300">
              <span className="inline-block w-1 h-1 mt-1.5 rounded-full bg-emerald-500 shrink-0" />
              <span>{cap}</span>
            </div>
          ))}
        </div>
      </div>
      {meta.capabilitiesPlanned.length > 0 && (
        <div>
          <div className="text-[11px] font-medium text-neutral-400 mb-1.5">
            计划中（尚无后端实现，{meta.capabilitiesPlanned.length}）
          </div>
          <div className="grid grid-cols-2 gap-2">
            {meta.capabilitiesPlanned.map((cap) => (
              <div key={cap} className="flex items-start gap-2 text-[13px] text-neutral-400 dark:text-stone-500">
                <span className="inline-block w-1 h-1 mt-1.5 rounded-full bg-neutral-300 dark:bg-stone-600 shrink-0" />
                <span>{cap}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============ 技术选型 chips（未接入的置灰 + 标注） ============
function TechStackChips({ items }: { items: FrameworkMeta['techStack'] }) {
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((t) => (
        <span
          key={t.name}
          className={
            t.integrated === false
              ? 'px-2.5 py-1 rounded-lg text-xs text-neutral-400 dark:text-stone-500 border border-dashed border-black/10 dark:border-stone-700/60'
              : 'px-2.5 py-1 rounded-lg text-xs bg-black/[0.04] dark:bg-white/[0.05] text-neutral-600 dark:text-stone-300 border border-black/5 dark:border-stone-700/50'
          }
        >
          {t.name}
          <span className="ml-1.5 text-[10px] text-neutral-400">
            {t.license}{t.integrated === false ? ' · 未接入' : ''}
          </span>
        </span>
      ))}
    </div>
  );
}

// ============ 通用框架占位模板 ============
function FrameworkPlaceholder({ meta, addLog }: { meta: FrameworkMeta; addLog: (i: AuditInput) => void }) {
  const postureCls = meta.posture === '攻'
    ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
    : meta.posture === '防'
    ? 'bg-sky-500/15 text-sky-600 dark:text-sky-400'
    : 'bg-violet-500/15 text-violet-600 dark:text-violet-400';

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-5">
        {/* 框架标题 */}
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-semibold text-[var(--element-bg)]">{meta.title}</h2>
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${postureCls}`}>{meta.posture}</span>
          <span className="px-2 py-0.5 rounded text-[11px] bg-amber-500/15 text-amber-600 dark:text-amber-400">{meta.status}</span>
        </div>
        <p className="text-sm text-neutral-500 dark:text-stone-400 leading-relaxed">{meta.subtitle}</p>

        {/* 核心能力（已交付 / 计划中 分栏） */}
        <CollapsibleSection title="核心能力" storageKey="fw_placeholder_capabilities" defaultOpen={false}>
          <CapabilityGrid meta={meta} />
        </CollapsibleSection>

        {/* 技术选型 */}
        <CollapsibleSection title="技术选型（优先 MIT/Apache 协议）" storageKey="fw_placeholder_techstack" defaultOpen={false}>
          <TechStackChips items={meta.techStack} />
        </CollapsibleSection>

        {/* 操作占位区 */}
        <section className="bg-white/60 dark:bg-white/[0.03] rounded-xl border border-dashed border-black/10 dark:border-stone-700/60 p-6">
          <div className="flex flex-col items-center justify-center text-center gap-2">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-neutral-400">
              <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
            </svg>
            <p className="text-sm text-neutral-500 dark:text-stone-400">功能开发中</p>
            <p className="text-xs text-neutral-400 max-w-md">
              当前为骨架占位阶段。后续将按 {meta.title} 的技术路线逐步接入能力，
              所有操作将记录至审计日志。
            </p>
            <button
              onClick={() => addLog({ action: '试探性操作', target: meta.title, status: 'warn', detail: '骨架阶段，功能未实现' })}
              className="btn-press mt-2 px-3 py-1.5 rounded-lg text-xs text-neutral-500 dark:text-stone-400 border border-black/10 dark:border-stone-700/50 hover:bg-black/5 dark:hover:bg-white/5"
            >
              记录测试日志
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

// ============ 标签 chips 助手（技术栈指纹等用） ============
function renderChips(label: string, items: string[]): React.ReactNode {
  if (items.length === 0) return null;
  return (
    <div className="flex items-start gap-1.5">
      <span className="shrink-0 text-[10px] text-neutral-400 w-14 leading-5">{label}</span>
      <div className="flex flex-wrap gap-1">
        {items.map((s) => (
          <span key={s} className="px-1.5 py-0.5 rounded text-[10px] bg-sky-500/15 text-sky-600 dark:text-sky-400">{s}</span>
        ))}
      </div>
    </div>
  );
}

// ============ 框架一：网络爬虫 ============
const crawlerMeta: FrameworkMeta = {
  title: '网络爬虫框架',
  subtitle: '反检测、反封锁、智能调度。真实 HTTP 抓取 + 代理选路 + 真实 TLS/JA3-JA4 指纹（curl-impersonate 外部通道，实测 HTTP/2 + Akamai 指纹与真实 Chrome 一致），并对接 API 网关整形；二进制缺失时如实降级为 UA 档案并在上方状态卡标注。',
  posture: '攻防',
  capabilities: [
    '真实 HTTP 抓取：同域递归队列（去重 / 深度限制）+ 失败换代理重试',
    'QPS 限速 + 响应态势回调（403/429 触发降速与指纹轮换）',
    '代理池：轮换选路 + 代理故障分类',
    '真实 TLS/JA3-JA4 指纹（curl-impersonate：HTTP/2 + GREASE，Chrome/Firefox/Safari 三档案）',
    '统一 GET 通道：手动抓取 / WAF 探测与爬虫同一条链路、同一指纹',
    'API 网关整形下沉：Poisson 突发-静默间隔 + 请求头序随机化 + 会话熵监控（熵低只告警，不自动注入假请求）',
    '浏览器同构请求头（UA / Accept / Language / Client Hints 自洽，rustls 通道用）',
    'CDP 隐身脚本（webdriver 清除 + Canvas/WebGL 噪声，需 crawler-browser）',
  ],
  capabilitiesPlanned: [],
  techStack: [
    { name: 'curl-impersonate', license: 'MIT' },
    { name: 'reqwest', license: 'MIT' },
    { name: 'rustls', license: 'Apache-2.0' },
    { name: 'tokio', license: 'MIT' },
    { name: 'chromiumoxide', license: 'MPL-2.0' },
  ],
  status: '全链路已交付',
};

// ============ 状态卡片（模块级组件，避免渲染内重定义导致重挂载） ============
function StatusCard({ label, value, valueCls }: { label: string; value: React.ReactNode; valueCls?: string }) {
  return (
    <div className="bg-black/[0.03] dark:bg-white/[0.03] rounded-lg p-2.5 border border-black/5 dark:border-stone-700/50">
      <div className="text-[10px] text-neutral-400 mb-0.5">{label}</div>
      <div className={`text-sm font-medium text-[var(--element-bg)] ${valueCls ?? ''}`}>{value}</div>
    </div>
  );
}


// ---- 以下四项是原文件顶部的 import，改为从本模块转出，供各面板按需取用 ----
export type { AuditInput } from './audit';
export {
  CrawlerUrlQueue,
  CrawlerProxyPool,
  PentestAssetTree,
  GatewayStrategyHistory,
  AutomationTaskList,
} from './frameworkExtras';
export { DisassemblyView, ScriptEditor } from './professionalExtras';
export { CollapsibleSection, useKernelRunning } from './ui';

export {
  hostApi,
  tauriInvoke,
  CapabilityGrid,
  TechStackChips,
  FrameworkPlaceholder,
  renderChips,
  crawlerMeta,
  StatusCard,
};

export type {
  Strategy,
  GongfangStatus,
  FetchResult,
  ScanPort,
  ScanResult,
  WafDetectResult,
  TechFingerprint,
  MethodReport,
  PathProbeItem,
  ErrorPageReport,
  MutationResult,
  HppReport,
  DbPayloadReport,
  CryptoReport,
  EncodeAnalysis,
  DfaNode,
  DfaEdge,
  DfaGraph,
  BinSection,
  BinFunction,
  BinDeobf,
  WasmFunction,
  WasmSummary,
  BinaryAnalysis,
  ApiBoundary,
  ApiParam,
  ApiEndpoint,
  ApiReport,
  MutationArm,
  MutationSelection,
  SymbolSummary,
  FitnessReport,
  AutionTemplate,
  AutionTemplatesReport,
  AutionTrajectoryReport,
  AutionDivergenceReport,
  AutionProbeReport,
  GatewayNodeSummary,
  GatewayStatusResult,
  ReputationBreakdown,
  TrafficReport,
  RouteNode,
  RouteSimReport,
  StrategySimReport,
  OsFp,
  ShapingAdvice,
  ObfuscateReport,
  EntropyReport,
  CurlReport,
  InjectType,
  FrameworkMeta,
};
