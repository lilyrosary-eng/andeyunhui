use std::fs;
use std::path::{Path, PathBuf};
use serde::{Serialize, Deserialize};
use chrono::Utc;
use uuid::Uuid;

/// 自动保存配置
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AutoSaveConfig {
    pub enabled: bool,
    pub interval_secs: u64,
}

impl Default for AutoSaveConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            interval_secs: 30,
        }
    }
}

fn config_path(app_data: &Path) -> PathBuf {
    app_data.join("auto_save_config.json")
}

fn transfer_station_dir(app_data: &Path) -> PathBuf {
    app_data.join("transfer_station")
}

fn backups_dir(app_data: &Path) -> PathBuf {
    transfer_station_dir(app_data).join("backups")
}

/// 加载自动保存配置
pub fn load_config(app_data: &Path) -> AutoSaveConfig {
    let path = config_path(app_data);
    if path.exists() {
        match fs::read_to_string(&path) {
            Ok(s) => {
                match serde_json::from_str::<AutoSaveConfig>(&s) {
                    Ok(cfg) => {
                        eprintln!(
                            "[TransferStation] 配置已加载: enabled={}, interval={}s, path={}",
                            cfg.enabled,
                            cfg.interval_secs,
                            path.display()
                        );
                        return cfg;
                    }
                    Err(e) => {
                        eprintln!("[TransferStation] 配置 JSON 解析失败: {}, 使用默认配置", e);
                    }
                }
            }
            Err(e) => {
                eprintln!("[TransferStation] 配置文件读取失败: {}, 使用默认配置", e);
            }
        }
    } else {
        eprintln!("[TransferStation] 配置文件不存在，使用默认配置: enabled=true, interval=30s");
    }
    AutoSaveConfig::default()
}

/// 保存自动保存配置
pub fn save_config(app_data: &Path, config: &AutoSaveConfig) -> Result<(), String> {
    let path = config_path(app_data);
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    fs::write(&path, &json).map_err(|e| e.to_string())?;
    eprintln!(
        "[TransferStation] 配置已写入: enabled={}, interval={}s, path={}",
        config.enabled,
        config.interval_secs,
        path.display()
    );
    Ok(())
}

/// 确保中转站目录结构存在
pub fn ensure_dirs(app_data: &Path) -> Result<(), String> {
    fs::create_dir_all(backups_dir(app_data)).map_err(|e| e.to_string())?;
    Ok(())
}

/// 备份原文件到中转站（仅首次备份，后续不动）
/// 返回备份文件名，如果已有备份则返回 None
pub fn backup_original(app_data: &Path, file_id: &str, original_content: &str) -> Result<Option<String>, String> {
    ensure_dirs(app_data)?;

    // 检查是否已有备份（通过文件名前缀匹配）
    if let Ok(entries) = fs::read_dir(backups_dir(app_data)) {
        let mut skipped = 0u32;
        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    skipped += 1;
                    if skipped <= 3 {
                        eprintln!("[TransferStation] 无法读取备份条目: {}", e);
                    }
                    continue;
                }
            };
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&format!("{}_", file_id)) {
                eprintln!(
                    "[TransferStation] 备份跳过: file_id={}, 已有备份 '{}', 保护不变",
                    file_id, name
                );
                return Ok(None); // 已有备份，跳过
            }
        }
    }

    let timestamp = Utc::now().format("%Y%m%d_%H%M%S").to_string();
    let backup_name = format!("{}_{}.md", file_id, timestamp);
    let backup_path = backups_dir(app_data).join(&backup_name);
    fs::write(&backup_path, original_content).map_err(|e| e.to_string())?;
    eprintln!(
        "[TransferStation] 首次备份完成: file_id={}, backup={}, content_len={}",
        file_id,
        backup_name,
        original_content.len()
    );
    Ok(Some(backup_name))
}

/// 保存当前版本到中转站
pub fn save_to_transfer_station(app_data: &Path, file_id: &str, content: &str) -> Result<(), String> {
    ensure_dirs(app_data)?;
    let file_path = transfer_station_dir(app_data).join(format!("{}.md", file_id));
    fs::write(&file_path, content).map_err(|e| e.to_string())?;
    eprintln!(
        "[TransferStation] 中转站写入完成: file_id={}, path={}, content_len={}",
        file_id,
        file_path.display(),
        content.len()
    );
    Ok(())
}

