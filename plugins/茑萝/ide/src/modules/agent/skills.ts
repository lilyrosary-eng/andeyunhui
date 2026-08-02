// 茑萝 · IDE Agent 技能系统（Skill System）
// 移植 agent-skills-main 的 SKILL.md 格式：渐进式披露（progressive disclosure）。
//   - 内置技能：编译期打包为 TS 常量（见 builtinSkills.ts），无运行时文件 IO。
//   - 项目级技能：从 ${projectRoot}/.IDE/skills/*/SKILL.md 发现，复用已白名单的
//     list_directory + read_text_file，零新增后端命令。
// 系统提示词仅注入「索引」（name + 一行描述）；agent 用 <skill name="..."/> 按需加载全文。

const hostApi = window.__HOST_API__ as unknown as {
  invoke: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
};

// ===== 技能定义 =====
export interface SkillDef {
  /** 唯一标识（frontmatter name，kebab-case） */
  name: string;
  /** 一行描述（注入 system prompt 索引） */
  description: string;
  /** SKILL.md 正文（去掉 frontmatter 后的 markdown） */
  body: string;
  /** 来源：内置 / 项目级 */
  source: 'builtin' | 'project';
  /** project 来源的文件路径（调试用） */
  filePath?: string;
}

// ===== Frontmatter 解析（最小实现，仅识别 name / description）=====
// 决策记录（见 plan Assumptions §1）：SKILL.md frontmatter 仅这两个已知字段，
// ~15 行正则解析足够，不引入 js-yaml（~30KB）以符合「轻量高效」原则。
// 未来若增加 allowed-tools / hooks 等字段，再换 js-yaml。
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkillMd(
  raw: string,
  source: 'builtin' | 'project',
  filePath?: string,
): SkillDef | null {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(FRONTMATTER_RE);
  if (!m) {
    // 无 frontmatter：把整段当 body，name 取首行非标题文本（降级处理）
    const fallbackName = (raw.split('\n').find((l) => l.trim() && !l.startsWith('#')) || 'unnamed')
      .trim().toLowerCase().replace(/\s+/g, '-').slice(0, 64);
    return {
      name: fallbackName,
      description: '（无 frontmatter，已降级处理）',
      body: raw.trim(),
      source,
      filePath,
    };
  }
  const frontmatter = m[1];
  const body = m[2].trim();
  let name = '';
  let description = '';
  for (const line of frontmatter.split(/\r?\n/)) {
    const fm = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!fm) continue;
    const key = fm[1].toLowerCase();
    // 去掉行内注释与首尾空白/引号
    let val = fm[2].trim().replace(/(^["']|["']$)/g, '');
    // 支持简单多行（description: 后续缩进行续行）——此处仅取单行，多行场景罕见
    if (key === 'name') name = val;
    else if (key === 'description') description = val;
  }
  if (!name) return null; // name 必填，缺失则丢弃
  return {
    name: name.trim().toLowerCase(),
    description: (description || '（无描述）').trim(),
    body,
    source,
    filePath,
  };
}

// ===== 内置技能（从 builtinSkills.ts 加载）=====
import { BUILTIN_SKILLS_RAW } from './builtinSkills';

let builtinSkillsCache: SkillDef[] | null = null;

export function loadBuiltinSkills(): SkillDef[] {
  if (builtinSkillsCache) return builtinSkillsCache;
  builtinSkillsCache = BUILTIN_SKILLS_RAW
    .map((raw) => parseSkillMd(raw, 'builtin'))
    .filter((s): s is SkillDef => s !== null);
  return builtinSkillsCache;
}

// ===== 项目级技能发现 =====
// 目录约定：${projectRoot}/.IDE/skills/<skill-name>/SKILL.md
// 对齐 agent-skills-main 的 skills/<name>/SKILL.md 结构。
export async function discoverProjectSkills(projectRoot: string | null | undefined): Promise<SkillDef[]> {
  if (!projectRoot) return [];
  const skillsDir = joinPath(projectRoot, '.IDE', 'skills');
  let entries: any[];
  try {
    entries = await hostApi.invoke<any[]>('list_directory', { path: skillsDir });
  } catch {
    return []; // 目录不存在或无权限 → 静默返回空（不阻断 agent）
  }
  const subdirs = entries.filter((e) => e && e.is_dir && typeof e.name === 'string');
  const skills: SkillDef[] = [];
  for (const dir of subdirs) {
    const skillPath = joinPath(skillsDir, dir.name, 'SKILL.md');
    try {
      const raw = await hostApi.invoke<string>('read_text_file', { path: skillPath });
      const parsed = parseSkillMd(raw, 'project', skillPath);
      if (parsed) skills.push(parsed);
    } catch {
      // 单个技能读取失败不影响其他技能
    }
  }
  return skills;
}

// 简易路径拼接（兼容 Windows 反斜杠 / POSIX 正斜杠）
function joinPath(...parts: string[]): string {
  const joined = parts.map((p) => p.replace(/[\\/]+$/, '')).join('/');
  // Windows 绝对路径（C:/...）保持原样，其余统一正斜杠
  return joined.replace(/\//g, '/');
}

// ===== 技能注册表 =====
export class SkillRegistry {
  private skills = new Map<string, SkillDef>();

  /** 批量替换全部技能（内置 + 项目合并后调用） */
  setAll(skills: SkillDef[]): void {
    this.skills.clear();
    // 按数组顺序插入；后插入的同名覆盖先插入的（实现「项目同名覆盖内置」）
    for (const s of skills) {
      this.skills.set(s.name.toLowerCase(), s);
    }
  }

  /** 全量列表（按 name 排序，便于稳定输出） */
  list(): SkillDef[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** 紧凑索引（注入 system prompt）：逐行 "- name: description" */
  getIndex(): string {
    const all = this.list();
    if (all.length === 0) return '（暂无可用技能）';
    return all.map((s) => `- ${s.name}：${s.description}`).join('\n');
  }

  /** 按名取全文（命中返回 SkillDef，未命中 null） */
  getSkill(name: string): SkillDef | null {
    const key = (name || '').trim().toLowerCase();
    return this.skills.get(key) ?? null;
  }

  /** 是否存在该技能 */
  has(name: string): boolean {
    return this.skills.has((name || '').trim().toLowerCase());
  }

  /** 技能数量 */
  count(): number {
    return this.skills.size;
  }
}

// ===== 合并内置 + 项目技能（项目同名覆盖内置）=====
export function mergeSkills(builtin: SkillDef[], project: SkillDef[]): SkillDef[] {
  // 先放内置，再放项目；SkillRegistry.setAll 后插入者覆盖
  return [...builtin, ...project];
}
