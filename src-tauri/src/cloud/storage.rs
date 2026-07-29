//! 远端存储抽象（RemoteStorage）与 v1 local-only 默认实现（LocalBackend）。
//!
//! v1 `backend_kind` = `Local`：实际落盘到应用数据目录下的 cloud 子目录（Android 上即内部存储 / SAF 占位）。

use super::{BackendKind, CloudError};
use std::path::PathBuf;

/// 远端存储对象元信息。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectMeta {
    pub key: String,
    pub size: u64,
    pub modified: u64, // unix millis
}

/// 远端存储抽象。
///
/// 设计要点（与架构契约一致）：
/// - `backend_kind` 默认返回 `Local`（v1 仅本地）。
/// - `read` / `write` / `list` / `delete` 默认实现应由具体后端提供；
///   本 trait 不提供默认实现，强制各后端显式声明行为。
pub trait RemoteStorage {
    /// 当前后端形态（v1 = Local）。
    fn backend_kind(&self) -> BackendKind {
        BackendKind::Local
    }

    /// 读取对象。
    fn read(&self, key: &str) -> Result<Vec<u8>, CloudError>;

    /// 写入对象。
    fn write(&self, key: &str, data: &[u8]) -> Result<(), CloudError>;

    /// 列举指定前缀下的对象。
    fn list(&self, prefix: &str) -> Result<Vec<ObjectMeta>, CloudError>;

    /// 删除对象。
    fn delete(&self, key: &str) -> Result<(), CloudError>;
}

/// v1 本地后端（内部存储占位，实际落盘到 `root` 目录）。
///
/// 不做任何网络请求；可在 Android 上以应用内部存储目录或 SAF 树 URI 对应的本地路径作为 `root`。
#[derive(Debug, Default, Clone)]
pub struct LocalBackend {
    root: PathBuf,
}

impl LocalBackend {
    /// 以本地根目录创建后端。
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
}

impl RemoteStorage for LocalBackend {
    fn read(&self, key: &str) -> Result<Vec<u8>, CloudError> {
        let p = self.root.join(key);
        std::fs::read(&p).map_err(|e| CloudError::Io(e.to_string()))
    }

    fn write(&self, key: &str, data: &[u8]) -> Result<(), CloudError> {
        let p = self.root.join(key);
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&p, data).map_err(|e| CloudError::Io(e.to_string()))
    }

    fn list(&self, prefix: &str) -> Result<Vec<ObjectMeta>, CloudError> {
        let base = self.root.join(prefix);
        let mut out = Vec::new();
        if let Ok(entries) = std::fs::read_dir(&base) {
            for e in entries.flatten() {
                if let Ok(meta) = e.metadata() {
                    if meta.is_file() {
                        let key = e
                            .path()
                            .strip_prefix(&self.root)
                            .map(|p| p.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        let modified = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0);
                        out.push(ObjectMeta {
                            key,
                            size: meta.len(),
                            modified,
                        });
                    }
                }
            }
        }
        Ok(out)
    }

    fn delete(&self, key: &str) -> Result<(), CloudError> {
        let p = self.root.join(key);
        std::fs::remove_file(&p).map_err(|e| CloudError::Io(e.to_string()))
    }
}
