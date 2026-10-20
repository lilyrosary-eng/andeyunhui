//! 服务 · 工程快照（checkpoint）—— 每轮 agent 请求的「可回滚点」
//!
//! ## 为什么要有它（2026-10-20）
//! 旧模型是「写前审阅」：`file` 工具把改动塞进内存里的 pending edits，等 IDE 的审阅面板
//! 让用户逐个保留/撤销，再调 `ai_agent_apply_edits` 落盘。审阅面板随 IDE AI 列一起删掉后，
//! **落盘链路断了** —— 工具回「已暂存，等用户审阅确认后落盘」，但没人再调落盘命令，
//! 文件其实一个字节都没变（这是一个真实的 P0 回归）。
//!
//! 新模型：**写入即落盘 + 每轮自动快照 + 随时回滚**。
//!   · 每轮 agent 请求开始时 `begin()` 建一个快照点
//!   · 写文件工具在**落盘前** `capture()`：把该文件当前内容（copy-on-write）存进快照，
//!     只备份真正被改到的文件 —— 不复制整棵树，对 node_modules/target 之类的巨型目录天然免疫
//!   · 用户随时 `rollback()`：把快照里记录的文件逐个写回，新建的文件删除
//!
//! ## 存储布局（app_data 下，跨重启存活、按项目隔离）
//! ```text
//! checkpoints/<项目 key>/index.json          快照清单（最多 10 条，滚动淘汰）
//! checkpoints/<项目 key>/<id>/manifest.json  该快照捕获到的文件列表 + 原本是否存在
//! checkpoints/<项目 key>/<id>/files/<相对路径>  被改文件的「改前内容」
//! ```
//! 项目 key = 项目根路径的 fnv1a64 十六进制 + 目录名（可读），因此不同项目互不干扰。
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

/// 每个项目保留的快照数量（用户要求：最多前十轮，滚动淘汰）。
pub const MAX_PER_PROJECT: usize = 10;

/// 单文件备份上限：超过就跳过（记录 skipped），避免把几 GB 的二进制复制进来。
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckpointMeta {
    pub id: String,
    pub label: String,
    /// 毫秒时间戳
    pub created_at: u64,
    /// 捕获的文件数
    pub files: usize,
    /// 本快照占用的字节数
    pub bytes: u64,
    /// 项目根（回滚列表按项目过滤用）
    pub project_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    /// 相对项目根的路径（统一用 / 分隔，Windows 下也如此，便于跨平台回放）
    rel: String,
    /// 快照时该文件是否存在（false = 本轮新建的，回滚时要删掉）
    existed: bool,
    /// 超过上限而未备份（回滚时跳过并汇报，不能假装恢复成功）
    skipped: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Manifest {
    entries: Vec<Entry>,
}

/// 每个项目「当前打开的」快照 id —— capture 靠它知道往哪个快照里塞文件。
static OPEN: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn open_map() -> std::sync::MutexGuard<'static, Option<HashMap<String, String>>> {
    // Mutex 中毒说明别的线程 panic 过；这里恢复内部数据继续用，不因为一次 panic 让整功能瘫痪
    OPEN.lock().unwrap_or_else(|e| e.into_inner())
}

fn root_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取 app_data 目录失败: {e}"))?
        .join("checkpoints");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建快照目录失败: {e}"))?;
    Ok(dir)
}

/// fnv1a64：只需稳定 + 无依赖，不需要加密强度（不是安全边界，是分桶）。
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
}

/// 项目 key：路径哈希（隔离）+ 目录名（人能看懂哪个项目）。
fn project_key(project_root: &Path) -> String {
    let canon = project_root.canonicalize().unwrap_or_else(|_| project_root.to_path_buf());
    let name = canon
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "root".to_string());
    let safe: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .take(24)
        .collect();
    format!("{:016x}-{}", fnv1a64(canon.to_string_lossy().as_bytes()), safe)
}

fn proj_dir(app: &AppHandle, project_root: &Path) -> Result<PathBuf, String> {
    let dir = root_dir(app)?.join(project_key(project_root));
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建项目快照目录失败: {e}"))?;
    Ok(dir)
}

