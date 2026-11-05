//! AI 协作组态后端内核（P0）。
//!
//! ## 为什么独立成 crate
//! 这一层要回答的是「多个 harness agent 如何分派任务、交换消息、统一管理」，
//! 与笔记 / 音乐 / 视频等宿主业务无关。独立 crate 可以：
//! - 随 `Cargo.toml` 去掉一行依赖即可拆卸，不污染主 crate；
//! - 后续把 echo harness 换成 ACP / stream-json / .Talk 适配器时，宿主代码零改动；
//! - 单独测试任务状态机，不依赖 Tauri 窗口。
//!
//! ## 当前边界（P2）
//! - harness：`echo`（本地模拟）+ `dsh`（headless 一次性任务 + ACP 原位恢复）；
//! - 任务 runtime：创建、运行、进度、完成、取消、父子关系；
//! - 持久化落在 `<app_data>/ai-collab/`，事件为按房间追加的 NDJSON；
//! - 绑定了 workspace 的房间同时镜像到 `<workspace>/.adyh/collab/`，并支持 `inbox/` 外部投递。
//!
//! P3 继续补：ACP 权限桥接/流式细粒度、stream-json 适配器、预算与重启恢复、组态画布。

pub mod acp_client;
pub mod commands;
pub mod dsh_sessions;
pub mod harness;
pub mod runtime;
pub mod store;
pub mod types;
