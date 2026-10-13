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
