//! RAG 命令层：把 rag_service 暴露为 Tauri 命令，供前端插件（IDE / gongfang / RAG 设置页）
//! 通过 hostApi.invoke 调用。所有命令均为「共享后台服务」，任何插件均可复用。
//!
//! ## 为什么全部改成 async + spawn_blocking（2026-10-19）
//!
//! Tauri v2 的**同步命令在主线程执行**。RAG 的每个命令背后都是 SQLite IO：
//! `rag_query` 要把整个命名空间的向量 BLOB 全读出来反序列化（几万块时是几十 MB），
//! `rag_update_vectors` 要写几千行并 VACUUM 备份。同步执行时这些都会**卡住 UI 主线程**
//! （表现为窗口白屏/无响应，用户会以为卡死）。
//!
//! 所以：同步 IO 一律 `spawn_blocking` 丢到阻塞线程池，命令本身声明成 `async`。
//! 例外是 `rag_embed_api`：它本来就是 reqwest 的 async IO，不需要线程。
//!
//! 错误分两层：`spawn_blocking` 的 JoinError（线程 panic/取消）与业务 Err，都要显式区分，
//! 否则 panic 会被当成"空结果"静默吞掉。

use tauri::AppHandle;

use crate::services::rag_service::{
    rag_backup as svc_rag_backup, rag_delete_source as svc_rag_delete_source,
    rag_embed_api as svc_rag_embed_api, rag_ingest as svc_rag_ingest,
    rag_init_db as svc_rag_init_db, rag_list_chunks as svc_rag_list_chunks,
    rag_list_sources as svc_rag_list_sources, rag_prune as svc_rag_prune,
    rag_query as svc_rag_query,
    rag_stats as svc_rag_stats, rag_update_vectors as svc_rag_update_vectors, RagChunkInput,
    RagChunkRow, RagEmbedRequest, RagEmbedResponse, RagIngestResult, RagQueryResult, RagSourceInfo,
    RagSourceInput, RagStats, RagVecUpdate,
};

/// 把阻塞任务丢到线程池并统一处理 JoinError。
async fn run_blocking<T, F>(what: &str, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    match tauri::async_runtime::spawn_blocking(f).await {
        Ok(r) => r,
        Err(e) => Err(format!("{what} 后台任务异常终止（线程 panic/取消）: {e}")),
    }
}

/// 初始化 RAG 数据库（建表，幂等）。
#[tauri::command]
pub async fn rag_init_db(app: AppHandle) -> Result<(), String> {
    run_blocking("rag_init_db", move || svc_rag_init_db(&app)).await
}

/// 摄取一条来源及其全部分块（分块与向量由前端算好传入）。
///
/// `plugin_id` 由插件沙箱自动注入：非空即强制落 `general` 命名空间
/// （见 rag_service::resolve_plugin_namespace），为空按 `source.namespace`/默认。
#[tauri::command]
pub async fn rag_ingest(
    app: AppHandle,
    source: RagSourceInput,
    chunks: Vec<RagChunkInput>,
    plugin_id: Option<String>,
) -> Result<RagIngestResult, String> {
    run_blocking("rag_ingest", move || {
        svc_rag_ingest(&app, source, chunks, plugin_id)
    })
    .await
}

/// 语义检索：对查询向量做暴力余弦 top-k。仅返回 `namespace` 命名空间下的记忆。
#[tauri::command]
pub async fn rag_query(
    app: AppHandle,
    query_vec: Vec<f32>,
    top_k: Option<usize>,
    namespace: Option<String>,
    min_score: Option<f32>,
    plugin_id: Option<String>,
) -> Result<RagQueryResult, String> {
    run_blocking("rag_query", move || {
        svc_rag_query(&app, query_vec, top_k, namespace, min_score, plugin_id)
    })
    .await
}

/// 列出知识库来源。`namespace` 非空时只返回该命名空间来源，否则全部。
/// `plugin_id` 非空时强制只看 `general`（插件视角）。
#[tauri::command]
pub async fn rag_list_sources(
    app: AppHandle,
    namespace: Option<String>,
    plugin_id: Option<String>,
) -> Result<Vec<RagSourceInfo>, String> {
    run_blocking("rag_list_sources", move || {
        svc_rag_list_sources(&app, namespace, plugin_id)
    })
    .await
}

