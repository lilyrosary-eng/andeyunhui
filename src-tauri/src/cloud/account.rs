//! 账户提供方抽象（AccountProvider）与 v1 local-only 默认实现。
//!
//! v1 仅支持本地账户（LocalOnly）：`sign_in` 返回 `Unsupported`，不发起任何远程鉴权。

use super::{BackendKind, CloudError};

/// 账户状态。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum AccountStatus {
    /// 已登出。
    #[default]
    SignedOut,
    /// 仅本地账户（v1 默认）。
    LocalOnly,
    /// 已登录远程账户。
    SignedIn { provider: String, user: String },
}

/// 当前账户快照。
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AccountInfo {
    pub status: AccountStatus,
    pub provider: Option<String>,
    pub user: Option<String>,
}

/// 账户提供方抽象。
///
/// 设计要点（与架构契约一致）：
/// - `backend_kind` 默认返回 `Local`（v1 仅本地）。
/// - `sign_in` 默认实现返回 `Unsupported`——v1 不接远程鉴权。
/// 实现方（如后续 SelfHosted 后端）可覆写 `sign_in` 以接入真实流程。
pub trait AccountProvider {
    /// 当前后端形态（v1 = Local）。
    fn backend_kind(&self) -> BackendKind {
        BackendKind::Local
    }

    /// 当前账户状态。
    fn status(&self) -> AccountStatus;

    /// 当前账户快照。
    fn current(&self) -> AccountInfo;

    /// 登录（v1 不支持远程登录，返回 Unsupported）。
    fn sign_in(&self, _provider: &str, _token: &str) -> Result<AccountInfo, CloudError> {
        Err(CloudError::Unsupported(
            "sign_in 在 v1 local-only 中不可用".into(),
        ))
    }
}

/// v1 本地账户提供方（local-only）。
#[derive(Debug, Default)]
pub struct LocalAccountProvider;

impl LocalAccountProvider {
    /// 创建本地账户提供方（初始为 LocalOnly）。
    pub fn new() -> Self {
        Self::default()
    }
}

impl AccountProvider for LocalAccountProvider {
    fn status(&self) -> AccountStatus {
        AccountStatus::LocalOnly
    }

    fn current(&self) -> AccountInfo {
        // v1 local-only：始终回报一个本地账户快照（未接任何远程鉴权）。
        AccountInfo {
            status: AccountStatus::LocalOnly,
            provider: Some("local".into()),
            user: Some("local".into()),
        }
    }
}
