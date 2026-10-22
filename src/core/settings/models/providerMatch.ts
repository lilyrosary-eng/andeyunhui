/**
 * 供应商预设的匹配、推断与合并（纯函数，便于单测）。
 *
 * 三个用途：
 *  ① **去重**：base_url 相同的预设不再新建，而是复用已有预设做增量合并
 *     （用户诉求：「如果 api url 一模一样，则不再添加新预设」）。自动发现与手动
 *     添加都走这里，口径一致。
 *  ② **命名**：自动获取只拿得到 url/key，供应商名靠域名推断（用户诉求：
 *     「供应商名称不会自动获取，我们尝试支持一下」）。
 *  ③ **合并**：增量并入的「仅增不减」口径（见 mergeModels），以及**回填**
 *     （见 refillCapacity / refillCaps —— 光「只增不减」会让老条目的新信息进不来）。
 */
import type { CapsSourceUi } from '../aiConfigCodec';

/**
 * base_url 归一化，用于「是否同一个供应商」的比较。
 * 只做安全的收敛：去空白、去尾部斜杠、大小写归一。
 * **不做** `/v1` 剥离——`https://x/v1` 与 `https://x` 在某些网关上指向不同端点，
 * 擅自合并会让用户的两个预设被误判成一个。
 */
export function normalizeBaseUrl(u: string): string {
  return u.trim().replace(/\/+$/, '').toLowerCase();
}

/** 两个 base_url 是否指向同一供应商（归一化后全等）。 */
export function sameBaseUrl(a: string, b: string): boolean {
  const na = normalizeBaseUrl(a);
  const nb = normalizeBaseUrl(b);
  return na !== '' && na === nb;
}

/** 已知厂商的域名 → 展示名。顺序敏感：更具体的域名写在前面。 */
const KNOWN_HOSTS: { match: RegExp; name: string }[] = [
  { match: /deepseek\.com/i, name: 'DeepSeek' },
  { match: /openai\.com/i, name: 'OpenAI' },
  { match: /anthropic\.com|claude\.ai/i, name: 'Anthropic' },
  { match: /generativelanguage\.googleapis\.com|googleapis\.com|gemini/i, name: 'Google Gemini' },
  { match: /dashscope|aliyuncs\.com/i, name: '通义千问' },
  { match: /bigmodel\.cn|zhipu/i, name: '智谱 GLM' },
  { match: /moonshot/i, name: '月之暗面' },
  { match: /siliconflow/i, name: '硅基流动' },
  { match: /volces\.com|volcengine/i, name: '火山方舟' },
  { match: /baidubce\.com|qianfan/i, name: '百度千帆' },
  { match: /localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0/i, name: '本地' },
];

/** 从 URL 里取主机名；无 scheme 时补 `https://` 再解析，失败返回 ''。 */
function hostOf(u: string): string {
  const s = u.trim();
  if (!s) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  try {
    return new URL(withScheme).hostname;
  } catch {
    return '';
  }
}

/** 域名里无信息量的标签，推断名称时跳过。 */
const NOISE_LABELS = new Set([
  'api', 'www', 'com', 'cn', 'net', 'org', 'io', 'ai', 'co', 'v1', 'openai', 'chat',
]);

/**
 * 按域名推断供应商展示名。推断不出返回 ''（**不编造**：宁可让用户手填，
 * 也不要给一个莫名奇妙的默认名让他以为是识别出来的）。
 */
