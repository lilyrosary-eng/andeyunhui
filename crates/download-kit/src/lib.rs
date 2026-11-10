//! 多引擎下载内核（download-kit）。
//!
//! ## 设计目标
//! 对齐 IDM 蓝图里的核心算法（分块 Range、分片状态持久化、UA/Referer/Cookie 透传、
//! 失败重试、队列调度），但把「传输实现」抽成可替换引擎：
//!
//! - `native`：纯 Rust 内置引擎，Range 多连接 + 分片临时文件 + 断点续传；
//! - `aria2`：调用用户自备的 aria2c（不随包分发，避免 GPLv2 分发义务）；
//! - `ffmpeg`：调用随包 ffmpeg，负责 HLS(m3u8) 与本地分段合并。
//!
//! ## 为什么独立成 crate
//! 与笔记 / 音乐 / 视频等宿主业务无关；`Cargo.toml` 去掉一行依赖 + `main.rs` 去掉命令注册
//! 即可整体拆卸。命令统一使用 `dl_` 前缀，避免与宿主既有命令冲突。
//!
//! ## 持久化
//! 任务与分片落 `<app_data>/download-kit/tasks.db`（SQLite，WAL）。
//! 分片记录对应 IDM 的 `ChList`：进程重启后可按各分片已下载字节继续。
//!
//! ## 当前边界
//! - 只做后端引擎层，不含 UI；
//! - 不实现浏览器扩展 / Native Messaging / 驱动拦截等捕获通道；
//! - 不做站点抓取（Grabber）、磁力 / BT 解析。

pub mod commands;
pub mod config;
pub mod engine;
pub mod manager;
pub mod probe;
pub mod store;
pub mod types;
mod util;

pub use manager::DownloadManager;
pub use types::*;

/// 任务进度事件（高频，约 350ms 一次）。
pub const EVENT_PROGRESS: &str = "download-kit:progress";
/// 任务状态事件（入队 / 开始 / 暂停 / 完成 / 失败 / 取消）。
pub const EVENT_STATE: &str = "download-kit:state";
