//! Agent 技能按需加载（progressive disclosure）。
//!
//! 对齐 agent-skills：不把所有技能详情塞进上下文，而是先注入「技能索引」（名称 + 一句话说明 +
//! 触发关键词），模型判断需要某项能力时再按名称加载该技能的完整 markdown 说明。
//!
//! 技能来源（两层，项目优先）：
//! - **随包内置**：`src-tauri/agent-skills/<name>/SKILL.md`，编译期 `include_str!` 嵌入，开箱即用；
//!   也随 bundle.resources 打包，用户可复制到项目里魔改。
//! - **项目定制**：项目根 `.agent/skills/<skill_name>/SKILL.md`（或 `<name>.md` 扁平形式），
//!   同名时覆盖内置版本。
//!
//! 本模块只做「发现 + 按名读取」，不缓存二次解析；读取仅限项目目录内，防路径越界。
//! 调用方（agent 系统提示 / skill 工具）把索引与详情供给模型。

use std::path::{Path, PathBuf};

use serde::Serialize;

/// 技能元数据（索引用，轻量）。
#[derive(Debug, Clone, Serialize)]
pub struct SkillIndex {
    pub name: String,
    pub description: String,
    pub keywords: Vec<String>,
}

/// 一次 list 返回的技能索引（带来源目录）。
#[derive(Debug, Clone, Serialize)]
pub struct SkillDirectory {
    pub root: String,
    pub skills: Vec<SkillIndex>,
}

/// 技能全文（按需加载用）。
#[derive(Debug, Clone, Serialize)]
pub struct SkillContent {
    pub name: String,
    pub content: String,
    pub source: String,
}

/// 随包内置技能：编译期嵌入，故任何项目（含无 `.agent/skills` 的项目）都能开箱可用。
/// 项目根同名技能会覆盖这里的版本。
struct BuiltinSkill {
    name: &'static str,
    content: &'static str,
}

const BUILTIN_SKILLS: &[BuiltinSkill] = &[
    BuiltinSkill { name: "ci-cd-and-automation", content: include_str!("../../agent-skills/ci-cd-and-automation/SKILL.md") },
    BuiltinSkill { name: "code-review-and-quality", content: include_str!("../../agent-skills/code-review-and-quality/SKILL.md") },
    BuiltinSkill { name: "code-simplification", content: include_str!("../../agent-skills/code-simplification/SKILL.md") },
    BuiltinSkill { name: "context-engineering", content: include_str!("../../agent-skills/context-engineering/SKILL.md") },
    BuiltinSkill { name: "debugging-and-error-recovery", content: include_str!("../../agent-skills/debugging-and-error-recovery/SKILL.md") },
    BuiltinSkill { name: "deprecation-and-migration", content: include_str!("../../agent-skills/deprecation-and-migration/SKILL.md") },
    BuiltinSkill { name: "documentation-and-adrs", content: include_str!("../../agent-skills/documentation-and-adrs/SKILL.md") },
    BuiltinSkill { name: "frontend-ui-engineering", content: include_str!("../../agent-skills/frontend-ui-engineering/SKILL.md") },
    BuiltinSkill { name: "git-workflow-and-versioning", content: include_str!("../../agent-skills/git-workflow-and-versioning/SKILL.md") },
    BuiltinSkill { name: "idea-refine", content: include_str!("../../agent-skills/idea-refine/SKILL.md") },
    BuiltinSkill { name: "incremental-implementation", content: include_str!("../../agent-skills/incremental-implementation/SKILL.md") },
    BuiltinSkill { name: "observability-and-instrumentation", content: include_str!("../../agent-skills/observability-and-instrumentation/SKILL.md") },
    BuiltinSkill { name: "performance-optimization", content: include_str!("../../agent-skills/performance-optimization/SKILL.md") },
    BuiltinSkill { name: "planning-and-task-breakdown", content: include_str!("../../agent-skills/planning-and-task-breakdown/SKILL.md") },
    BuiltinSkill { name: "security-and-hardening", content: include_str!("../../agent-skills/security-and-hardening/SKILL.md") },
    BuiltinSkill { name: "source-driven-development", content: include_str!("../../agent-skills/source-driven-development/SKILL.md") },
    BuiltinSkill { name: "spec-driven-development", content: include_str!("../../agent-skills/spec-driven-development/SKILL.md") },
    BuiltinSkill { name: "test-driven-development", content: include_str!("../../agent-skills/test-driven-development/SKILL.md") },
    BuiltinSkill { name: "using-agent-skills", content: include_str!("../../agent-skills/using-agent-skills/SKILL.md") },
];

