//! 云同步抽象（CloudSync）与 v1 空实现（LocalSync）。
//!
//! v1 不接真实同步：`pull` / `push` 返回空 Delta，`configure` / `resolve` 返回 `Unsupported`。
//! 预留 `SyncTarget` 三形态扩展点（SelfHosted / FileBackend / ThirdParty）。

use super::{BackendKind, CloudError};

/// 同步目标三形态扩展点（v1 仅预留，不实现）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncTarget {
    /// 自托管服务。
    SelfHosted { url: String },
    /// 文件后端（如 S3 兼容 / 网盘）。
    FileBackend { bucket: String },
    /// 第三方云（如 OneDrive / 坚果云）。
    ThirdParty { provider: String },
}

/// 一次同步的增量结果（v1 空实现返回空 Delta）。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncDelta {
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub removed: Vec<String>,
}

/// 云同步抽象。
///
/// 设计要点（与架构契约一致）：
/// - `backend_kind` 默认返回 `Local`（v1 仅本地）。
/// - `pull` / `push` 默认实现返回空 Delta（无网络）。
/// - `configure` / `resolve` 默认实现返回 `Unsupported`（v1 不接真实同步）。
pub trait CloudSync {
    /// 当前后端形态（v1 = Local）。
    fn backend_kind(&self) -> BackendKind {
        BackendKind::Local
    }

    /// 配置同步目标（v1 仅接受 Local，其余返回 Unsupported）。
    fn configure(&mut self, _target: SyncTarget) -> Result<(), CloudError> {
        Err(CloudError::Unsupported(
            "configure 在 v1 local-only 中不可用".into(),
        ))
    }

    /// 拉取远端变更（v1 返回空 Delta）。
    fn pull(&self) -> Result<SyncDelta, CloudError> {
        Ok(SyncDelta::default())
    }

    /// 推送本地变更（v1 返回空 Delta）。
    fn push(&self, _changes: &[String]) -> Result<SyncDelta, CloudError> {
        Ok(SyncDelta::default())
    }

    /// 冲突解决（v1 占位，返回 Unsupported）。
    fn resolve(&self, _key: &str, _strategy: &str) -> Result<(), CloudError> {
        Err(CloudError::Unsupported(
            "resolve 在 v1 local-only 中不可用".into(),
        ))
    }
}

/// v1 本地同步占位（空实现）。
#[derive(Debug, Default, Clone)]
pub struct LocalSync;

impl CloudSync for LocalSync {}
