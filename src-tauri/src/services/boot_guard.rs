//! 启动守卫（boot guard）：连续启动失败时自动回滚「插件启用集合」。
//!
//! 背景：插件与配置允许被 AI / 用户直接改写，改坏后最坏结果是主界面起不来。
//! 这里**不备份文件**，只记录「上一次成功启动时实际加载的插件集合」：
//! 连续 [`MAX_ATTEMPTS`] 次没等到前端确认，下次启动就把多出来的插件禁用掉。
//! 相比整目录回滚，这种做法损失最小，目标也明确 —— 主程序一定能起来。
//!
//! 状态文件：`<AppData>/boot_guard.json`（与 `plugin_visibility.json` 同目录）。
//! 正常关闭不会累积计数：主界面渲染成功会立刻清零（见 `boot_guard_ok`）。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 连续多少次「启动未确认」判定为失败。
/// 取 2：第一次没起来不计较，第二次启动直接回滚，避免用户在坏版本上反复试。
/// 正常运行不受影响 —— 首屏渲染成功就清零，不会累积。
const MAX_ATTEMPTS: u32 = 2;
const FILE_NAME: &str = "boot_guard.json";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BootState {
    /// 连续未确认的启动次数
    #[serde(default)]
    pub attempts: u32,
    /// 上次成功启动的时间（秒）
    #[serde(default)]
    pub last_ok_at: u64,
    /// 上次成功启动时实际加载的插件 id
    #[serde(default)]
    pub last_ok_plugins: Vec<String>,
    /// 上一次自动回滚禁用的插件（前端提示用，用户手动恢复后清除）
    #[serde(default)]
    pub last_rollback: Vec<String>,
    /// 回滚也救不回来时置位：下次启动直接不加载任何插件
    #[serde(default)]
    pub force_safe_mode: bool,
}

fn state_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取 app_data_dir 失败: {e}"))?;
    Ok(dir.join(FILE_NAME))
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub fn load(app: &AppHandle) -> BootState {
    let Ok(path) = state_path(app) else {
        return BootState::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, state: &BootState) -> Result<(), String> {
    let path = state_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建 app_data_dir 失败: {e}"))?;
    }
    let json = serde_json::to_string_pretty(state).map_err(|e| format!("序列化失败: {e}"))?;
    // 原子替换：先写 .tmp 再 rename。半截 JSON 会被 load 读成 default，
    // 那等于丢掉 last_ok_plugins —— 回滚基线没了，比不写更糟。
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("写入 boot_guard.json 失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换 boot_guard.json 失败: {e}"))?;
    Ok(())
}

/// 启动时调用：计数 +1 并落盘，返回累计状态。
pub fn on_start(app: &AppHandle) -> BootState {
    let mut state = load(app);
    state.attempts = state.attempts.saturating_add(1);
    if let Err(e) = save(app, &state) {
        log::warn!("[boot_guard] 启动计数落盘失败（本轮自动回滚不可用）: {e}");
    }
    state
}

/// 是否已连续失败到需要回滚。
pub fn needs_rollback(state: &BootState) -> bool {
    state.attempts >= MAX_ATTEMPTS
}

/// 前端首屏渲染成功后调用：清零计数。
/// `plugin_ids` 有值时才更新「上次成功插件集合」——首屏只证明"人能进来"，
/// 插件（可能很慢/卡死）不应该阻塞这条保命确认。
pub fn mark_ok(app: &AppHandle, plugin_ids: Option<Vec<String>>) {
    let mut state = load(app);
    state.attempts = 0;
    state.last_ok_at = now_secs();
    if let Some(ids) = plugin_ids {
        state.last_ok_plugins = ids;
        // 插件能正常加载 = 已从故障中恢复，解除最后一道强制安全模式
        state.force_safe_mode = false;
    }
    if let Err(e) = save(app, &state) {
        log::warn!("[boot_guard] 启动确认落盘失败: {e}");
    }
}

/// 记录一次自动回滚。`disabled` 为空说明当前启用集合已经 ⊆ 成功基线，
/// 回滚救不回来（坏的不在插件里），置位 force_safe_mode 作为最后一道闸门。
pub fn record_rollback(app: &AppHandle, disabled: Vec<String>) {
    let mut state = load(app);
    state.attempts = 0;
    state.last_rollback = disabled.clone();
    if disabled.is_empty() {
        state.force_safe_mode = true;
    }
    if let Err(e) = save(app, &state) {
        log::warn!("[boot_guard] 回滚结果落盘失败: {e}");
    }
}

/// 用户手动恢复某个被自动禁用的插件后，从提示名单里移除它。
pub fn clear_rollback_entry(app: &AppHandle, plugin_id: &str) {
    let mut state = load(app);
    let before = state.last_rollback.len();
    state.last_rollback.retain(|id| id != plugin_id);
    if state.last_rollback.len() != before {
        let _ = save(app, &state);
    }
}

/// 是否以安全模式启动（命令行带 `--safe-mode`）。
/// 安全模式不加载任何插件，只保证主界面可用。
pub fn is_safe_mode() -> bool {
    std::env::args().any(|a| a == "--safe-mode" || a == "--safe")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needs_rollback_after_two_unconfirmed_starts() {
        let mut s = BootState::default();
        s.attempts = 1;
        assert!(!needs_rollback(&s));
        s.attempts = 2;
        assert!(needs_rollback(&s));
    }

}