/// 解析单条 markdown 技能的头部描述：取首行非空 H1 之外的简短说明 + `keywords:` 行。
/// 简易解析，不引依赖；front-matter 未强制，纯文本也能用。
fn parse_meta(content: &str, fallback_name: &str) -> (String, Vec<String>) {
    let mut description = String::new();
    let mut keywords: Vec<String> = Vec::new();
    for line in content.lines().take(12) {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        // keywords: a, b, c
        if let Some(kv) = l.strip_prefix("keywords:") {
            keywords = kv
                .split([',', '，'])
                .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
                .filter(|s| !s.is_empty())
                .collect();
            continue;
        }
        // front-matter: description: xxx / description = xxx
        if let Some(kv) = l.strip_prefix("description:") {
            description = kv.trim().to_string();
            continue;
        }
        // 普通正文首句：跳过 markdown 标题与代码块分隔线
        if l.starts_with('#') || l.starts_with("```") || l.starts_with("---") {
            continue;
        }
        if description.is_empty() && l.len() <= 160 {
            description = l.to_string();
            break;
        }
    }
    if description.is_empty() {
        description = format!("技能：{}", fallback_name);
    }
    (description, keywords)
}

/// 扫描一个技能根目录，返回其下技能索引（含缓存）。
/// 支持 `<name>/SKILL.md` 目录形式与 `<name>.md` 扁平形式。
fn scan_skills(root: &Path) -> Vec<SkillIndex> {
    let mut out: Vec<SkillIndex> = Vec::new();
    let read_skill = |p: &Path, fallback: &str, source_key: String| -> Option<SkillIndex> {
        let content = std::fs::read_to_string(p).ok()?;
        let (desc, kws) = parse_meta(&content, fallback);
        if let Some(fname) = p.file_name().and_then(|f| f.to_str()) {
            let name = if source_key.contains("SKILL.md") {
                // <name>/SKILL.md → 上层目录名
                p.parent()
                    .and_then(|d| d.file_name())
                    .and_then(|f| f.to_str())
                    .unwrap_or(fname)
                    .to_string()
            } else {
                fname.trim_end_matches(".md").to_string()
            };
            Some(SkillIndex {
                name: nonce_guard(&name),
                description: desc,
                keywords: kws,
            })
        } else {
            None
        }
    };

    // 扁平：<name>.md
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_file() && p.extension().map(|x| x == "md").unwrap_or(false) {
                if let Some(idx) = read_skill(&p, "", String::new()) {
                    out.push(idx);
                }
            }
        }
    }
    // 目录形式：<name>/SKILL.md
    if let Ok(rd) = std::fs::read_dir(root) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                let skill_md = p.join("SKILL.md");
                if skill_md.exists() {
                    if let Some(idx) =
                        read_skill(&skill_md, "", skill_md.to_string_lossy().to_string())
                    {
                        out.push(idx);
                    }
                }
            }
        }
    }
    // 去重（同 name 保留目录形式先加者，即优先 SKILL.md）
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.dedup_by(|a, b| a.name == b.name);
    out
}

/// 安全规范技能名：仅保留字母数字与 `-_.`，其余转 `_`，防路径注入。
fn nonce_guard(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "skill".to_string()
    } else {
        cleaned
    }
}

/// 找到项目根的技能目录：`<root>/.agent/skills`。不存在局返回 `None`。
fn skills_root(root: &std::path::Path) -> Option<PathBuf> {
    let dir = root.join(".agent").join("skills");
    if dir.is_dir() {
        Some(dir)
    } else {
        None
    }
}