fn read_index(dir: &Path) -> Vec<CheckpointMeta> {
    let p = dir.join("index.json");
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str::<Vec<CheckpointMeta>>(&s).unwrap_or_else(|e| {
            log::warn!("[checkpoint] index.json 解析失败，按空清单处理: {e}");
            Vec::new()
        }),
        Err(_) => Vec::new(),
    }
}

fn write_index(dir: &Path, list: &[CheckpointMeta]) -> Result<(), String> {
    let p = dir.join("index.json");
    let tmp = dir.join("index.json.tmp");
    let s = serde_json::to_string_pretty(list).map_err(|e| format!("序列化快照清单失败: {e}"))?;
    std::fs::write(&tmp, s).map_err(|e| format!("写快照清单失败: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| format!("替换快照清单失败: {e}"))
}

fn read_manifest(dir: &Path, id: &str) -> Manifest {
    let p = dir.join(id).join("manifest.json");
    match std::fs::read_to_string(&p) {
        Ok(s) => serde_json::from_str::<Manifest>(&s).unwrap_or_else(|e| {
            log::warn!("[checkpoint] manifest 解析失败 id={id}: {e}");
            Manifest::default()
        }),
        Err(_) => Manifest::default(),
    }
}

fn write_manifest(dir: &Path, id: &str, m: &Manifest) -> Result<(), String> {
    let d = dir.join(id);
    std::fs::create_dir_all(&d).map_err(|e| format!("创建快照目录失败: {e}"))?;
    let s = serde_json::to_string_pretty(m).map_err(|e| format!("序列化 manifest 失败: {e}"))?;
    std::fs::write(d.join("manifest.json"), s).map_err(|e| format!("写 manifest 失败: {e}"))
}

/// 开始一个快照点。`label` 只在列表里展示（例如「第 3 轮 · 修复登录」）。
pub fn begin(app: &AppHandle, project_root: &Path, label: &str) -> Result<String, String> {
    let dir = proj_dir(app, project_root)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let id = format!("{now}");
    std::fs::create_dir_all(dir.join(&id).join("files"))
        .map_err(|e| format!("创建快照文件目录失败: {e}"))?;
    write_manifest(&dir, &id, &Manifest::default())?;

    let mut list = read_index(&dir);
    list.insert(0, CheckpointMeta {
        id: id.clone(),
        label: label.to_string(),
        created_at: now,
        files: 0,
        bytes: 0,
        project_root: project_root.to_string_lossy().to_string(),
    });
    // 滚动淘汰：只留最近 MAX_PER_PROJECT 个（含刚建的）
    while list.len() > MAX_PER_PROJECT {
        if let Some(old) = list.pop() {
            let p = dir.join(&old.id);
            if let Err(e) = std::fs::remove_dir_all(&p) {
                log::warn!("[checkpoint] 淘汰旧快照失败 id={}: {e}", old.id);
            }
        }
    }
    write_index(&dir, &list)?;

    let key = project_key(project_root);
    open_map().get_or_insert_with(HashMap::new).insert(key, id.clone());
    log::info!("[checkpoint] 新建快照 id={id} label={label} project={}", project_root.display());
    Ok(id)
}

/// 落盘**前**调用：把该文件的当前内容备份进当前快照（同一文件只备份一次）。
///
/// 没有打开的当前快照时直接返回 Ok —— 快照是"尽力而为"的保险，不能因为它让写文件失败。
pub fn capture(app: &AppHandle, project_root: &Path, abs: &Path) -> Result<(), String> {
    let key = project_key(project_root);
    let Some(id) = open_map().as_ref().and_then(|m| m.get(&key).cloned()) else {
        return Ok(());
    };
    let rel = match abs.strip_prefix(project_root) {
        Ok(r) => r.to_string_lossy().replace('\\', "/"),
        Err(_) => {
            // 项目外写入（逐个审批过，不属于本项目的回滚范围）
            log::info!("[checkpoint] 跳过项目外文件: {}", abs.display());
            return Ok(());
        }
    };
    let dir = proj_dir(app, project_root)?;
    let mut m = read_manifest(&dir, &id);
    if m.entries.iter().any(|e| e.rel == rel) {
        return Ok(());
    }

    let (existed, skipped, bytes) = match std::fs::metadata(abs) {
        Ok(md) if md.is_file() => {
            if md.len() > MAX_FILE_BYTES {
                log::warn!(
                    "[checkpoint] 文件超上限未备份（{} MB > {} MB）: {}",
                    md.len() / 1048576, MAX_FILE_BYTES / 1048576, rel
                );
                (true, true, 0)
            } else {
                let dst = dir.join(&id).join("files").join(&rel);
                if let Some(parent) = dst.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("建备份目录失败: {e}"))?;
                }
                std::fs::copy(abs, &dst).map_err(|e| format!("备份 {} 失败: {e}", rel))?;
                (true, false, md.len())
            }
        }
        _ => (false, false, 0),
    };

    m.entries.push(Entry { rel, existed, skipped });
    write_manifest(&dir, &id, &m)?;

    // 回写清单里的 files/bytes 统计
    let mut list = read_index(&dir);
    if let Some(meta) = list.iter_mut().find(|x| x.id == id) {
        meta.files = m.entries.iter().filter(|e| !e.skipped).count();
        meta.bytes += bytes;
    }
    write_index(&dir, &list)?;
    Ok(())
}