/// 删除一条来源及其全部分块（删除前自动备份）。
#[tauri::command]
pub async fn rag_delete_source(
    app: AppHandle,
    source_id: String,
    namespace: Option<String>,
    plugin_id: Option<String>,
) -> Result<(), String> {
    run_blocking("rag_delete_source", move || {
        svc_rag_delete_source(&app, source_id, namespace, plugin_id)
    })
    .await
}

/// 嵌入代理：把文本发给配置的嵌入端点（Ollama / OpenAI 兼容），返回向量。
/// 插件沙箱屏蔽 fetch，必须由 Rust（reqwest）代理。
///
/// 命令参数采用**扁平字段**（与 `rag_ingest` 拆 `source`+`chunks`、`ai_chat` 的扁平
/// camelCase 调用风格一致）。Tauri v2 在命令参数为结构体时要求前端 invoke 必须提供
/// 对应 key（如 `payload`），而扁平字段无法自动映射到嵌套结构体；因此此处把结构体
/// 拆成独立参数，避免前端调用处被迫包一层 `payload`，从而彻底消除
/// "missing field `payload` for command `rag_embed_api`" 运行时错误。
#[tauri::command]
pub async fn rag_embed_api(
    texts: Vec<String>,
    endpoint: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
) -> Result<RagEmbedResponse, String> {
    svc_rag_embed_api(RagEmbedRequest {
        texts,
        endpoint,
        api_key,
        model,
    })
    .await
}

// ============ 重建向量 / 统计 / 备份（数据安全相关） ============

/// 手动备份数据库（VACUUM INTO 一致性快照，保留最近 3 份）。
#[tauri::command]
pub async fn rag_backup_db(app: AppHandle, reason: Option<String>) -> Result<String, String> {
    let reason = reason.unwrap_or_else(|| "manual".to_string());
    run_blocking("rag_backup_db", move || match svc_rag_backup(&app, &reason)? {
        Some(p) => Ok(p.to_string_lossy().to_string()),
        None => Ok(String::new()), // 还没有库
    })
    .await
}

/// 列出某来源下带向量的块（只读，供前端重新嵌入）。
#[tauri::command]
pub async fn rag_list_chunks(
    app: AppHandle,
    source_id: String,
    namespace: Option<String>,
    plugin_id: Option<String>,
) -> Result<Vec<RagChunkRow>, String> {
    run_blocking("rag_list_chunks", move || {
        svc_rag_list_chunks(&app, source_id, namespace, plugin_id)
    })
    .await
}

/// 批量写回新向量（全有或全无；覆盖前自动备份）。
#[tauri::command]
pub async fn rag_update_vectors(
    app: AppHandle,
    source_id: String,
    updates: Vec<RagVecUpdate>,
    namespace: Option<String>,
    plugin_id: Option<String>,
) -> Result<usize, String> {
    run_blocking("rag_update_vectors", move || {
        svc_rag_update_vectors(&app, source_id, updates, namespace, plugin_id)
    })
    .await
}

/// 命名空间内维度/模型分布（UI 据此提示"有 N 块是旧模型建的"）。
#[tauri::command]
pub async fn rag_stats(
    app: AppHandle,
    namespace: Option<String>,
    plugin_id: Option<String>,
) -> Result<RagStats, String> {
    run_blocking("rag_stats", move || svc_rag_stats(&app, namespace, plugin_id)).await
}

/// 清理对话记录类来源（保留最近 N 条；只在超过 1.5 倍时才动手，删除前自动备份）。
#[tauri::command]
pub async fn rag_prune(
    app: AppHandle,
    namespace: Option<String>,
    keep_recent: Option<usize>,
    plugin_id: Option<String>,
) -> Result<usize, String> {
    run_blocking("rag_prune", move || {
        svc_rag_prune(&app, namespace, keep_recent, plugin_id)
    })
    .await
}
