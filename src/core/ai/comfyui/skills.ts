/**
 * ComfyUI 工作流技能包——概念移植自 dsh-comfyui 的 skill pack（MIT，见 ../LICENSE-dsh-comfyui）：
 * 每个工作流一份 SKILL.md 式备注（适用场景 / 关键参数 / 踩坑记录），按 slug 存于 localStorage 的 JSON map。
 * slug 取扫描时的 relative 路径 sanitize——同名不同目录不撞车，目录变了备注跟着 relative 走。
 *
 * 三级披露在本仓的落地（按我们的架构翻译，非照抄）：
 *   L1 列表行：skillSummary() 一行摘要（备注首行、跳过标题、截断）；
 *   L2 详情区：完整备注编辑器（ComfyuiPanel 选中工作流时）；
 *   L3 蓝图规划：generateBlueprint 把当前工作流备注拼进 PLAN_SYSTEM，AI 按备注规划节点；
 *   运行可见：image 节点执行前把摘要 pushLog 到运行日志。
 * 与 dsh-comfyui 的差异：不做 read-before-run 硬门禁——他们的门禁是 agent 自由选工作流场景，
 *   我们是本地单机 + 工作流由用户显式指定，硬门禁只会挡执行；这里用软披露（规划注入 + 运行日志）。
 */
import { storage, type Storage } from '@/core/storage';

const SKILLS_KEY = 'andeyunhui.comfyui.skills';
const SUMMARY_MAX = 60;

/** 把工作流 relative 路径变成稳定 slug（中文/符号 → 连字符，空串兜底）。 */
export function skillSlug(relative: string): string {
  const slug = relative
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'workflow';
}

/** 备注首行摘要（L1 披露用）：跳过空行与 # 标题，超长截断。无有效内容返回空串。 */
export function skillSummary(notes: string): string {
  const line = notes
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#'));
  if (!line) return '';
  return line.length > SUMMARY_MAX ? line.slice(0, SUMMARY_MAX) + '…' : line;
}

function loadAll(s: Storage): Record<string, string> {
  const all = s.getJSON<Record<string, string>>(SKILLS_KEY, {});
  return all && typeof all === 'object' ? all : {};
}

/** 读一个工作流的备注（无则空串）。 */
export function loadSkillNotes(slug: string, s: Storage = storage): string {
  const v = loadAll(s)[slug];
  return typeof v === 'string' ? v : '';
}

/** 写备注；空白内容等价于删除该 slug。 */
export function saveSkillNotes(slug: string, text: string, s: Storage = storage): void {
  const all = loadAll(s);
  if (text.trim() === '') delete all[slug];
  else all[slug] = text;
  s.setJSON(SKILLS_KEY, all);
}

/** 备注里「运行失败」小节的分隔标记（与用户手写内容天然分离，便于前端/人阅读）。 */
export const FAIL_MARK = '## 运行失败';
/** 同一原因重复出现时不再追加（把"同一坑踩 N 次"压缩成一条）。 */
function alreadyRecorded(notes: string, reason: string): boolean {
  return notes.includes(reason);
}

/**
 * 把一次生图失败原因 append 进该工作流的备注（AI 写回备注 / 运行反馈闭环）。
 * 纯函数逻辑抽出便于测试：已有同因记录则不重复追加；返回新备注文本（未变更时返回原文本）。
 * 去重是必要的——失败往往成串出现（轮询超时、模型未加载），同因刷屏会淹没用户手写的经验。
 */
export function appendFailNote(notes: string, reason: string, now: Date = new Date()): string {
  const r = reason.trim();
  if (r === '') return notes;
  const base = notes.trim();
  if (alreadyRecorded(base, r)) return notes;
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const line = `- ${stamp} ${r}`;
  if (!base) return `${FAIL_MARK}\n${line}`;
  if (base.includes(FAIL_MARK)) return `${base}\n${line}`;
  return `${base}\n\n${FAIL_MARK}\n${line}`;
}

/** 便捷封装：读 → append → 写。 */
export function recordFailNote(slug: string, reason: string, s: Storage = storage): void {
  const cur = loadSkillNotes(slug, s);
  const next = appendFailNote(cur, reason);
  if (next !== cur) saveSkillNotes(slug, next, s);
}

/** 后端失败原因里的技能包 slug 前缀（ai_tools.rs::SKILL_FAIL_PREFIX 的前端镜像）。 */
export const SKILL_FAIL_PREFIX = '[comfyui-skill:';
/** 写回备注时的原因上限（备注是给人看的经验，不是日志；过长会淹没用户手写内容）。 */
const FAIL_REASON_MAX = 160;

/**
 * 解析生图失败原因里的技能包 slug 前缀。
 * 格式：`[comfyui-skill:<slug>] <原因>`；无前缀（如云端生图失败）或格式残缺返回 null。
 * 纯函数，便于测试。
 */
export function parseSkillFail(detail: string): { slug: string; reason: string } | null {
  if (!detail.startsWith(SKILL_FAIL_PREFIX)) return null;
  const close = detail.indexOf(']');
  if (close < 0) return null;
  const slug = detail.slice(SKILL_FAIL_PREFIX.length, close).trim();
  if (!slug) return null;
  const reason = detail.slice(close + 1).trim().slice(0, FAIL_REASON_MAX);
  if (!reason) return null;
  return { slug, reason };
}

/**
 * 生图失败 → 写回该工作流备注（AI 写回备注闭环）。
 * 解析失败（无前缀/格式残缺）则不动备注——写回是增强，不该误伤其它工作流的经验。
 * 存储异常被吞（不影响对话流）。
 */
export function recordGenerateFail(detail: string, s: Storage = storage): void {
  const parsed = parseSkillFail(detail);
  if (!parsed) return;
  try {
    recordFailNote(parsed.slug, parsed.reason, s);
  } catch {
    /* 备注写回是增强能力，存储异常不应影响对话流 */
  }
}
