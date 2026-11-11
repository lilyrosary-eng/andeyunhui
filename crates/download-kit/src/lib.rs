//! 多引擎下载内核（download-kit）。
//!
//! ## 设计目标
//! 只用公开的 HTTP 标准能力（`Range`、`Content-Length`、`Content-Range`）实现传输内核，
//! 覆盖分片并行、断点续传、UA/Referer/Cookie 透传、失败重试与队列调度；
//! 传输实现抽成可替换引擎，按任务或全局配置切换：
//!
//! - 综合下载引擎1（`native`）：内置分块多连接，跨平台；
//! - 综合下载引擎2（`simple`）：内置单连接兼容模式，适配拒绝多连接/分段的站点；
//! - `aria2`：调用用户自备的 aria2c（不随包分发，避免 GPLv2 分发义务）；
//! - `ffmpeg`：HLS(m3u8) 拉流转封装与本地分段拼接；
//! - `curl` / `wget`：调用系统已有工具，单连接 + 原生续传，作为兼容兜底；
//! - `gopeed`：调用用户自备的 gopeed（GPL-3.0，不随包分发），补足 BT / 磁力 / ed2k。
//!
//! 传输能力还包括：单任务限速与全局聚合限速、HTTP/SOCKS 代理、主源失败时切换镜像、
//! 完成后校验（MD5 / SHA-1 / SHA-256）、续传前 ETag/Last-Modified 比对、下载前磁盘空间预检；
//! 调度按 `priority` 从高到低，同优先级 FIFO。HTTP/2 由 reqwest 协商，
//! 多连接仍由引擎1 的分片并发承担。
//!
//! ## 为什么独立成 crate
//! 与笔记 / 音乐 / 视频等宿主业务无关；`Cargo.toml` 去掉一行依赖 + `main.rs` 去掉命令注册
//! 即可整体拆卸。命令统一使用 `dl_` 前缀，避免与宿主既有命令冲突。
//!
//! ## 持久化
//! 任务与分片落 `<app_data>/download-kit/tasks.db`（SQLite，WAL）。
//! 分片记录就是分片清单（每片的 `start/end/downloaded/state`），
//! 进程重启后可按各分片已下载字节继续。
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
