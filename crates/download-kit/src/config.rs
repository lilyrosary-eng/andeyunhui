//! 配置读写：`<base>/config.json`。
//!
//! 用 JSON 而不是 SQLite：配置量小、用户可手工编辑、便于备份；
//! 任务与分片（写入频繁、需要事务）才进数据库。

use std::path::Path;

use crate::types::EngineConfig;

const FILE_NAME: &str = "config.json";

pub fn load(base: &Path) -> EngineConfig {
    let path = base.join(FILE_NAME);
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str::<EngineConfig>(&raw)
            .map(EngineConfig::normalize)
            .unwrap_or_else(|e| {
                eprintln!("[download-kit] 配置解析失败，使用默认值: {e}");
                EngineConfig::default()
            }),
        Err(_) => EngineConfig::default(),
    }
}

pub fn save(base: &Path, config: &EngineConfig) -> Result<(), String> {
    std::fs::create_dir_all(base)
        .map_err(|e| format!("创建下载配置目录失败 {}: {e}", base.display()))?;
    let path = base.join(FILE_NAME);
    let raw = serde_json::to_string_pretty(config)
        .map_err(|e| format!("序列化下载配置失败: {e}"))?;
    std::fs::write(&path, raw)
        .map_err(|e| format!("写入下载配置失败 {}: {e}", path.display()))
}