/// 列出某项目的快照（不传项目则列全部项目的合并视图，按时间倒序）。
pub fn list(app: &AppHandle, project_root: Option<&Path>) -> Vec<CheckpointMeta> {
    let root = match root_dir(app) {
        Ok(d) => d,
        Err(e) => {
            log::error!("[checkpoint] 列快照失败: {e}");
            return Vec::new();
        }
    };
    let mut out: Vec<CheckpointMeta> = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    for e in entries.flatten() {
        if !e.path().is_dir() {
            continue;
        }
        out.extend(read_index(&e.path()));
    }
    if let Some(pr) = project_root {
        let want = pr.to_string_lossy().to_string();
        out.retain(|m| m.project_root == want);
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

/// 回滚到某个快照。返回 (恢复的文件数, 删除的文件数, 跳过数)。
pub fn rollback(app: &AppHandle, id: &str) -> Result<(usize, usize, usize), String> {
    let root = root_dir(app)?;
    let entries = std::fs::read_dir(&root).map_err(|e| format!("读快照根目录失败: {e}"))?;
    for e in entries.flatten() {
        let dir = e.path();
        if !dir.is_dir() {
            continue;
        }
        let list = read_index(&dir);
        let Some(meta) = list.iter().find(|m| m.id == id).cloned() else {
            continue;
        };
        let m = read_manifest(&dir, id);
        let proj = PathBuf::from(&meta.project_root);
        let mut restored = 0usize;
        let mut removed = 0usize;
        let mut skipped = 0usize;
        // 逆序回放：同一文件在本快照里只会有一条（capture 去重），逆序只是为了"后写覆盖先写"的直觉一致
        for ent in m.entries.iter().rev() {
            if ent.skipped {
                skipped += 1;
                log::warn!("[checkpoint] 回滚跳过（当初因超限未备份）: {}", ent.rel);
                continue;
            }
            let target = proj.join(ent.rel.replace('/', std::path::MAIN_SEPARATOR_STR));
            if ent.existed {
                let src = dir.join(id).join("files").join(&ent.rel);
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败: {e}"))?;
                }
                std::fs::copy(&src, &target)
                    .map_err(|e| format!("恢复 {} 失败: {e}", ent.rel))?;
                restored += 1;
            } else if target.exists() {
                std::fs::remove_file(&target).map_err(|e| format!("删除 {} 失败: {e}", ent.rel))?;
                removed += 1;
            }
        }
        // 回滚后清掉该项目"当前打开的"快照：否则后续写入会继续往这个已被"用过"的快照里捕获
        let key = project_key(&proj);
        if let Some(map) = open_map().as_mut() {
            map.remove(&key);
        }
        log::info!(
            "[checkpoint] 回滚完成 id={id} 恢复={restored} 删除={removed} 跳过={skipped}"
        );
        return Ok((restored, removed, skipped));
    }
    Err(format!("快照不存在: {id}"))
}

/// 清掉某项目的当前快照点（下一轮写入会重新 begin）。
pub fn close(project_root: &Path) {
    let key = project_key(project_root);
    if let Some(map) = open_map().as_mut() {
        map.remove(&key);
    }
}
