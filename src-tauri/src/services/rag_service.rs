//! RAG 向量存储后端（共享后台服务）。
//!
//! 设计要点：
//! - 持久化用 rusqlite（bundled SQLite），库位于 `app_data_dir()/rag.sqlite`。
//! - 嵌入（embedding）由**前端**负责（ApiEmbedder 走 rag_embed_api / OnnxEmbedder 走 wasm），
//!   后端只负责「存储向量 + 暴力余弦 top-k 检索」，因此后端与具体嵌入模型解耦，
//!   既支持全本地（onnx wasm）也支持全 API（Ollama / OpenAI 兼容端点）。
//! - 表结构（与插件/IDE 共享约定一致）：
//!   - sources(id, title, uri, type, created_at, chunk_count, status)
//!   - chunks(id, source_id, idx, text, char_start, char_end, vec BLOB, meta JSON)
//! - 向量以 little-endian f32 字节存于 BLOB（RAG_VECTOR_DIM=768，nomic-embed-text）。

use std::path::PathBuf;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri::Manager;

/// 嵌入向量维度（nomic-embed-text 等常用本地/API 嵌入模型均为 768）。
pub const RAG_VECTOR_DIM: usize = 768;
/// SQLite 文件名（置于应用数据目录）。
const DB_FILENAME: &str = "rag.sqlite";

// ============ 错误与路径工具 ============

/// 取应用数据目录下的 rag.sqlite 路径。
fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    Ok(dir.join(DB_FILENAME))
}

/// 打开连接并初始化表结构（幂等）。每次调用独立打开连接，SQLite 文件级锁可承受
/// 桌面级并发；写操作天然串行化，读操作可并发。
fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    let conn = Connection::open(&path).map_err(|e| format!("打开 RAG 数据库失败: {}", e))?;
    // 启用外键约束（连接级，每次打开需重新设置）
    conn.execute_batch("PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("设置外键失败: {}", e))?;
    init_schema(&conn)?;
    Ok(conn)
}

/// 建表（IF NOT EXISTS），保证幂等。
fn init_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS sources (
            id          TEXT PRIMARY KEY,
            title       TEXT NOT NULL,
            uri         TEXT NOT NULL,
            type        TEXT NOT NULL DEFAULT 'file',
            created_at  TEXT NOT NULL,
            chunk_count INTEGER NOT NULL DEFAULT 0,
            status      TEXT NOT NULL DEFAULT 'ready'
        );
        CREATE TABLE IF NOT EXISTS chunks (
            id          TEXT PRIMARY KEY,
            source_id   TEXT NOT NULL,
            idx         INTEGER NOT NULL,
            text        TEXT NOT NULL,
            char_start  INTEGER NOT NULL DEFAULT 0,
            char_end    INTEGER NOT NULL DEFAULT 0,
            vec         BLOB NOT NULL,
            meta        TEXT NOT NULL DEFAULT '{}',
            FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);
        CREATE INDEX IF NOT EXISTS idx_chunks_order  ON chunks(source_id, idx);",
    )
    .map_err(|e| format!("初始化 RAG 表结构失败: {}", e))
}

// ============ 向量序列化 ============

/// f32 切片 → little-endian 字节（BLOB）。
fn vec_to_blob(v: &[f32]) -> Vec<u8> {
    let mut b = Vec::with_capacity(v.len() * 4);
    for &x in v {
        b.extend_from_slice(&x.to_le_bytes());
    }
    b
}

/// little-endian 字节（BLOB）→ f32 切片。长度非 4 的倍数时截断到 4 的整数倍。
fn blob_to_vec(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// 余弦相似度（a·b / |a||b|）。长度不一致或任一为零向量时返回 0。
fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    let denom = na.sqrt() * nb.sqrt();
    if denom == 0.0 {
        0.0
    } else {
        dot / denom
    }
}

// ============ 请求/响应结构 ============

/// 摄取入参：来源元信息。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RagSourceInput {
    pub title: String,
    pub uri: String,
    #[serde(default = "default_source_type")]
    pub r#type: String,
}

fn default_source_type() -> String {
    "file".to_string()
}

/// 摄取入参：单个分块（含已算好的嵌入向量）。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RagChunkInput {
    pub idx: i64,
    pub text: String,
    #[serde(default)]
    pub char_start: i64,
    #[serde(default)]
    pub char_end: i64,
    pub vec: Vec<f32>,
    #[serde(default)]
    pub meta: Option<serde_json::Value>,
}

/// 摄取结果。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RagIngestResult {
    pub source_id: String,
    pub chunk_count: usize,
}

/// 来源列表项（rag_list_sources 返回）。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RagSourceInfo {
    pub id: String,
    pub title: String,
    pub uri: String,
    pub r#type: String,
    pub created_at: String,
    pub chunk_count: i64,
    pub status: String,
}

