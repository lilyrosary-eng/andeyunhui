//! PAL 桩：非 Windows 下 SMTC（系统媒体传输控制）占位。
//!
//! SMTC（WinRT SystemMediaTransportControls）是 Windows 专属能力。非 Windows 目标无该后端，
//! 本文件通过 `lib.rs` 的 `#[cfg(not(windows))]` 路径替换接管 `smtc` 模块，提供与真实实现
//! 「同名」的公共 API，但所有函数返回空实现，保证模块在非 Windows 目标下可编译。

#![allow(dead_code)]

use tauri::AppHandle;

/// 媒体键事件投递给前端的载荷（与 Windows 实现同名字段）。
#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct SmtcControl {
    pub action: String,
    pub target: String,
}

/// 前端推送到 Rust 的媒体状态（与 Windows 实现同名字段）。
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, Default)]
pub struct SmtcUpdate {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub cover_path: Option<String>,
    pub media_type: String,
    pub is_playing: bool,
    pub can_prev: bool,
    pub can_next: bool,
    pub source: Option<String>,
    pub key: Option<String>,
}

/// 诊断用：Rust 端 SMTC 会话的真实运行状态（与 Windows 实现同名字段）。
#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct SmtcStatus {
    pub session_created: bool,
    pub window_aumid_set: bool,
    pub aumid: String,
    pub process_aumid: String,
    pub active_module: String,
    pub last_music_title: String,
    pub last_video_title: String,
    pub last_status_playing: Option<bool>,
    pub is_enabled: bool,
    pub playback_status: String,
    pub actual_top_aumid: String,
    pub reg_displayname: String,
    pub system_sessions: Vec<String>,
}

/// 精简诊断（与 Windows 实现同名字段）。
#[derive(serde::Serialize, Clone, Debug, Default)]
pub struct SmtcDiag {
    pub session_created: bool,
    pub process_aumid: String,
    pub actual_top_aumid: String,
}

pub fn init_smtc(_app: AppHandle) {}

pub fn ensure_app_identity() {}

pub fn smtc_update(_app: AppHandle, _info: SmtcUpdate) {}

pub fn smtc_list_sessions() -> Vec<SmtcUpdate> {
    Vec::new()
}

pub fn smtc_control(_app: AppHandle, _action: String, _target: String) {}

pub fn set_active_module(_module: String) {}

pub fn set_window_hidden(_hidden: bool) {}

pub fn debug_log(_msg: String) {}
