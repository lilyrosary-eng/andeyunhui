//! 密码库命令层：async + spawn_blocking 包装。
//!
//! 为什么要 async：scrypt 解锁（默认 log_n=15，约 32MB / 百毫秒级）与文件 IO 都是阻塞的，
//! Tauri v2 的同步命令跑在主线程，直接执行会让窗口在这段时间里无响应。
//! 与 rag_commands 同一口径：同步 IO 一律丢到阻塞线程池。

use crate::services::vault_service::{
    self as svc, AuditEntry, CreateOutcome, RedeemOutcome, VaultItem, VaultStatus,
};
use tauri::AppHandle;

async fn blocking<T, F>(task: &'static str, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("{task} 任务异常: {e}"))?
}

#[tauri::command]
pub async fn vault_status(app: AppHandle) -> Result<VaultStatus, String> {
    blocking("vault_status", move || svc::status(&app)).await
}

#[tauri::command]
pub async fn vault_create(
    app: AppHandle,
    password: String,
    enable_device_unlock: Option<bool>,
    auto_lock_min: Option<u32>,
) -> Result<CreateOutcome, String> {
    blocking("vault_create", move || {
        svc::create(
            &app,
            &password,
            enable_device_unlock.unwrap_or(true),
            auto_lock_min,
        )
    })
    .await
}

#[tauri::command]
pub async fn vault_unlock(app: AppHandle, password: String) -> Result<VaultStatus, String> {
    blocking("vault_unlock", move || svc::unlock(&app, &password)).await
}

#[tauri::command]
pub async fn vault_unlock_device(app: AppHandle) -> Result<VaultStatus, String> {
    blocking("vault_unlock_device", move || svc::unlock_device(&app)).await
}

#[tauri::command]
pub async fn vault_lock(app: AppHandle) -> Result<VaultStatus, String> {
    blocking("vault_lock", move || svc::lock(&app)).await
}

#[tauri::command]
pub async fn vault_change_password(
    app: AppHandle,
    current_password: String,
    new_password: String,
) -> Result<VaultStatus, String> {
    blocking("vault_change_password", move || {
        svc::change_password(&app, &current_password, &new_password)
    })
    .await
}

#[tauri::command]
pub async fn vault_rotate_recovery_codes(app: AppHandle) -> Result<Vec<String>, String> {
    blocking("vault_rotate_recovery_codes", move || {
        svc::rotate_recovery_codes(&app)
    })
    .await
}

#[tauri::command]
pub async fn vault_redeem_recovery(
    app: AppHandle,
    code: String,
    new_password: String,
) -> Result<RedeemOutcome, String> {
    blocking("vault_redeem_recovery", move || {
        svc::redeem_recovery(&app, &code, &new_password)
    })
    .await
}

#[tauri::command]
pub async fn vault_list(app: AppHandle) -> Result<Vec<VaultItem>, String> {
    blocking("vault_list", move || svc::list(&app)).await
}

#[tauri::command]
pub async fn vault_get_item(app: AppHandle, id: String) -> Result<VaultItem, String> {
    blocking("vault_get_item", move || svc::get_item(&app, &id)).await
}

#[tauri::command]
pub async fn vault_save_item(app: AppHandle, item: VaultItem) -> Result<VaultItem, String> {
    blocking("vault_save_item", move || svc::save_item(&app, item)).await
}

#[tauri::command]
pub async fn vault_delete_item(app: AppHandle, id: String, hard: Option<bool>) -> Result<(), String> {
    blocking("vault_delete_item", move || {
        svc::delete_item(&app, &id, hard.unwrap_or(false))
    })
    .await
}

#[tauri::command]
pub async fn vault_restore_item(app: AppHandle, id: String) -> Result<(), String> {
    blocking("vault_restore_item", move || svc::restore_item(&app, &id)).await
}

#[tauri::command]
pub async fn vault_empty_trash(app: AppHandle) -> Result<usize, String> {
    blocking("vault_empty_trash", move || svc::empty_trash(&app)).await
}

#[tauri::command]
pub async fn vault_mark_used(app: AppHandle, id: String) -> Result<(), String> {
    blocking("vault_mark_used", move || svc::mark_used(&app, &id)).await
}

#[tauri::command]
pub async fn vault_set_auto_lock(app: AppHandle, minutes: u32) -> Result<VaultStatus, String> {
    blocking("vault_set_auto_lock", move || {
        svc::set_auto_lock(&app, minutes)
    })
    .await
}

#[tauri::command]
pub async fn vault_audit_log(app: AppHandle, limit: Option<usize>) -> Result<Vec<AuditEntry>, String> {
    blocking("vault_audit_log", move || {
        svc::audit_log(&app, limit.unwrap_or(50))
    })
    .await
}

#[tauri::command]
pub async fn vault_export_json(app: AppHandle) -> Result<String, String> {
    blocking("vault_export_json", move || svc::export_json(&app)).await
}

#[tauri::command]
pub async fn vault_import_items(
    app: AppHandle,
    items: Vec<VaultItem>,
    mode: Option<String>,
) -> Result<usize, String> {
    blocking("vault_import_items", move || {
        svc::import_items(&app, items, mode.as_deref().unwrap_or("merge"))
    })
    .await
}
