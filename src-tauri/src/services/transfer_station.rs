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
}

/// 存档上限：超出后丢弃最旧快照（连同文件），避免无限增长。
const MAX_ARCHIVES: usize = 300;

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

/// 生成一份存档快照（核心，供 Rust 内部与 Tauri 命令共用）。
/// 返回写入的文件名（含扩展名）；失败返回 None。
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
    let dir = archives_dir(app_data);
    let _ = fs::create_dir_all(&dir);
    let ts = Utc::now().format("%Y%m%d_%H%M%S").to_string();
    let id = format!("{}_{}", ts, Uuid::new_v4().simple());
    let ext = if ext.is_empty() { "bin" } else { ext };
    let fname = format!("{}.{}", id, ext);
    let path = dir.join(&fname);
    if fs::write(&path, content).is_err() {
        return None;
    }
    let entry = ArchiveEntry {
        id: id.clone(),
        kind: kind.to_string(),
        source_id: source_id.to_string(),
        name: name.to_string(),
        ext: ext.to_string(),
        size: content.len() as u64,
        modified: ts,
    };

    let mut entries = load_archive_manifest(app_data);
    // 覆盖同 (kind, source_id) 的旧快照，保持每个来源只一份存档
    for old in entries.iter().filter(|e| e.kind == kind && e.source_id == source_id) {
        let _ = fs::remove_file(dir.join(format!("{}.{}", old.id, old.ext)));
    }
    entries.retain(|e| !(e.kind == kind && e.source_id == source_id));

    // 上限保护：超出部分丢弃最旧（含磁盘文件）
    if entries.len() >= MAX_ARCHIVES {
        let remove = entries.len() - MAX_ARCHIVES + 1;
        let dropped: Vec<ArchiveEntry> = entries.drain(0..remove).collect();
        for d in &dropped {
            let _ = fs::remove_file(dir.join(format!("{}.{}", d.id, d.ext)));
        }
    }
    entries.push(entry);
    let _ = save_archive_manifest(app_data, &entries);
    eprintln!(
        "[TransferStation] 存档快照: kind={}, name={}, id={}, size={}",
        kind, name, id, content.len()
    );
    Some(fname)
}

/// 列出所有存档快照（最新在前）。
pub fn list_archives(app_data: &Path) -> Vec<ArchiveEntry> {
    let mut entries = load_archive_manifest(app_data);
    entries.reverse();
    entries
}

/// 恢复存档：按 kind 写回原位置（笔记 → notes 目录；文件/图片 → 中转站暂存目录）。
pub fn restore_archive(app_data: &Path, id: &str) -> Result<(), String> {
    let entries = load_archive_manifest(app_data);
    let entry = entries
        .iter()
        .find(|e| e.id == id)
        .ok_or_else(|| "存档不存在".to_string())?;
    let src = archives_dir(app_data).join(format!("{}.{}", entry.id, entry.ext));
    let content = fs::read(&src).map_err(|e| format!("读取存档失败: {}", e))?;

    let dest = if entry.kind == "note" {
        app_data.join("notes").join(format!("{}.md", entry.source_id))
    } else {
        transfer_station_dir(app_data)
            .join("dropzone")
            .join(format!("{}.{}", entry.source_id, entry.ext))
    };
    if let Some(parent) = dest.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&dest, &content).map_err(|e| format!("恢复失败: {}", e))?;
    eprintln!("[TransferStation] 恢复存档: id={}, -> {:?}", id, dest);
    Ok(())
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
}