/// 列出可用技能索引：随包内置 + 项目定制（同名项目优先）。
pub fn list_skills(project_root: Option<&Path>) -> SkillDirectory {
    let mut skills: Vec<SkillIndex> = BUILTIN_SKILLS
        .iter()
        .map(|b| {
            let (description, keywords) = parse_meta(b.content, b.name);
            SkillIndex { name: b.name.to_string(), description, keywords }
        })
        .collect();

    let mut root = String::from("builtin");
    if let Some(pr) = project_root.filter(|r| !r.as_os_str().is_empty()) {
        root = pr.to_string_lossy().to_string();
        if let Some(dir) = skills_root(pr) {
            root = dir.to_string_lossy().to_string();
            for ps in scan_skills(&dir) {
                if let Some(existing) = skills.iter_mut().find(|s| s.name == ps.name) {
                    // 项目同名技能覆盖内置版本
                    *existing = ps;
                } else {
                    skills.push(ps);
                }
            }
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    SkillDirectory { root, skills }
}

/// 按名称加载技能全文：项目 `.agent/skills` 优先，其次随包内置。
pub fn load_skill(project_root: Option<&Path>, name: &str) -> Result<SkillContent, String> {
    let safe = nonce_guard(name);

    if let Some(root) = project_root.filter(|r| !r.as_os_str().is_empty()) {
        if let Some(dir) = skills_root(root) {
            let candidates: Vec<PathBuf> = vec![
                dir.join(&safe).join("SKILL.md"), // 目录形式
                dir.join(format!("{}.md", safe)), // 扁平形式
                dir.join(&safe),                  // 无扩展名兜底
            ];
            for p in candidates {
                // 规范化并校验仍在技能目录内（防越界）
                if p.exists() {
                    if let Ok(canon) = p.canonicalize() {
                        if let Ok(dir_canon) = dir.canonicalize() {
                            if !canon.starts_with(&dir_canon) {
                                return Err(format!("路径越界: {}", canon.display()));
                            }
                        }
                        let content = std::fs::read_to_string(&canon)
                            .map_err(|e| format!("读取技能 {} 失败: {}", safe, e))?;
                        return Ok(SkillContent {
                            name: safe,
                            content,
                            source: canon.to_string_lossy().to_string(),
                        });
                    }
                }
            }
        }
    }

    if let Some(b) = BUILTIN_SKILLS.iter().find(|b| b.name == safe.as_str()) {
        return Ok(SkillContent {
            name: safe,
            content: b.content.to_string(),
            source: "builtin".to_string(),
        });
    }
    Err(format!("未找到技能: {}", safe))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_parse_keywords_and_desc() {
        let md = "\nkeywords: web, 爬虫, fetch\n\n这是一条技能说明。\n更多内容……\n";
        let (desc, kws) = parse_meta(md, "web");
        assert!(desc.contains("技能说明"));
        assert!(kws.contains(&"web".to_string()));
        assert!(kws.contains(&"爬虫".to_string()));
    }

    #[test]
    fn nonce_guard_sanitizes() {
        assert_eq!(nonce_guard("web-fetch_2"), "web-fetch_2");
        // 路径分隔符与反斜杠被替换为下划线（防目录穿越）；`.` 保留（合法文件名字符）
        assert!(!nonce_guard("../evil/name").contains('/'));
        assert!(!nonce_guard("../evil/name").contains('\\'));
        assert!(!nonce_guard("带 空格/斜杠").contains('/'));
        assert!(!nonce_guard("带 空格\\斜杠").contains('\\'));
        assert_eq!(nonce_guard(""), "skill");
    }

    /// 随包内置技能必须开箱可用：即使没有项目根 / 没有 `.agent/skills`。
    #[test]
    fn builtins_available_without_project() {
        let dir = list_skills(None);
        assert_eq!(dir.skills.len(), BUILTIN_SKILLS.len());
        assert!(dir.skills.iter().any(|s| s.name == "code-simplification"));
        // 索引描述不能为空，否则注入系统提示后模型无法判断何时使用
        assert!(dir.skills.iter().all(|s| !s.description.is_empty()));
        assert_eq!(dir.root, "builtin");
    }

    #[test]
    fn builtin_skill_content_loads() {
        let c = load_skill(None, "code-simplification").expect("内置技能应可加载");
        assert!(c.content.contains("代码简化"));
        assert_eq!(c.source, "builtin");
    }
}