// ================= 通用存档（快照）=================
// 全局设置「中转站 / 存档」使用：任何内容（笔记 / 文件 / 图片）一旦变动即生成快照，
// 可恢复、可删除。与「当前暂存 / 首次备份」（仅笔记）相互独立。

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub id: String,
    pub kind: String,        // note | file | image
    pub source_id: String,   // 来源标识（笔记 id / 文件 hash 等）
    pub name: String,        // 展示名
    pub ext: String,
    pub size: u64,
    pub modified: String,    // YYYYMMDD_HHMMSS
    /// 快照对应的**原始绝对路径**。恢复时优先还原到这里。
    ///
    /// `None` 是合法的：旧版本 manifest 没有这个字段，笔记类快照也不需要原路径
    /// （笔记的落点由 `source_id` 唯一决定）。所以用 `default` 兼容旧数据，
    /// 不要因为缺字段就把整份 manifest 当成坏数据丢掉。
    #[serde(default)]
    pub origin_path: Option<String>,
}

/// 回收站总字节上限（2 GiB）。
///
/// 旧实现按**条数**限制（300 条），但每条都是**完整字节副本** ——
/// 300 个视频就是几百 GB，而且用户完全无法预期。作为回收站，
/// 磁盘成本必须有一个能说清的上界，所以改成按字节计。
pub const MAX_ARCHIVE_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// 同时保留的条数上限：防止海量小文件把 manifest 撑大、把设置页列表撑爆。
/// 正常情况下先撞到字节上限，这条只是兜底。
pub const MAX_ARCHIVE_ENTRIES: usize = 500;

/// 归档结果。删除文件时必须能区分「进回收站了」和「太大没进去」——
/// 后者意味着**这次删除不可撤销**，必须显式告诉用户，不能静默降级。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArchiveOutcome {
    Archived(String),
    TooLarge { size: u64, limit: u64 },
    Failed(String),
}

impl ArchiveOutcome {
    /// 是否真的落进了回收站。
    pub fn is_archived(&self) -> bool {
        matches!(self, ArchiveOutcome::Archived(_))
    }

    /// 给用户看的一句话（成功返回 None，无需提示）。
    pub fn notice(&self) -> Option<String> {
        match self {
            ArchiveOutcome::Archived(_) => None,
            ArchiveOutcome::TooLarge { size, limit } => Some(format!(
                "文件 {} 超过回收站单文件上限 {}，已直接删除且**无法恢复**",
                human_bytes(*size),
                human_bytes(*limit)
            )),
            ArchiveOutcome::Failed(e) => {
                Some(format!("回收站归档失败（{e}），本次删除**无法撤销**"))
            }
        }
    }
}

pub fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KiB", "MiB", "GiB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{} {}", n, UNITS[0])
    } else {
        format!("{:.1} {}", v, UNITS[i])
    }
}

fn archives_dir(app_data: &Path) -> PathBuf {
    transfer_station_dir(app_data).join("archives")
}

fn manifest_path(app_data: &Path) -> PathBuf {
    archives_dir(app_data).join("manifest.json")
}

pub fn load_archive_manifest(app_data: &Path) -> Vec<ArchiveEntry> {
    let p = manifest_path(app_data);
    if let Ok(s) = fs::read_to_string(&p) {
        serde_json::from_str::<Vec<ArchiveEntry>>(&s).unwrap_or_default()
    } else {
        Vec::new()
    }
}

fn save_archive_manifest(app_data: &Path, entries: &[ArchiveEntry]) -> Result<(), String> {
    let p = manifest_path(app_data);
    let json = serde_json::to_string_pretty(entries).map_err(|e| e.to_string())?;
    fs::write(&p, json).map_err(|e| e.to_string())?;
    Ok(())
}

/// 生成一份存档快照（兼容旧签名：不带原始路径）。
///
/// 覆盖语义：同一个 (kind, source_id) 只保留「最新一份」快照。
/// 例如笔记以 note_id 为 source_id，每次改动都会覆盖上一份，
/// 软件关闭再打开后下次改动即以「当前笔记」重建，不会无限累积历史。
pub fn archive_snapshot(
    app_data: &Path,
    kind: &str,
    source_id: &str,
    name: &str,
    content: &[u8],
    ext: &str,
) -> Option<String> {
    match archive_snapshot_at(app_data, kind, source_id, name, content, ext, None) {
        ArchiveOutcome::Archived(f) => Some(f),
        _ => None,
    }
}