export function inferProviderName(baseUrl: string): string {
  const host = hostOf(baseUrl);
  if (!host) return '';
  for (const { match, name } of KNOWN_HOSTS) {
    if (match.test(host)) return name;
  }
  // 未知域名：取第一个有信息量的标签并首字母大写（api.foo-bar.com → Foo-bar）
  const label = host
    .toLowerCase()
    .split('.')
    .find((p) => p && !NOISE_LABELS.has(p));
  if (!label) return '';
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * 「本批新增」高亮的 key —— **必须带供应商命名空间**。
 *
 * 模型 id 目前**就是模型名**（见 DiscoverModelsDialog.adopt 的 `id: m.model`），全局并不唯一：
 * 两个供应商都提供 `gpt-4o` 时，只用模型名做 key 会让对方预设里的同名模型**一起亮起**。
 * 用不可见分隔符拼接，避免与模型名本身可能的字符冲突。
 */
export function newModelKey(providerId: string, modelId: string): string {
  return `${providerId}\u0000${modelId}`;
}

/** 合并所需的最小形状（ModelUi / AdoptedModel 都满足）。 */
export interface MergeableModel {
  model: string;
}

/**
 * 把一批新模型并入现有列表：**仅增不减**（用户诉求：「做增量（仅增不减）」）。
 *
 * - 已存在的模型名一律跳过——用户可能手调过容量/能力/人设，重扫不能覆盖它们；
 * - 空模型名的行也跳过——那是「还没填」的占位行，并进去只会污染对方的列表；
 * - 只返回新增项，供调用方做橙色高亮（「本批新增」）。
 *
 * 注意这里按**模型名**判重，不按 id：同一模型在不同批次里的 id 可能不同，
 * 但 model 名是端点的真实标识。
 */
export function mergeModels<T extends MergeableModel>(current: T[], incoming: T[]): { models: T[]; added: T[] } {
  const existing = new Set(current.map((m) => m.model));
  const added = incoming.filter((m) => m.model.trim() !== '' && !existing.has(m.model));
  return { models: [...current, ...added], added };
}

/** 回填所需的最小形状（ModelUi 满足）。 */
export interface CapacityFields {
  model: string;
  context_tokens: string;
  context_source: string;
  max_output_tokens: string;
  max_output_source: string;
}

/**
 * 该容量字段能否被新数据覆盖（与 Rust `CapacitySource::refreshable` 同口径）。
 *
 * - 空值 → 可填（用户没填过，也没什么可丢的）
 * - `provider` / `table` → 可刷新（推断值本就该跟着数据源更新）
 * - `manual` → 冻结
 * - **有值但来源未知**（改造前的老数据）→ 冻结：无法区分是用户手填还是旧推断，
 *   保守起见不动。这是「宁可少更新，也不冲掉用户填的值」。
 */
export function capacityRefreshable(value: string, source: string): boolean {
  if (!value.trim()) return true;
  return CAPACITY_REFRESHABLE_SOURCES.includes(source);
}

/** 与 Rust `CapacitySource::refreshable` 的集合一致：手填冻结，其余可刷新。 */
const CAPACITY_REFRESHABLE_SOURCES = ['provider', 'loaded', 'learned', 'table'];

/**
 * 容量来源的可信度（与 Rust `CapacitySource::priority` 完全同序）。
 *
 * `loaded`（服务端当前已加载窗口）排最前，因为它直接决定"这次请求会不会被拒"；
 * `table` 是猜的，不能盖掉任何自报值 —— 否则本地端点没启动时重扫一次，
 * 就把"已加载 8192"降级成"表猜 65536"，压缩阈值跟着虚高。
 */
const CAPACITY_PRIORITY: Record<string, number> = {
  manual: 5,
  loaded: 4,
  provider: 3,
  learned: 2,
  table: 1,
};

/** 新来源是否不比旧来源差（相等也算，便于"同源刷新"）。 */
export function capacityOutranks(incomingSource: string, currentSource: string): boolean {
  const inc = CAPACITY_PRIORITY[incomingSource] ?? 0;
  const cur = CAPACITY_PRIORITY[currentSource] ?? 0;
  return inc >= cur;
}

/**
 * 用本次发现到的容量**回填**已有条目（不增删模型，只更新容量两列）。
 *
 * 为什么需要：`mergeModels` 的「同名保留原对象」保护了用户手调的值，但也把
 * 「以前没有、现在能推断出来」的值永久挡在门外——重扫时同名直接跳过，
 * `context_tokens` 永远保持 null。实测 59 个模型里只认出 4 个上下文，一大半是这个原因。
 *
 * 现在按**逐字段**的来源判断：可刷新的刷新，手填的冻结。
 */
export function refillCapacity<T extends CapacityFields>(current: T[], incoming: T[]): T[] {
  const byName = new Map(incoming.map((m) => [m.model, m]));
  return current.map((m) => {
    const src = byName.get(m.model);
    if (!src) return m;
    const next = { ...m };
    let changed = false;
    // 两道闸门，缺一不可：
    // ① 新值必须有值 —— 端点这次没报（离线/没加载）不该把已知值清空；
    // ② 新来源不能更弱 —— `table`（猜的）不许盖掉 `loaded`/`provider`/`learned`。
    if (
      src.context_tokens.trim() &&
      capacityRefreshable(m.context_tokens, m.context_source) &&
      capacityOutranks(src.context_source, m.context_source)
    ) {
      if (next.context_tokens !== src.context_tokens || next.context_source !== src.context_source) changed = true;
      next.context_tokens = src.context_tokens;
      next.context_source = src.context_source;
    }
    if (
      src.max_output_tokens.trim() &&
      capacityRefreshable(m.max_output_tokens, m.max_output_source) &&
      capacityOutranks(src.max_output_source, m.max_output_source)
    ) {
      if (next.max_output_tokens !== src.max_output_tokens || next.max_output_source !== src.max_output_source) changed = true;
      next.max_output_tokens = src.max_output_tokens;
      next.max_output_source = src.max_output_source;
    }
    return changed ? next : m;
  });
}

/** 能力回填所需的最小形状（ModelUi / AdoptedModel 都满足）。 */
export interface CapsFields {
  model: string;
  caps: {
    vision: boolean;
    vision_source: CapsSourceUi | '';
    tools: boolean;
    tools_source: CapsSourceUi | '';
    embedding: boolean;
    embedding_source: CapsSourceUi | '';
  };
}

/**
 * 该能力位能否被本次发现的新值覆盖（与容量那套**故意不同**，见下）。
 *
 * - 旧值是 `manual` → 冻结（用户显式勾/取消过，以用户为准）
 * - 新值是 `provider`（供应商权威上报 / 实测探测）→ 可覆盖一切非 manual
 * - 新值是 `inferred`（名字启发式）→ 只覆盖 `inferred` 与 `''`
 *
 * **为什么 `''`（老数据）可以被 inferred 覆盖，而容量的老数据不行**：
 * 改造前能力位**只用于 UI 展示**（`caps_infer.rs` 自述「本推断只用于 UI 展示」），
 * 用户没有修正它的动机；而容量的老值可能是用户手填的重要数字（功能性的，不能冲）。
 * 两者错误的后果不对称：能力标错只是标签不对，容量填错会影响请求参数。
 */
export function capsRefreshable(oldSource: CapsSourceUi | '', newSource: CapsSourceUi | ''): boolean {
  if (oldSource === 'manual') return false;
  if (newSource === 'provider') return true;
  if (newSource === 'inferred') return oldSource === 'inferred' || oldSource === '';
  return false;
}

/**
 * 用本次发现到的能力**回填**已有条目（不增删模型，只更新视觉能力位）。
 *
 * 与 `refillCapacity` 同源的问题：`mergeModels` 的「同名保留原对象」把
 * 「以前判不出、现在能判出」的能力一并永久挡在门外。实测（用户真实配置 184 个模型）：
 * `GLM-4V-Flash` 名字里明确带 `4V`，却因为该条目是改造前落盘的老数据而一直是
 * `vision=false` —— 重扫多少遍都不会被重新推断。
 *
 * 只回填 `vision` 这一位：其余能力位（text/reasoning/tools/embedding）不参与路由决策，
 * 没有来源标记，也没有「探测」这种更强的证据来源。
 */
export function refillCaps<T extends CapsFields>(current: T[], incoming: T[]): T[] {
  const byName = new Map(incoming.map((m) => [m.model, m]));
  return current.map((m) => {
    const src = byName.get(m.model);
    if (!src) return m;
    const nextCaps = { ...m.caps };
    let changed = false;
    // 三份能力位各自按"来源能否被覆盖"判定，互不影响：
    // 视觉手填冻结、工具推断可刷新，这种组合必须能成立（否则一处手改会冻掉全部）。
    const pairs: Array<['vision' | 'tools' | 'embedding', 'vision_source' | 'tools_source' | 'embedding_source']> = [
      ['vision', 'vision_source'],
      ['tools', 'tools_source'],
      ['embedding', 'embedding_source'],
    ];
    for (const [cap, srcKey] of pairs) {
      if (!capsRefreshable(m.caps[srcKey], src.caps[srcKey])) continue;
      // 新数据没有来源标注（老数据/端点没报）= 没信息，不动
      if (!src.caps[srcKey]) continue;
      if (nextCaps[cap] === src.caps[cap] && nextCaps[srcKey] === src.caps[srcKey]) continue;
      nextCaps[cap] = src.caps[cap];
      nextCaps[srcKey] = src.caps[srcKey];
      changed = true;
    }
    return changed ? { ...m, caps: nextCaps } : m;
  });
}
