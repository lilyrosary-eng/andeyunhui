//! 启动守卫命令外壳（实现见 `services/boot_guard.rs`）。
//!
//! `boot_guard_startup` 在 `main.rs` 的 setup 里调用，不暴露给前端；
//! 另外两条命令给前端：读状态 / 首屏成功后确认。

use tauri::AppHandle;

use crate::services::boot_guard;

/// 启动时执行：计数 +1，必要时自动回滚插件启用集合。
///
/// 必须在 `data_location::prepare_data_root` 之后调用 —— 数据目录可能被重定向，
/// 提前读会读到旧位置的状态，回滚基线就错了。
pub fn boot_guard_startup(app: &AppHandle) {
    let state = boot_guard::on_start(app);

    if boot_guard::is_safe_mode() {
        log::warn!("[boot_guard] 安全模式启动：本轮不加载任何插件");
        return;
    }
    if !boot_guard::needs_rollback(&state) {
        return;
    }

    let disabled = crate::commands::plugins::auto_rollback_to(app, &state.last_ok_plugins);
    log::warn!(
        "[boot_guard] 连续 {} 次启动未确认，自动回滚启用集合：{:?}",
        state.attempts,
        disabled
    );
    boot_guard::record_rollback(app, disabled);
}

/// 前端启动时读取：是否需要安全模式、上次回滚禁用了哪些插件。
#[tauri::command]
pub fn boot_guard_state(app: AppHandle) -> serde_json::Value {
    let state = boot_guard::load(&app);
    serde_json::json!({
        "attempts": state.attempts,
        "lastOkAt": state.last_ok_at,
        "lastOkPlugins": state.last_ok_plugins,
        "lastRollback": state.last_rollback,
        // 命令行安全模式，或回滚救不回来后的强制安全模式
        "safeMode": boot_guard::is_safe_mode() || state.force_safe_mode,
        "forceSafeMode": state.force_safe_mode,
    })
}

/// 前端首屏渲染成功后确认「能启动」，清零失败计数。
/// 传 `pluginIds` 时同时更新「上次成功插件集合」，作为下次自动回滚的基线。
#[tauri::command]
pub fn boot_guard_ok(app: AppHandle, plugin_ids: Option<Vec<String>>) {
    boot_guard::mark_ok(&app, plugin_ids);
}

/// 用户手动恢复某个被自动禁用的插件后，把它从提示名单里移除。
#[tauri::command]
pub fn boot_guard_clear_rollback(app: AppHandle, plugin_id: String) {
    boot_guard::clear_rollback_entry(&app, &plugin_id);
}

/// 退出强制安全模式（清除标记与回滚提示），前端随后 reload 让插件重新加载。
/// 只对「回滚无效后强制置位」有效；命令行 `--safe-mode` 由启动参数决定，清不掉。
#[tauri::command]
pub fn boot_guard_exit_safe_mode(app: AppHandle) {
    let mut state = boot_guard::load(&app);
    state.force_safe_mode = false;
    state.last_rollback.clear();
    state.attempts = 0;
    if let Err(e) = boot_guard::save(&app, &state) {
        log::warn!("[boot_guard] 退出安全模式落盘失败: {e}");
    }
}
