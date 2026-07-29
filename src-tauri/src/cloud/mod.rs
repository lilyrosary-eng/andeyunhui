//! 云就绪 stub（T3）：Account / RemoteStorage / CloudSync 三大抽象。
//!
//! 本模块跨平台（Windows 与 Android 共管），v1 仅提供 local-only 默认实现：
//! 不接任何真实后端、不发起任何网络请求；所有「云端能力」返回 `Unsupported` 或本地落盘占位。
//! T4+ 可在此基础上接入真实后端（SelfHosted / FileBackend / ThirdParty）。

pub mod account;
pub mod local;
pub mod storage;
pub mod sync;

/// 云操作统一错误类型（v1 仅含 Unsupported 与 IO 两类）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloudError {
    /// 当前 v1 未实现该云端能力（local-only）。
    Unsupported(String),
    /// 本地落盘 IO 错误。
    Io(String),
}

impl std::fmt::Display for CloudError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CloudError::Unsupported(m) => write!(f, "unsupported: {m}"),
            CloudError::Io(m) => write!(f, "io error: {m}"),
        }
    }
}

impl std::error::Error for CloudError {}

/// 后端形态枚举（预留扩展点，T4+ 接入真实后端时扩展变体）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendKind {
    /// 本地存储 / SAF 占位（v1 默认）。
    Local,
    /// 自托管服务（后续扩展）。
    SelfHosted,
    /// 文件后端（后续扩展，如 S3 兼容 / 网盘）。
    FileBackend,
    /// 第三方云（后续扩展，如 OneDrive / 坚果云）。
    ThirdParty,
}

#[cfg(test)]
mod tests;