/// 生成一份存档快照，并记录它原本所在的绝对路径（回收站用它还原到原处）。
///
/// ★ 覆盖语义只对**同一个 (kind, source_id)** 生效。走回收站的文件，
///   source_id 必须取**每次删除都唯一**的值（见 `dropzone::station_remove_record`），
///   否则第二次删同名文件会把第一次的回收站记录顶掉。
pub fn archive_snapshot_at(
    app_data: &Path,
    kind: &str,
    source_id: &str,
    name: &str,
    content: &[u8],
    ext: &str,
    origin_path: Option<&Path>,
) -> ArchiveOutcome {
    archive_snapshot_with_limit(
        app_data,
        kind,
        source_id,
        name,
        content,
        ext,
        origin_path,
        MAX_ARCHIVE_BYTES,
        MAX_ARCHIVE_ENTRIES,
    )
}

/// 从**磁盘文件**归档（流式 `fs::copy`，不把整文件读进内存）。
///
/// 回收站要能收几百 MB 到 2 GiB 的文件，`fs::read` 整份进内存会直接把进程顶爆
/// —— 与「导入 2 GB 视频时传输模块卡死」同源。删除既有文件走这条路径；
/// 只有笔记/剪贴板这类本来就有内存字节的调用方才走 `archive_snapshot_at`。
pub fn archive_file_at(
    app_data: &Path,
    kind: &str,
    source_id: &str,
    name: &str,
    src: &Path,
    ext: &str,
    origin_path: Option<&Path>,
) -> ArchiveOutcome {
    let size = match fs::metadata(src) {
        Ok(m) => m.len(),
        Err(e) => return ArchiveOutcome::Failed(format!("读取文件大小失败: {e}")),
    };
    if size > MAX_ARCHIVE_BYTES {
        eprintln!(
            "[TransferStation] 拒绝归档（{} > 配额 {}）: {}",
            human_bytes(size),
            human_bytes(MAX_ARCHIVE_BYTES),
            name
        );
        return ArchiveOutcome::TooLarge {
            size,
            limit: MAX_ARCHIVE_BYTES,
        };
    }

    let dir = archives_dir(app_data);
    if let Err(e) = fs::create_dir_all(&dir) {
        return ArchiveOutcome::Failed(format!("创建存档目录失败: {e}"));
    }
    let (id, ext, path) = new_archive_path(&dir, ext);
    if let Err(e) = fs::copy(src, &path) {
        let _ = fs::remove_file(&path);
        return ArchiveOutcome::Failed(format!("复制到回收站失败: {e}"));
    }

    commit_entry(
        app_data,
        ArchiveEntry {
            id,
            kind: kind.to_string(),
            source_id: source_id.to_string(),
            name: name.to_string(),
            ext,
            size,
            modified: Utc::now().format("%Y%m%d_%H%M%S").to_string(),
            origin_path: origin_path.map(|p| p.to_string_lossy().to_string()),
        },
        MAX_ARCHIVE_BYTES,
        MAX_ARCHIVE_ENTRIES,
    )
}

fn new_archive_path(dir: &Path, ext: &str) -> (String, String, PathBuf) {
    let ts = Utc::now().format("%Y%m%d_%H%M%S").to_string();
    let id = format!("{}_{}", ts, Uuid::new_v4().simple());
    let ext = if ext.is_empty() { "bin" } else { ext };
    let fname = format!("{}.{}", id, ext);
    (id, ext.to_string(), dir.join(fname))
}

