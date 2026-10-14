/**
 * 供应商预设的匹配、推断与合并（纯函数，便于单测）。
 *
 * 三个用途：
 *  ① **去重**：base_url 相同的预设不再新建，而是复用已有预设做增量合并
 *     （用户诉求：「如果 api url 一模一样，则不再添加新预设」）。自动发现与手动
 *     添加都走这里，口径一致。
 *  ② **命名**：自动获取只拿得到 url/key，供应商名靠域名推断（用户诉求：
 *     「供应商名称不会自动获取，我们尝试支持一下」）。
 *  ③ **合并**：增量并入的「仅增不减」口径（见 mergeModels）。
 */

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