/// 单条检索命中。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RagHit {
    pub source_id: String,
    pub source_title: String,
    pub text: String,
    pub score: f32,
    pub char_start: i64,
    pub char_end: i64,
}

/// 检索结果。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RagQueryResult {
    pub results: Vec<RagHit>,
    pub total: usize,
}

/// rag_embed_api 请求：文本 + 端点/模型（复用现有 ai profiles / ModelSettings 预设）。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RagEmbedRequest {
    pub texts: Vec<String>,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

/// rag_embed_api 响应。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RagEmbedResponse {
    pub embeddings: Vec<Vec<f32>>,
    pub dim: usize,
}

// ============ 公共 API ============

/// 初始化数据库（建表）。幂等，可重复调用。
pub fn rag_init_db(app: &AppHandle) -> Result<(), String> {
    open_db(app).map(|_| ())
}

/// 摄取：写入一条来源 + 其全部分块（含向量）。返回来源 id 与分块数。
pub fn rag_ingest(
    app: &AppHandle,
    source: RagSourceInput,
    chunks: Vec<RagChunkInput>,
) -> Result<RagIngestResult, String> {
    if chunks.is_empty() {
        return Err("摄取失败：分块为空（请先分块并嵌入）".to_string());
    }
    let mut conn = open_db(app)?;
    let source_id = uuid::Uuid::new_v4().to_string();
    let created_at = chrono::Local::now().to_rfc3339();
    let chunk_count = chunks.len();

    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {}", e))?;

    tx.execute(
        "INSERT INTO sources (id, title, uri, type, created_at, chunk_count, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ready')",
        params![
            source_id,
            source.title,
            source.uri,
            source.r#type,
            created_at,
            chunk_count as i64
        ],
    )
    .map_err(|e| format!("写入来源失败: {}", e))?;

    for ch in &chunks {
        // 维度校验：非 768 时给出明确警告但仍入库（兼容后续其他维度模型）
        if ch.vec.len() != RAG_VECTOR_DIM {
            log::warn!(
                "[rag] chunk #{} 向量维度 {} ≠ RAG_VECTOR_DIM {}，检索相似度可能失真",
                ch.idx,
                ch.vec.len(),
                RAG_VECTOR_DIM
            );
        }
        let chunk_id = format!("{}#{}", source_id, ch.idx);
        let blob = vec_to_blob(&ch.vec);
        let meta = ch
            .meta
            .as_ref()
            .map(|m| m.to_string())
            .unwrap_or_else(|| "{}".to_string());
        tx.execute(
            "INSERT INTO chunks (id, source_id, idx, text, char_start, char_end, vec, meta)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                chunk_id,
                source_id,
                ch.idx,
                ch.text,
                ch.char_start,
                ch.char_end,
                blob,
                meta
            ],
        )
        .map_err(|e| format!("写入分块失败: {}", e))?;
    }

    tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
    Ok(RagIngestResult {
        source_id,
        chunk_count,
    })
}

/// 语义检索：对 query_vec 做暴力余弦 top-k，返回命中（含来源标题）。
pub fn rag_query(
    app: &AppHandle,
    query_vec: Vec<f32>,
    top_k: Option<usize>,
) -> Result<RagQueryResult, String> {
    if query_vec.is_empty() {
        return Err("检索失败：查询向量为空".to_string());
    }
    let k = top_k.unwrap_or(6).max(1);
    let conn = open_db(app)?;

    // 一次性取出所有分块向量 + 来源标题（JOIN sources 拿标题）
    let mut stmt = conn
        .prepare(
            "SELECT c.text, c.char_start, c.char_end, c.vec, c.source_id, s.title
             FROM chunks c JOIN sources s ON s.id = c.source_id
             ORDER BY c.source_id, c.idx",
        )
        .map_err(|e| format!("准备检索语句失败: {}", e))?;

    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,      // text
                row.get::<_, i64>(1)?,         // char_start
                row.get::<_, i64>(2)?,         // char_end
                row.get::<_, Vec<u8>>(3)?,     // vec blob
                row.get::<_, String>(4)?,      // source_id
                row.get::<_, String>(5)?,      // source_title
            ))
        })
        .map_err(|e| format!("执行检索失败: {}", e))?;

    let mut hits: Vec<RagHit> = Vec::new();
    for r in rows {
        let (text, char_start, char_end, blob, source_id, source_title) =
            r.map_err(|e| format!("读取分块失败: {}", e))?;
        let vec = blob_to_vec(&blob);
        let score = cosine(&query_vec, &vec);
        hits.push(RagHit {
            source_id,
            source_title,
            text,
            score,
            char_start,
            char_end,
        });
    }

    // 按相似度降序，取 top-k
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    if hits.len() > k {
        hits.truncate(k);
    }
    let total = hits.len();
    Ok(RagQueryResult { results: hits, total })
}

