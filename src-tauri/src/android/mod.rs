//! Android 平台入口（T2：PAL 隔离 + Tauri-Android 骨架；T4 充实为「一张网宿主」）。
//!
//! 本模块仅在 `target_os = "android"` 下编译（见 lib.rs 的 `#[cfg(target_os = "android")]`）。
//! 不引入任何 Windows 专属逻辑；仅搭建最小可用 Tauri-Android 入口：
//! - 创建 `tauri::Builder`；
//! - 注册跨平台命令（传输 + AI；Windows 专属命令如截图/SMTC/录屏/DComp 不注册）；
//! - 在 `setup` 中初始化传输管理器并自动开启服务 + 主动公告（对齐桌面 main.rs:325-333）。
//!
//! 全部 Android 专属代码通过 `#[cfg(target_os = "android")]` 隔离，Windows 构建不受影响。

pub mod dropzone;

/// Tauri-Android 应用入口。
///
/// 通过 `#[tauri::mobile_entry_point]` 在 Android 上生成 JNI/C FFI 入口，由 Java 侧调用。
/// 注册「传输 + AI」跨平台命令子集（桌面端 Windows-only 命令不在此注册，编译期隔离）。
#[tauri::mobile_entry_point]
pub fn run() {
    let builder = tauri::Builder::default();

    builder
        .invoke_handler(tauri::generate_handler![
            // ========== 局域网传输（黄金棋盘·传输，LocalSend v2 兼容）==========
            // 与桌面 main.rs 注册集一致；transfer.rs 已通过 cfg 门控排除桌面 dropzone 依赖，
            // T01 APK 构建已验证其在 Android 编译通过。
            crate::transfer::transfer_start,
            crate::transfer::transfer_stop,
            crate::transfer::transfer_announce,
            crate::transfer::transfer_status,
            crate::transfer::transfer_set_alias,
            crate::transfer::transfer_list_peers,
            crate::transfer::transfer_send,
            crate::transfer::transfer_get_save_dir,
            crate::transfer::transfer_set_save_dir,
            crate::transfer::transfer_get_staged,
            crate::transfer::transfer_set_staged,
            crate::transfer::transfer_get_auto_accept,
            crate::transfer::transfer_set_auto_accept,
            crate::transfer::transfer_receive_accept,
            crate::transfer::transfer_receive_decline,
            crate::transfer::transfer_add_peer,
            // ========== AI 能力（茑萝 · 让 T07 对话 Tab 在真机可用）==========
            // ai_service 是 services 子模块（见 lib.rs:54 `pub mod services`），路径为 crate::services::ai_service
            crate::services::ai_service::ai_get_profiles,
            crate::services::ai_service::ai_set_profiles,
            crate::services::ai_service::ai_set_profile_thinking,
            crate::services::ai_service::ai_chat,
            crate::services::ai_service::ai_test_connection,
            // ========== 伴侣（人机恋记忆点，阶段 1 + 1.5 多伴侣，Android 优先）==========
            crate::services::companion_service::companion_list,
            crate::services::companion_service::companion_get,
            crate::services::companion_service::companion_create,
            crate::services::companion_service::companion_update,
            crate::services::companion_service::companion_select,
            crate::services::companion_service::companion_delete,
            crate::services::companion_service::companion_add_memory,
            crate::services::companion_service::companion_apply_relationship,
            crate::services::companion_service::companion_proactive_message,
            crate::services::companion_service::ai_summarize_memory,
            // ========== RAG 语义记忆（阶段 4 · L3，复用桌面 rag_service）==========
            // 注意：commands 模块是桌面专属（lib.rs cfg 隔离），Android 用本地包装调用 rag_service。
            // 命令名与桌面 commands 层一致（rag_init_db 等），前端无需区分平台。
            rag_init_db,
            rag_ingest,
            rag_query,
            rag_list_sources,
            rag_delete_source,
            rag_embed_api,
            // ========== 多模态（阶段 5 · AI 发图 + 语音）==========
            crate::services::multimodal_service::ai_generate_image,
            crate::services::multimodal_service::ai_tts,
            // ========== Agent 工具（默认关闭，设置里开启）==========
            crate::services::agent_service::agent_tools_get,
            crate::services::agent_service::agent_tool_create,
            crate::services::agent_service::agent_tool_delete,
            crate::services::agent_service::agent_tool_list,
            // ========== 中转站（Dropzone）==========
            // 与桌面同一存储布局 <app_data>/transfer_station/dropzone/，
            // 桌面命令在 commands.rs（Windows 专属模块）内，故此处提供跨平台最小子集。
            dropzone::dropzone_list,
            dropzone::dropzone_read_text,
            dropzone::dropzone_delete,
            dropzone::dropzone_clear,
        ])
        .setup(|app| {
            // 初始化传输管理器并自动开启服务（对齐桌面 main.rs:325-333 的「开屏即常驻」语义）：
            // 保证两端服务常驻，接收/发送无需先手动打开传输面板；transfer_status 一开始就 running。
            crate::transfer::init(app.handle().clone());
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                crate::transfer::mgr().start().await;
                // 主动公告若干次，让对端在网络就绪后尽快发现本机
                // （否则两端都未公告则互不发现，发送目标为空）。
                crate::transfer::mgr().announce_now().await;
            });
            let _ = app_handle;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running 安得云荟 on Android");
}

// ========== RAG 语义记忆（阶段 4 · L3）Android 本地包装 ==========
// commands 模块在 Android 不编译（lib.rs cfg 隔离），这里用 AppHandle 值参数包装
// rag_service 的同名函数（rag_service 用 &AppHandle，Tauri command 需值参数）。

use crate::services::rag_service::{
    RagChunkInput, RagEmbedRequest, RagEmbedResponse, RagIngestResult, RagQueryResult,
    RagSourceInput, RagSourceInfo,
};

/// Android 端命令名与桌面 commands 层一致（`rag_init_db` 等），
/// 前端无需区分平台。桌面走 commands::rag_commands，Android 走本地包装。
#[tauri::command(rename_all = "camelCase")]
pub fn rag_init_db(app: tauri::AppHandle) -> Result<(), String> {
    crate::services::rag_service::rag_init_db(&app)
}

#[tauri::command(rename_all = "camelCase")]
pub fn rag_ingest(
    app: tauri::AppHandle,
    source: RagSourceInput,
    chunks: Vec<RagChunkInput>,
) -> Result<RagIngestResult, String> {
    crate::services::rag_service::rag_ingest(&app, source, chunks)
}

#[tauri::command(rename_all = "camelCase")]
pub fn rag_query(
    app: tauri::AppHandle,
    query_vec: Vec<f32>,
    top_k: Option<usize>,
) -> Result<RagQueryResult, String> {
    crate::services::rag_service::rag_query(&app, query_vec, top_k)
}

#[tauri::command(rename_all = "camelCase")]
pub fn rag_list_sources(app: tauri::AppHandle) -> Result<Vec<RagSourceInfo>, String> {
    crate::services::rag_service::rag_list_sources(&app)
}

#[tauri::command(rename_all = "camelCase")]
pub fn rag_delete_source(app: tauri::AppHandle, source_id: String) -> Result<(), String> {
    crate::services::rag_service::rag_delete_source(&app, source_id)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn rag_embed_api(
    req: RagEmbedRequest,
) -> Result<RagEmbedResponse, String> {
    crate::services::rag_service::rag_embed_api(req).await
}
