use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use serde_json::Value;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use base64::Engine;
use crate::services::note_service;
use crate::services::workflow_service;
use crate::services::transfer_station;
use crate::services::image_service;
use crate::services::music_service;
use crate::services::video_service;
use crate::services::cache_service;
use crate::services::document_parser;
use crate::services::reading_service;
// RAG 共享后台服务命令子模块（rag_query / rag_ingest / rag_embed_api 等）
pub mod rag_commands;


// ========== 命令实现按领域拆分到 commands/ 子模块（P1-5，2026-10-18） ==========
// 子模块用 `use super::*` 共享本文件的 use；这里 `pub use` 回灌成扁平命名空间，
// 因此 main.rs 的 invoke_handler 与既有 `crate::commands::*` 引用都无需改动。
mod bootstrap;
pub use bootstrap::*;
mod notes;
pub use notes::*;
mod plugins;
pub use plugins::*;
mod transfer;
pub use transfer::*;
mod download;
pub use download::*;
mod images;
pub use images::*;
mod fs_dialog;
pub use fs_dialog::*;
mod music;
pub use music::*;
mod video_reading;
pub use video_reading::*;
mod dropzone;
pub use dropzone::*;
mod archive;
pub use archive::*;
mod storage_misc;
pub use storage_misc::*;
mod image_resolve;
pub use image_resolve::*;
mod wps;
pub use wps::*;
// spike：表格公式求值（gridcraft）
mod sheet;
pub use sheet::*;
mod install;
pub use install::*;
mod dev;
pub use dev::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_lt_normal_numeric_compare() {
        assert!(version_lt("1.2.3", "1.2.4"));
        assert!(!version_lt("1.2.4", "1.2.3"));
        assert!(!version_lt("1.2.3", "1.2.3"));
        // 逐段数值比较：1.10 > 1.9
        assert!(!version_lt("1.10", "1.9"));
        assert!(version_lt("1.9", "1.10"));
        assert!(version_lt("2", "10"));
    }

    #[test]
    fn version_lt_missing_segments_treated_as_zero() {
        assert!(!version_lt("1.0", "1.0.0"));
        assert!(!version_lt("1.0.1", "1.0")); // 1.0.1 > 1.0，不是小于
        assert!(!version_lt("1.2.3", "1.2"));
    }

    #[test]
    fn version_lt_non_numeric_segments_dropped() {
        // 非数字段被 filter_map 丢弃
        assert!(version_lt("1.2.a", "1.2.3"));
        assert!(!version_lt("1.2.3", "1.2.a"));
        // "v1" 全段非数字 → 视为 [0] 与 [1] 比较
        assert!(version_lt("v1", "1"));
    }

    #[test]
    fn version_lt_empty_strings() {
        assert!(!version_lt("", ""));
        assert!(version_lt("", "1"));
        assert!(!version_lt("1", ""));
    }
}
