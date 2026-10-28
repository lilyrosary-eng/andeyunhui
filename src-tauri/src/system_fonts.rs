//! 枚举系统已安装字体族（Linux：fontconfig `fc-list`）。
//!
//! 为什么需要：前端原有两条路 —— `queryLocalFonts()`（Chromium 私有 API，WebKitGTK 没有）
//! 和「用 document.fonts 验证一份**硬编码候选表**」。于是 Linux 上只能看到候选表里那几个，
//! 用户自己装的字体（~/.local/share/fonts 等）根本不会出现，设置里换不了
//! （2026-10-28 用户反馈）。
//! fontconfig 是 GTK 环境必备，直接问它最准；取不到时返回空表，前端仍走原回退。

use std::collections::BTreeSet;
use std::process::Command;

/// 返回排序去重后的字体族名（含中文名的会被保留为 fontconfig 的原始写法）。
#[tauri::command]
pub fn list_system_fonts() -> Vec<String> {
    #[cfg(unix)]
    {
        let out = match Command::new("fc-list").args([":", "family"]).output() {
            Ok(o) => o,
            Err(_) => return Vec::new(),
        };
        if !out.status.success() {
            return Vec::new();
        }
        let text = String::from_utf8_lossy(&out.stdout);
        let mut set: BTreeSet<String> = BTreeSet::new();
        for line in text.lines() {
            // 一行可能是 "Family1,Family2" （同一字体的多个别名）
            for fam in line.split(',') {
                let f = fam.trim();
                if !f.is_empty() && f.len() < 120 {
                    set.insert(f.to_string());
                }
            }
        }
        return set.into_iter().collect();
    }
    #[cfg(not(unix))]
    {
        Vec::new()
    }
}