/// 把已落盘的一条快照记进 manifest，并按配额淘汰最旧。
fn commit_entry(
    app_data: &Path,
    entry: ArchiveEntry,
    limit_bytes: u64,
    limit_entries: usize,
) -> ArchiveOutcome {
    let dir = archives_dir(app_data);
    let fname = format!("{}.{}", entry.id, entry.ext);
    let (log_kind, log_name, log_size) = (entry.kind.clone(), entry.name.clone(), entry.size);
    let mut entries = load_archive_manifest(app_data);

    // 覆盖同 (kind, source_id) 的旧快照，保持每个来源只一份存档
    for old in entries
        .iter()
        .filter(|e| e.kind == entry.kind && e.source_id == entry.source_id)
    {
        let _ = fs::remove_file(dir.join(format!("{}.{}", old.id, old.ext)));
    }
    entries.retain(|e| !(e.kind == entry.kind && e.source_id == entry.source_id));
    entries.push(entry);

    // 配额淘汰：从最旧开始丢，直到同时满足「字节」与「条数」两条上限。
    // entries 按写入顺序排列（旧 → 新），所以 drain 前面就是丢最旧。
    let mut total: u64 = entries.iter().map(|e| e.size).sum();
    let mut drop_n = 0usize;
    while drop_n < entries.len().saturating_sub(1)
        && (total > limit_bytes || entries.len() - drop_n > limit_entries)
    {
        total -= entries[drop_n].size;
        drop_n += 1;
    }
    if drop_n > 0 {
        let dropped: Vec<ArchiveEntry> = entries.drain(0..drop_n).collect();
        for d in &dropped {
            let _ = fs::remove_file(dir.join(format!("{}.{}", d.id, d.ext)));
        }
        eprintln!(
            "[TransferStation] 回收站超配额，淘汰 {} 条最旧记录（现占 {}，上限 {}）",
            dropped.len(),
            human_bytes(total),
            human_bytes(limit_bytes)
        );
    }
    if let Err(e) = save_archive_manifest(app_data, &entries) {
        return ArchiveOutcome::Failed(format!("写入存档索引失败: {e}"));
    }
    eprintln!(
        "[TransferStation] 存档快照: kind={}, name={}, size={}",
        log_kind,
        log_name,
        human_bytes(log_size)
    );
    ArchiveOutcome::Archived(fname)
}

/// 配额可注入的实现版本。生产走 `archive_snapshot_at` 的默认配额；
/// 单测要验证淘汰逻辑，不可能真造 2 GiB 数据，所以把上限开放成参数。
#[allow(clippy::too_many_arguments)]
fn archive_snapshot_with_limit(
    app_data: &Path,
    kind: &str,
    source_id: &str,
    name: &str,
    content: &[u8],
    ext: &str,
    origin_path: Option<&Path>,
    limit_bytes: u64,
    limit_entries: usize,
) -> ArchiveOutcome {
    let size = content.len() as u64;
    // 单文件就超过总配额 ⇒ 收进去也会立刻把自己淘汰掉（或者挤掉全部旧记录），
    // 与其做一个假装存在的回收站，不如明确拒绝让调用方提示用户。
    if size > limit_bytes {
        eprintln!(
            "[TransferStation] 拒绝归档（{} > 配额 {}）: {}",
            human_bytes(size),
            human_bytes(limit_bytes),
            name
        );
        return ArchiveOutcome::TooLarge {
            size,
            limit: limit_bytes,
        };
    }

    let dir = archives_dir(app_data);
    if let Err(e) = fs::create_dir_all(&dir) {
        return ArchiveOutcome::Failed(format!("创建存档目录失败: {e}"));
    }
    let (id, ext, path) = new_archive_path(&dir, ext);
    if let Err(e) = fs::write(&path, content) {
        let _ = fs::remove_file(&path);
        return ArchiveOutcome::Failed(format!("写入存档失败: {e}"));
    }

    commit_entry(
        app_data,
        ArchiveEntry {
            id,
            kind: kind.to_string(),
            source_id: source_id.to_string(),
            name: name.to_string(),
            ext,
            size,
            modified: Utc::now().format("%Y%m%d_%H%M%S").to_string(),
            origin_path: origin_path.map(|p| p.to_string_lossy().to_string()),
        },
        limit_bytes,
        limit_entries,
    )
}

/// 回收站当前占用的总字节数。
pub fn archive_total_bytes(app_data: &Path) -> u64 {
    load_archive_manifest(app_data).iter().map(|e| e.size).sum()
}

/// 列出所有存档快照（最新在前）。
pub fn list_archives(app_data: &Path) -> Vec<ArchiveEntry> {
    let mut entries = load_archive_manifest(app_data);
    entries.reverse();
    entries
}