/// 列出全部来源（按创建时间倒序）。
pub fn rag_list_sources(app: &AppHandle) -> Result<Vec<RagSourceInfo>, String> {
    let conn = open_db(app)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, title, uri, type, created_at, chunk_count, status
             FROM sources ORDER BY created_at DESC",
        )
        .map_err(|e| format!("准备列表语句失败: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(RagSourceInfo {
                id: row.get(0)?,
                title: row.get(1)?,
                uri: row.get(2)?,
                r#type: row.get(3)?,
                created_at: row.get(4)?,
                chunk_count: row.get(5)?,
                status: row.get(6)?,
            })
        })
        .map_err(|e| format!("列出来源失败: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取来源失败: {}", e))?);
    }
    Ok(out)
}

/// 删除来源及其全部分块（外键 CASCADE）。
pub fn rag_delete_source(app: &AppHandle, source_id: String) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute("DELETE FROM sources WHERE id = ?1", params![source_id])
        .map_err(|e| format!("删除来源失败: {}", e))?;
    Ok(())
}

// ============ 嵌入代理（rag_embed_api） ============
//
// 插件沙箱屏蔽 fetch，任何外部 HTTP 必须由 Rust 命令代理（reqwest）。
// 支持两类端点：
//   1) Ollama 本地嵌入：默认 http://localhost:11434/api/embeddings，模型 nomic-embed-text；
//      请求体 {model, prompt}（单条），响应 {embedding:[..]}。
//   2) OpenAI 兼容 /v1/embeddings：请求体 {model, input:[..]}，响应 {data:[{embedding}]}。
// 通过 URL 是否含 "/api/embeddings" 自动判定；端点/key 复用现有 ai profiles / ModelSettings。

/// 代理嵌入：把文本发给配置的嵌入端点，返回向量列表。
pub async fn rag_embed_api(req: RagEmbedRequest) -> Result<RagEmbedResponse, String> {
    let endpoint = req
        .endpoint
        .unwrap_or_else(|| "http://localhost:11434/api/embeddings".to_string());
    let model = req
        .model
        .unwrap_or_else(|| "nomic-embed-text".to_string());
    let api_key = req.api_key.unwrap_or_default();
    if req.texts.is_empty() {
        return Err("嵌入失败：文本为空".to_string());
    }

    let client = reqwest::Client::new();
    let is_ollama = endpoint.contains("/api/embeddings");

    if is_ollama {
        // Ollama：逐条请求（/api/embeddings 仅接受单条 prompt）
        let mut embeddings: Vec<Vec<f32>> = Vec::with_capacity(req.texts.len());
        for text in &req.texts {
            let body = serde_json::json!({ "model": model, "prompt": text });
            let mut builder = client
                .post(&endpoint)
                .header("Content-Type", "application/json");
            if !api_key.is_empty() {
                builder = builder.header("Authorization", format!("Bearer {}", api_key));
            }
            let resp = builder
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("嵌入请求失败: {}", e))?;
            if !resp.status().is_success() {
                let status = resp.status();
                let txt = resp.text().await.unwrap_or_default();
                return Err(format!(
                    "嵌入 HTTP {}: {}",
                    status,
                    txt.chars().take(300).collect::<String>()
                ));
            }
            let v: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("解析嵌入响应失败: {}", e))?;
            let emb = v
                .get("embedding")
                .and_then(|x| x.as_array())
                .ok_or_else(|| "嵌入响应缺少 embedding 字段".to_string())?;
            embeddings.push(emb.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect());
        }
        let dim = embeddings.first().map(|v| v.len()).unwrap_or(0);
        Ok(RagEmbedResponse { embeddings, dim })
    } else {
        // OpenAI 兼容：批量 input
        let body = serde_json::json!({ "model": model, "input": req.texts });
        let mut builder = client
            .post(&endpoint)
            .header("Content-Type", "application/json");
        if !api_key.is_empty() {
            builder = builder.header("Authorization", format!("Bearer {}", api_key));
        }
        let resp = builder
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("嵌入请求失败: {}", e))?;
        if !resp.status().is_success() {
            let status = resp.status();
            let txt = resp.text().await.unwrap_or_default();
            return Err(format!(
                "嵌入 HTTP {}: {}",
                status,
                txt.chars().take(300).collect::<String>()
            ));
        }
        let v: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| format!("解析嵌入响应失败: {}", e))?;
        let data = v
            .get("data")
            .and_then(|x| x.as_array())
            .ok_or_else(|| "嵌入响应缺少 data 字段".to_string())?;
        let mut embeddings: Vec<Vec<f32>> = Vec::with_capacity(data.len());
        for item in data {
            let emb = item
                .get("embedding")
                .and_then(|x| x.as_array())
                .ok_or_else(|| "嵌入项缺少 embedding 字段".to_string())?;
            embeddings.push(emb.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect());
        }
        let dim = embeddings.first().map(|v| v.len()).unwrap_or(0);
        Ok(RagEmbedResponse { embeddings, dim })
    }
}
