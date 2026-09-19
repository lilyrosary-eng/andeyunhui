//! Agent 技能按需加载（progressive disclosure）。
//!
//! 对齐 agent-skills：不把所有技能详情塞进上下文，而是先注入「技能索引」（名称 + 一句话说明 +
//! 触发关键词），模型判断需要某项能力时再按名称加载该技能的完整 markdown 说明。
//!
//! 存放约定（技能目录，均为项目级）：
//! - 项目根 `.agent/skills/<skill_name>/SKILL.md`：技能说明（可含 front-matter 或直接 markdown）。
//! - 也支持 `.agent/skills/<skill_name>.md` 单文件扁平形式。
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

/// 列出项目内全部技能索引。技能文件量少，直接扫描（不缓存），保证技能目录变更即时可见。
pub fn list_skills(project_root: Option<&Path>) -> SkillDirectory {
    let root = match project_root {
        Some(r) if !r.as_os_str().is_empty() => r.to_path_buf(),
        _ => return SkillDirectory { root: String::new(), skills: vec![] },
    };
    let root_s = root.to_string_lossy().to_string();
    if let Some(dir) = skills_root(&root) {
        let skills = scan_skills(&dir);
        SkillDirectory { root: dir.to_string_lossy().to_string(), skills }
    } else {
        SkillDirectory { root: root_s, skills: vec![] }
    }
}

/// 按名称加载技能全文。名称已做非字符转义（见 [nonce_guard]），再经 safe_join 规范路径越界校验。
pub fn load_skill(project_root: Option<&Path>, name: &str) -> Result<SkillContent, String> {
    let root = project_root.ok_or("未提供项目根目录")?;
    if root.as_os_str().is_empty() {
        return Err("项目根目录为空".to_string());
    }
    let safe = nonce_guard(name);
    if safe.is_empty() {
        return Err("技能名为空".to_string());
    }
    let dir = skills_root(root).ok_or_else(|| format!("项目内无技能目录（缺失 {}/.agent/skills）", root.display()))?;

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
}