/// 恢复存档：优先还原到 `origin_path`，没有（或原目录已不可用）才落回中转站 dropzone。
///
/// 返回**实际写入的绝对路径**——用户点「还原」之后必须知道东西去哪了，
/// 尤其是原目录已经不存在（U 盘拔了 / 文件夹被删）而回退到 dropzone 的情况。
///
/// 还原**不清除**回收站条目：留着让用户确认无误后自己删，比"还原即消失、
/// 结果发现还原错了却没得再试"安全。
pub fn restore_archive(app_data: &Path, id: &str) -> Result<String, String> {
    let entries = load_archive_manifest(app_data);
    let entry = entries
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| "存档不存在".to_string())?;
    let src = archives_dir(app_data).join(format!("{}.{}", entry.id, entry.ext));
    let content = fs::read(&src).map_err(|e| format!("读取存档失败: {}", e))?;

    let file_name = format!("{}.{}", entry.source_id, entry.ext);
    let dest = if entry.kind == "note" {
        app_data.join("notes").join(format!("{}.md", entry.source_id))
    } else {
        // 只有「原目录仍然存在」才敢往原地写。路径没了就往回退（比如外接盘拔了），
        // 否则 write 会直接失败，用户看到的是一句没有上下文的 IO 错误。
        match entry.origin_path.as_deref().map(Path::new) {
            Some(p) if p.parent().map(|d| d.is_dir()).unwrap_or(false) => p.to_path_buf(),
            Some(p) => {
                eprintln!(
                    "[TransferStation] 原路径所在目录已不存在，回退到中转站: {}",
                    p.display()
                );
                transfer_station_dir(app_data).join("dropzone").join(&file_name)
            }
            None => transfer_station_dir(app_data).join("dropzone").join(&file_name),
        }
    };
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
    }
    fs::write(&dest, &content).map_err(|e| format!("恢复失败: {}", e))?;
    eprintln!("[TransferStation] 恢复存档: id={}, -> {}", id, dest.display());
    Ok(dest.to_string_lossy().to_string())
}

/// 删除单个存档快照（文件 + manifest 条目）。
pub fn delete_archive(app_data: &Path, id: &str) -> Result<(), String> {
    let mut entries = load_archive_manifest(app_data);
    let before = entries.len();
    entries.retain(|e| e.id != id);
    if entries.len() == before {
        return Err("存档不存在".to_string());
    }
    // 磁盘文件按 id 前缀删除（扩展名已知存于 manifest，但直接前缀匹配更稳妥）
    if let Ok(items) = fs::read_dir(archives_dir(app_data)) {
        for it in items.flatten() {
            if it.file_name().to_string_lossy().starts_with(&format!("{}.", id)) {
                let _ = fs::remove_file(it.path());
            }
        }
    }
    save_archive_manifest(app_data, &entries)?;
    eprintln!("[TransferStation] 删除存档: id={}", id);
    Ok(())
}

