//! RAG 命令层：把 rag_service 暴露为 Tauri 命令，供前端插件（IDE / gongfang / RAG 设置页）
//! 通过 hostApi.invoke 调用。所有命令均为「共享后台服务」，任何插件均可复用。

use tauri::AppHandle;

use crate::services::rag_service::{
    rag_delete_source as svc_rag_delete_source, rag_embed_api as svc_rag_embed_api,
    rag_ingest as svc_rag_ingest, rag_init_db as svc_rag_init_db,
    rag_list_sources as svc_rag_list_sources, rag_query as svc_rag_query, RagChunkInput,
    RagEmbedRequest, RagEmbedResponse, RagIngestResult, RagQueryResult, RagSourceInfo,
    RagSourceInput,
};

/// 初始化 RAG 数据库（建表，幂等）。
#[tauri::command]
pub fn rag_init_db(app: AppHandle) -> Result<(), String> {
    svc_rag_init_db(&app)
}

/// 摄取一条来源及其全部分块（分块与向量由前端算好传入）。
#[tauri::command]
pub fn rag_ingest(
    app: AppHandle,
    source: RagSourceInput,
    chunks: Vec<RagChunkInput>,
) -> Result<RagIngestResult, String> {
    svc_rag_ingest(&app, source, chunks)
}

/// 语义检索：对查询向量做暴力余弦 top-k。
#[tauri::command]
pub fn rag_query(
    app: AppHandle,
    query_vec: Vec<f32>,
    top_k: Option<usize>,
) -> Result<RagQueryResult, String> {
    svc_rag_query(&app, query_vec, top_k)
}

/// 列出全部知识库来源。
#[tauri::command]
pub fn rag_list_sources(app: AppHandle) -> Result<Vec<RagSourceInfo>, String> {
    svc_rag_list_sources(&app)
}

/// 删除一条来源及其全部分块。
#[tauri::command]
pub fn rag_delete_source(app: AppHandle, source_id: String) -> Result<(), String> {
    svc_rag_delete_source(&app, source_id)
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
