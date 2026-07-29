//! 本地云上下文聚合（T2 / T4 入口持有）。
//!
//! 汇集三个 local-only 默认实现（账户 / 存储 / 同步），作为「一张网宿主」在移动端
//! 启动时持有的云就绪句柄占位。后续接入真实后端时，仅需替换此处的具体实现类型。

use super::account::{AccountProvider, LocalAccountProvider};
use super::storage::LocalBackend;
use super::sync::LocalSync;
use std::path::PathBuf;

/// 本地云上下文：三个 local-only 默认实现的容器。
#[derive(Debug, Default)]
pub struct LocalCloudContext {
    pub account: LocalAccountProvider,
    pub storage: LocalBackend,
    pub sync: LocalSync,
}

impl LocalCloudContext {
    /// 以指定本地存储根目录创建上下文（默认空根，等价于 `Default`）。
    pub fn new(storage_root: PathBuf) -> Self {
        Self {
            account: LocalAccountProvider::new(),
            storage: LocalBackend::new(storage_root),
            sync: LocalSync,
        }
    }

    /// 便捷访问：当前账户快照。
    pub fn account_info(&self) -> super::account::AccountInfo {
        self.account.current()
    }

    /// 便捷访问：本地存储后端引用。
    pub fn storage(&self) -> &LocalBackend {
        &self.storage
    }

    /// 便捷访问：本地同步后端引用。
    pub fn sync(&self) -> &LocalSync {
        &self.sync
    }
}