/// 清空所有存档快照。返回删除的文件数。
pub fn clear_archives(app_data: &Path) -> Result<u32, String> {
    let dir = archives_dir(app_data);
    let mut count = 0u32;
    if let Ok(items) = fs::read_dir(&dir) {
        for it in items.flatten() {
            if it.file_name().to_string_lossy() == "manifest.json" {
                continue;
            }
            if it.path().is_file() {
                if fs::remove_file(it.path()).is_ok() {
                    count += 1;
                }
            }
        }
    }
    save_archive_manifest(app_data, &[])?;
    eprintln!("[TransferStation] 清空存档: 删除 {} 个文件", count);
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 模拟文件变动场景：创建文件 → 首次保存（备份原文件 + 写入中转站） → 再次保存（跳过备份）
    #[test]
    fn test_transfer_station_flow() {
        let tmp = std::env::temp_dir().join("ts_test_transfer");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();

        eprintln!("\n========== 测试开始：模拟文件变动场景 ==========");
        eprintln!("[Test] 临时目录: {}", tmp.display());

        // 1. 模拟原始文件内容
        let note_id = "test_note_001";
        let original_content = "# 原始内容\n\n这是第一次写的内容。";
        let modified_content = "# 修改后的内容\n\n这是第二次修改后的内容，比之前多了很多。";

        eprintln!("\n--- 场景 1：首次保存，应触发备份 ---");
        eprintln!("[Test] 原始内容: '{}'", original_content);
        eprintln!("[Test] 修改后内容: '{}'", modified_content);

        // 模拟 notes 目录中的原始文件
        let notes_dir = tmp.join("notes");
        fs::create_dir_all(&notes_dir).unwrap();
        let note_path = notes_dir.join(format!("{}.md", note_id));
        fs::write(&note_path, original_content).unwrap();
        eprintln!("[Test] 写入原始文件: {}", note_path.display());

        // 首次保存：备份原文件 + 写入中转站
        let result = backup_original(&tmp, note_id, original_content);
        assert!(result.is_ok(), "backup_original 应成功");
        let backup_name = result.unwrap();
        assert!(backup_name.is_some(), "首次备份应返回备份文件名");
        eprintln!("[Test] 首次备份结果: backup={}", backup_name.unwrap());

        let result = save_to_transfer_station(&tmp, note_id, modified_content);
        assert!(result.is_ok(), "save_to_transfer_station 应成功");

        // 验证备份文件存在且内容为原始内容
        let backups = backups_dir(&tmp);
        let backup_entries: Vec<_> = fs::read_dir(&backups).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(backup_entries.len(), 1, "备份目录应有 1 个文件");
        let backup_content = fs::read_to_string(backup_entries[0].path()).unwrap();
        assert_eq!(backup_content, original_content, "备份内容应与原始内容一致");
        eprintln!("[Test] 备份文件验证通过: 内容与原始一致");

        // 验证中转站文件存在且内容为修改后内容
        let ts_file = transfer_station_dir(&tmp).join(format!("{}.md", note_id));
        assert!(ts_file.exists(), "中转站文件应存在");
        let ts_content = fs::read_to_string(&ts_file).unwrap();
        assert_eq!(ts_content, modified_content, "中转站内容应与修改后内容一致");
        eprintln!("[Test] 中转站文件验证通过: 内容与修改后一致");

        eprintln!("\n--- 场景 2：再次保存，应跳过备份 ---");
        let third_content = "# 第三次修改\n\n又改了一次。";
        eprintln!("[Test] 第三次内容: '{}'", third_content);

        // 再次备份：应返回 None（已有备份）
        let result = backup_original(&tmp, note_id, original_content);
        assert!(result.is_ok(), "再次备份应成功");
        assert!(result.unwrap().is_none(), "再次备份应返回 None");
        eprintln!("[Test] 再次备份: 已跳过（保护原备份不变）");

        // 中转站更新为最新内容
        let result = save_to_transfer_station(&tmp, note_id, third_content);
        assert!(result.is_ok(), "中转站更新应成功");

        let ts_content = fs::read_to_string(&ts_file).unwrap();
        assert_eq!(ts_content, third_content, "中转站应更新为最新内容");
        eprintln!("[Test] 中转站更新验证通过: 内容更新为最新版本");

        // 备份文件数量不变，内容不变
        let backup_entries: Vec<_> = fs::read_dir(&backups).unwrap().filter_map(|e| e.ok()).collect();
        assert_eq!(backup_entries.len(), 1, "备份文件数量应不变");
        let backup_content = fs::read_to_string(backup_entries[0].path()).unwrap();
        assert_eq!(backup_content, original_content, "备份内容应保持不变");
        eprintln!("[Test] 备份不可变验证通过: 原始备份未被覆盖");

        eprintln!("\n--- 场景 3：自动保存禁用，应跳过所有操作 ---");
        let config = AutoSaveConfig { enabled: false, interval_secs: 30 };
        save_config(&tmp, &config).unwrap();
        let loaded = load_config(&tmp);
        assert!(!loaded.enabled, "配置应反映禁用状态");
        eprintln!("[Test] 禁用配置验证通过: enabled=false");

        eprintln!("\n========== 所有测试通过 ==========");

        // 清理
        let _ = fs::remove_dir_all(&tmp);
    }

    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ts_test_{tag}_{}", Uuid::new_v4().simple()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// 回收站的核心承诺：删了能还原到**原处**，不是还原到某个内部目录。
    #[test]
    fn restore_goes_back_to_origin_path() {
        let app = tmp_dir("restore_origin");
        let user_dir = app.join("user").join("downloads");
        fs::create_dir_all(&user_dir).unwrap();
        let origin = user_dir.join("report.pdf");

        let out = archive_snapshot_at(
            &app,
            "file",
            "sid-1",
            "report.pdf",
            b"hello",
            "pdf",
            Some(&origin),
        );
        assert!(out.is_archived(), "应归档成功: {out:?}");

        let id = list_archives(&app)[0].id.clone();
        let landed = restore_archive(&app, &id).unwrap();
        assert_eq!(Path::new(&landed), origin, "应还原到原路径");
        assert_eq!(fs::read(&origin).unwrap(), b"hello");

        let _ = fs::remove_dir_all(&app);
    }

    /// 原目录没了（外接盘拔掉 / 文件夹被删）必须**回退**到中转站，
    /// 而不是让 write 直接报一个没有上下文的 IO 错误。
    #[test]
    fn restore_falls_back_when_origin_dir_gone() {
        let app = tmp_dir("restore_fallback");
        let gone = app.join("usb").join("a.bin");
        let out = archive_snapshot_at(&app, "file", "sid-2", "a.bin", b"x", "bin", Some(&gone));
        assert!(out.is_archived());

        let id = list_archives(&app)[0].id.clone();
        let landed = restore_archive(&app, &id).unwrap();
        let expected = transfer_station_dir(&app).join("dropzone").join("sid-2.bin");
        assert_eq!(Path::new(&landed), expected, "应回退到中转站 dropzone");
    }

    /// 配额按**字节**淘汰最旧，不能按条数——否则 300 个视频就是几百 GB。
    #[test]
    fn evicts_oldest_when_bytes_exceed_limit() {
        let app = tmp_dir("quota_bytes");
        // 上限 100 字节，每条 40 字节：能留 2 条，第 3 条进来时必须把最旧的挤掉
        for i in 0..3 {
            let out = archive_snapshot_with_limit(
                &app,
                "file",
                &format!("s{i}"),
                &format!("f{i}"),
                &vec![0u8; 40],
                "bin",
                None,
                100,
                500,
            );
            assert!(out.is_archived(), "第 {i} 条应归档成功: {out:?}");
        }
        let entries = list_archives(&app);
        assert_eq!(entries.len(), 2, "只应剩 2 条（80 ≤ 100，再加一条就超）");
        assert_eq!(archive_total_bytes(&app), 80, "总占用不得超上限");
        assert!(
            entries.iter().all(|e| e.source_id != "s0"),
            "最旧的 s0 应被淘汰，实际留下: {:?}",
            entries.iter().map(|e| &e.source_id).collect::<Vec<_>>()
        );
        // 被淘汰的快照，磁盘文件也要一起清掉，不能只删索引留孤儿
        let orphans = fs::read_dir(archives_dir(&app))
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".bin"))
            .count();
        assert_eq!(orphans, 2, "磁盘上不应留下被淘汰的孤儿文件");
    }

    /// 单文件就超配额 ⇒ 明确拒绝，而不是收进去再立刻把自己淘汰。
    #[test]
    fn rejects_single_file_over_limit() {
        let app = tmp_dir("too_large");
        let out = archive_snapshot_with_limit(
            &app,
            "file",
            "big",
            "big.bin",
            &vec![0u8; 200],
            "bin",
            None,
            100,
            500,
        );
        assert!(matches!(out, ArchiveOutcome::TooLarge { .. }), "应返回 TooLarge");
        assert!(out.notice().is_some(), "必须有一句能给用户看的说明");
        assert!(list_archives(&app).is_empty());
    }

    /// 旧 manifest（没有 originPath 字段）必须还能读——不能因为加了字段就打不开回收站。
    #[test]
    fn legacy_manifest_without_origin_path_still_loads() {
        let app = tmp_dir("legacy_manifest");
        let dir = archives_dir(&app);
        fs::create_dir_all(&dir).unwrap();
        let legacy = r#"[{"id":"20240101_000000_abc","kind":"file","sourceId":"s","name":"n.txt","ext":"txt","size":3,"modified":"20240101_000000"}]"#;
        fs::write(dir.join("manifest.json"), legacy).unwrap();

        let entries = list_archives(&app);
        assert_eq!(entries.len(), 1, "旧格式必须能解析");
        assert_eq!(entries[0].origin_path, None);
    }
}