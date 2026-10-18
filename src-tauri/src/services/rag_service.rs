//! RAG 向量存储后端（共享后台服务）。
//!
//! 设计要点：
//! - 持久化用 rusqlite（bundled SQLite），库位于 `app_data_dir()/rag.sqlite`。
//! - 嵌入（embedding）由**前端**负责（ApiEmbedder 走 rag_embed_api / OnnxEmbedder 走 wasm），
//!   后端只负责「存储向量 + 暴力余弦 top-k 检索」，因此后端与具体嵌入模型解耦，
//!   既支持全本地（onnx wasm）也支持全 API（Ollama / OpenAI 兼容端点）。
//! - 表结构（与插件/IDE 共享约定一致）：
//!   - sources(id, title, uri, type, created_at, chunk_count, status, namespace)
//!   - chunks(id, source_id, idx, text, char_start, char_end, vec BLOB, meta JSON, namespace)
//! - **命名空间隔离**：所有来源与分块都带 `namespace`，强制各 AI 子模块（ai-chat / ai-ide /
//!   ai-gongfang）记忆物理隔离，检索/列表只返回同一 namespace 的内容，防止串味。
//!   - 历史库（建表时无该列）通过 `rag_init_db` 的 ALTER 幂等补列，默认 'ai-chat'（向后兼容）。
//! - 向量以 little-endian f32 字节存于 BLOB（RAG_VECTOR_DIM=768，nomic-embed-text）。

/// 默认命名空间（历史数据 / 未指定时回落）。
pub const RAG_NS_DEFAULT: &str = "ai-chat";
/// 三个 AI 子模块的命名空间约定（供前端调用方显式声明，杜绝串味）。
pub mod rag_namespace {
    pub const AI_CHAT: &str = "ai-chat"; // ai对话 / 伴侣记忆
    pub const AI_IDE: &str = "ai-ide"; // ai编程
    pub const AI_GONGFANG: &str = "ai-gongfang"; // ai攻防
    pub const GENERAL: &str = "general"; // 通用（手动导入的知识库）
}

/// 按调用方身份推导命名空间（2026-10-18 新增，硬隔离）。
///
/// 背景：namespace 隔离此前是**靠调用方自觉**——插件可以从沙箱里传 `namespace: "ai-chat"`
/// 直接读用户与 AI 伴侣的私人记忆，后端照单全收。`__HOST_API__.invoke` 会把 `pluginId`
/// 注入每个命令参数（见 pluginSandbox.ts `invoke(command, {...args, pluginId})`），
/// 所以后端可以据此**强制**限制：
///   - 来自插件（plugin_id 非空）→ 一律落到 `general`（插件共用同一个手动知识库），
///     传入其它 namespace 会被改写并打 warning；
///   - 来自主应用（无 plugin_id，如 semanticMemory 的伴侣记忆）→ 沿用入参，缺省 ai-chat。
///
/// 残余风险：插件若绕过 __HOST_API__ 直接摸 __TAURI_INTERNALS__，就没有 plugin_id 了。
/// 真正硬的边界需要 per-namespace 加密或按 webview 分窗，当前先堵住主路径。
pub fn resolve_plugin_namespace(plugin_id: Option<&str>, requested: Option<String>) -> String {
    if let Some(pid) = plugin_id {
        let req = requested.unwrap_or_default();
        if !req.is_empty() && req != rag_namespace::GENERAL {
            log::warn!(
                "[rag] 插件 {} 请求命名空间 '{}'，已强制改写为 '{}'（插件只能访问手动知识库）",
                pid,
                req,
                rag_namespace::GENERAL
            );
        }
        return rag_namespace::GENERAL.to_string();
    }
    requested
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| RAG_NS_DEFAULT.to_string())
}

use std::path::PathBuf;

use rusqlite::{params, Connection, OptionalExtension};
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
            status      TEXT NOT NULL DEFAULT 'ready',
            namespace   TEXT NOT NULL DEFAULT 'ai-chat'
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
            namespace   TEXT NOT NULL DEFAULT 'ai-chat',
            parent_idx  INTEGER,
            FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);
        CREATE INDEX IF NOT EXISTS idx_chunks_order  ON chunks(source_id, idx);
        CREATE INDEX IF NOT EXISTS idx_chunks_ns     ON chunks(namespace);",
    )
    .map_err(|e| format!("初始化 RAG 表结构失败: {}", e))?;

    // 向后兼容：历史库（旧表无 namespace 列）幂等补列，统一回落默认命名空间。
    // 已存在的行 namespace 保持 DEFAULT 'ai-chat'，使旧伴侣记忆不丢失。
    //
    // 2026-10-18：改为先查 PRAGMA 再 ALTER。此前是「无条件 ALTER + `let _ =` 吞错」——
    // 列已存在时每次 open_db 都以错误收场，而错误被丢掉，真正需要关注的 ALTER 失败也看不见。
    for tbl in ["sources", "chunks"] {
        if !has_column(conn, tbl, "namespace")? {
            conn.execute(
                &format!(
                    "ALTER TABLE {tbl} ADD COLUMN namespace TEXT NOT NULL DEFAULT 'ai-chat'"
                ),
                [],
            )
            .map_err(|e| format!("为表 {tbl} 补 namespace 列失败: {}", e))?;
            log::info!("[rag] 已为表 {tbl} 补 namespace 列（默认 ai-chat）");
        }
    }
    // 小-大分块（2026-10-18）：chunks 增加 parent_idx，指向同 source 内的父块。
    // 老数据没有该列值（NULL）⇒ 检索时按"无父块"处理，行为与旧版一致。
    if !has_column(conn, "chunks", "parent_idx")? {
        conn.execute("ALTER TABLE chunks ADD COLUMN parent_idx INTEGER", [])
            .map_err(|e| format!("为表 chunks 补 parent_idx 列失败: {}", e))?;
        log::info!("[rag] 已为表 chunks 补 parent_idx 列（小-大分块）");
    }
    Ok(())
}

/// 判断表是否存在某列（PRAGMA table_info）。
fn has_column(conn: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({})", table))
        .map_err(|e| format!("读取表 {table} 结构失败: {}", e))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| format!("查询表 {table} 结构失败: {}", e))?;
    while let Some(row) = rows.next().map_err(|e| format!("遍历表 {table} 结构失败: {}", e))? {
        let name: String = row.get(1).map_err(|e| format!("读取列名失败: {}", e))?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
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
    /// 命名空间（隔离各 AI 子模块记忆）。缺省回落 'ai-chat'。
    #[serde(default = "default_namespace")]
    pub namespace: String,
}

fn default_namespace() -> String {
    RAG_NS_DEFAULT.to_string()
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
    /// 向量。**空数组表示父块**：不参与向量检索，只在命中其子块后回填上下文。
    pub vec: Vec<f32>,
    /// 父块 idx（小-大分块）。子块指向父块；父块自身为 None。
    #[serde(default)]
    pub parent_idx: Option<i64>,
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
    pub namespace: String,
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
    plugin_id: Option<String>,
) -> Result<RagIngestResult, String> {
    if chunks.is_empty() {
        return Err("摄取失败：分块为空（请先分块并嵌入）".to_string());
    }
    let mut conn = open_db(app)?;
    let source_id = uuid::Uuid::new_v4().to_string();
    let created_at = chrono::Local::now().to_rfc3339();
    // 命名空间：插件一律强制 general（见 resolve_plugin_namespace）；主应用按入参 / 默认。
    let requested_ns = if source.namespace.trim().is_empty() {
        None
    } else {
        Some(source.namespace.clone())
    };
    let namespace = resolve_plugin_namespace(plugin_id.as_deref(), requested_ns);

    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {}", e))?;

    // 维度一致性校验（2026-10-18）：
    // 余弦相似度要求两个向量同维，cosine() 对长度不等直接返回 0.0 —— 也就是说
    // 「换了个嵌入模型」在旧实现里表现为**检索静默失效**（永远 0 分、top-k 变成随机 6 条），
    // 而不是报错。这里在写入前拦下，并明确告知需要重建命名空间。
    //
    // 只校验**带向量的块**（子块）：父块 vec 为空是设计如此，不参与检索。
    let vectorized: Vec<&RagChunkInput> = chunks.iter().filter(|c| !c.vec.is_empty()).collect();
    let chunk_count = vectorized.len();
    if chunk_count == 0 {
        return Err("摄取失败：没有任何分块带向量（子块为空，检查分块/嵌入环节）".to_string());
    }
    let first_dim = vectorized[0].vec.len();
    if let Some(bad) = vectorized.iter().find(|c| c.vec.len() != first_dim) {
        return Err(format!(
            "摄取失败：分块 #{} 向量维度 {} 与本批其他分块 {} 不一致",
            bad.idx,
            bad.vec.len(),
            first_dim
        ));
    }
    let existing_bytes: Option<i64> = tx
        .query_row(
            "SELECT length(vec) FROM chunks WHERE namespace = ?1 LIMIT 1",
            params![namespace],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("查询命名空间既有向量维度失败: {}", e))?;
    if let Some(bytes) = existing_bytes {
        let existing_dim = (bytes.max(0) as usize) / 4;
        if existing_dim != first_dim {
            return Err(format!(
                "摄取失败：命名空间 '{}' 已有向量是 {} 维，本次是 {} 维。\
                 换嵌入模型后必须清空该命名空间的旧数据再重建，否则相似度恒为 0。",
                namespace, existing_dim, first_dim
            ));
        }
    }

    tx.execute(
        "INSERT INTO sources (id, title, uri, type, created_at, chunk_count, status, namespace)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ready', ?7)",
        params![
            source_id,
            source.title,
            source.uri,
            source.r#type,
            created_at,
            chunk_count as i64,
            namespace
        ],
    )
    .map_err(|e| format!("写入来源失败: {}", e))?;

    for ch in &chunks {
        // 维度校验：非 768 时给出明确警告但仍入库（兼容后续其他维度模型）。
        // 父块（vec 为空）不参与检索，跳过该警告。
        if !ch.vec.is_empty() && ch.vec.len() != RAG_VECTOR_DIM {
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
            "INSERT INTO chunks (id, source_id, idx, text, char_start, char_end, vec, meta, namespace, parent_idx)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                chunk_id,
                source_id,
                ch.idx,
                ch.text,
                ch.char_start,
                ch.char_end,
                blob,
                meta,
                namespace,
                ch.parent_idx
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
/// `namespace` 限定检索范围（杜绝跨模块串味）；缺省回落默认命名空间。
/// `min_score` 非空时丢弃低于阈值的命中（避免把无关块塞进 prompt 造成"被上下文带偏"）。
pub fn rag_query(
    app: &AppHandle,
    query_vec: Vec<f32>,
    top_k: Option<usize>,
    namespace: Option<String>,
    min_score: Option<f32>,
    plugin_id: Option<String>,
) -> Result<RagQueryResult, String> {
    if query_vec.is_empty() {
        return Err("检索失败：查询向量为空".to_string());
    }
    let k = top_k.unwrap_or(6).max(1);
    let ns = resolve_plugin_namespace(plugin_id.as_deref(), namespace);
    let conn = open_db(app)?;

    // 一次性取出同一命名空间下所有**带向量**的子块 + 来源标题 + 父块文本。
    // 小-大分块：向量算在子块上（精准定位），返回给调用方的是父块（上下文完整）。
    // `length(c.vec) > 0` 排除父块自身（父块 vec 为空，只作上下文载体）。
    let mut stmt = conn
        .prepare(
            "SELECT c.text, c.char_start, c.char_end, c.vec, c.source_id, s.title,
                    p.text, p.char_start, p.char_end
             FROM chunks c
             JOIN sources s ON s.id = c.source_id
             LEFT JOIN chunks p ON p.source_id = c.source_id AND p.idx = c.parent_idx
             WHERE c.namespace = ?1 AND s.namespace = ?1 AND length(c.vec) > 0
             ORDER BY c.source_id, c.idx",
        )
        .map_err(|e| format!("准备检索语句失败: {}", e))?;

    let rows = stmt
        .query_map(params![ns], |row| {
            Ok((
                row.get::<_, String>(0)?,          // text（子块）
                row.get::<_, i64>(1)?,             // char_start（子块）
                row.get::<_, i64>(2)?,             // char_end（子块）
                row.get::<_, Vec<u8>>(3)?,         // vec blob
                row.get::<_, String>(4)?,          // source_id
                row.get::<_, String>(5)?,          // source_title
                row.get::<_, Option<String>>(6)?,  // parent text
                row.get::<_, Option<i64>>(7)?,     // parent char_start
                row.get::<_, Option<i64>>(8)?,     // parent char_end
            ))
        })
        .map_err(|e| format!("执行检索失败: {}", e))?;

    let mut hits: Vec<RagHit> = Vec::new();
    let mut dim_skipped = 0usize;
    let mut score_filtered = 0usize;
    let mut parent_filled = 0usize;
    for r in rows {
        let (child_text, c_cs, c_ce, blob, source_id, source_title, p_text, p_cs, p_ce) =
            r.map_err(|e| format!("读取分块失败: {}", e))?;
        let vec = blob_to_vec(&blob);
        // 维度不一致说明该块来自另一个嵌入模型 —— cosine 会返回 0（静默失效），
        // 这里显式跳过并统计，宁可少返回也不要给 LLM 一堆 0 分噪声。
        if vec.len() != query_vec.len() {
            dim_skipped += 1;
            continue;
        }
        let score = cosine(&query_vec, &vec);
        if let Some(min) = min_score {
            if score < min {
                score_filtered += 1;
                continue;
            }
        }
        // 命中子块 → 用父块文本与区间（父块缺失时回落到子块，兼容老数据）
        let (text, char_start, char_end) = match p_text {
            Some(t) if !t.trim().is_empty() => {
                parent_filled += 1;
                (t, p_cs.unwrap_or(c_cs), p_ce.unwrap_or(c_ce))
            }
            _ => (child_text, c_cs, c_ce),
        };
        hits.push(RagHit {
            source_id,
            source_title,
            text,
            score,
            char_start,
            char_end,
        });
    }
    if parent_filled > 0 {
        log::info!("[rag] ns={} 有 {} 条命中已回填父块上下文", ns, parent_filled);
    }
    if dim_skipped > 0 {
        log::warn!(
            "[rag] ns={} 有 {} 个分块向量维度与查询向量（{} 维）不一致，已跳过",
            ns,
            dim_skipped,
            query_vec.len()
        );
    }
    if score_filtered > 0 {
        log::info!(
            "[rag] ns={} 有 {} 个命中低于阈值 {:?}，已过滤",
            ns,
            score_filtered,
            min_score
        );
    }

    // 按相似度降序，取 top-k
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    if hits.len() > k {
        hits.truncate(k);
    }
    let total = hits.len();
    Ok(RagQueryResult { results: hits, total })
}

/// 从行构造 RagSourceInfo（含命名空间字段）。
fn source_from_row(row: &rusqlite::Row) -> RagSourceInfo {
    RagSourceInfo {
        id: row.get(0).unwrap_or_default(),
        title: row.get(1).unwrap_or_default(),
        uri: row.get(2).unwrap_or_default(),
        r#type: row.get(3).unwrap_or_default(),
        created_at: row.get(4).unwrap_or_default(),
        chunk_count: row.get(5).unwrap_or_default(),
        status: row.get(6).unwrap_or_default(),
        namespace: row.get(7).unwrap_or_else(|_| RAG_NS_DEFAULT.to_string()),
    }
}

/// 列出来源（按创建时间倒序）。`namespace` 非空时只返回该命名空间来源，否则全部。
/// 插件调用（plugin_id 非空）一律只看 general。
pub fn rag_list_sources(
    app: &AppHandle,
    namespace: Option<String>,
    plugin_id: Option<String>,
) -> Result<Vec<RagSourceInfo>, String> {
    let conn = open_db(app)?;
    let effective: Option<String> = match plugin_id.as_deref() {
        Some(_) => Some(rag_namespace::GENERAL.to_string()),
        None => namespace.filter(|s| !s.is_empty()),
    };
    // 单条 SQL + 单闭包：namespace 为 NULL 时（?1 IS NULL）匹配全部，否则只返回该命名空间。
    let mut stmt = conn
        .prepare(
            "SELECT id, title, uri, type, created_at, chunk_count, status, namespace
             FROM sources WHERE (?1 IS NULL OR namespace = ?1) ORDER BY created_at DESC",
        )
        .map_err(|e| format!("准备列表语句失败: {}", e))?;
    let ns_param: Option<&str> = effective.as_deref();
    let rows = stmt
        .query_map(params![ns_param], |row| Ok(source_from_row(row)))
        .map_err(|e| format!("列出来源失败: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取来源失败: {}", e))?);
    }
    Ok(out)
}

/// 删除来源及其全部分块（外键 CASCADE）。
///
/// `namespace` 非空时**校验归属**：只能删本命名空间下的来源。
/// 2026-10-18 前该命令只按 id 删 —— 任何调用方拿到别人的 source_id 就能删掉
/// AI 对话的伴侣记忆，命名空间隔离在「写/查」是成立的、在「删」上是漏的。
pub fn rag_delete_source(
    app: &AppHandle,
    source_id: String,
    namespace: Option<String>,
    plugin_id: Option<String>,
) -> Result<(), String> {
    let conn = open_db(app)?;
    let ns_owned: Option<String> = match plugin_id.as_deref() {
        // 插件：强制只删 general，即使它传了别的 namespace
        Some(_) => Some(rag_namespace::GENERAL.to_string()),
        None => namespace.filter(|s| !s.is_empty()),
    };
    let ns = ns_owned.as_deref();
    let changed = match ns {
        Some(ns) => conn.execute(
            "DELETE FROM sources WHERE id = ?1 AND namespace = ?2",
            params![source_id, ns],
        ),
        None => {
            log::warn!(
                "[rag] rag_delete_source 未指定 namespace，按旧行为直接删除 source={}",
                source_id
            );
            conn.execute("DELETE FROM sources WHERE id = ?1", params![source_id])
        }
    }
    .map_err(|e| format!("删除来源失败: {}", e))?;
    if changed == 0 {
        return Err(format!(
            "删除失败：来源 {} 不存在，或不属于命名空间 {}",
            source_id,
            ns.unwrap_or("<未指定>")
        ));
    }
    log::info!("[rag] 已删除 source={} ns={:?}", source_id, ns);
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

// ============ 隔离逻辑单测 ============
// 命名空间强制改写是 RAG 的安全边界（插件不得读 ai-chat 伴侣记忆），
// 纯函数，可直接单测，不依赖 AppHandle / SQLite。
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 插件请求_ai_chat_被改写为_general() {
        assert_eq!(
            resolve_plugin_namespace(Some("rag"), Some("ai-chat".to_string())),
            "general"
        );
        assert_eq!(
            resolve_plugin_namespace(Some("ide"), Some("ai-gongfang".to_string())),
            "general"
        );
    }

    #[test]
    fn 插件不传命名空间时落到_general() {
        assert_eq!(resolve_plugin_namespace(Some("rag"), None), "general");
        assert_eq!(
            resolve_plugin_namespace(Some("rag"), Some(String::new())),
            "general"
        );
    }

    #[test]
    fn 主应用保留显式命名空间() {
        assert_eq!(
            resolve_plugin_namespace(None, Some("ai-chat".to_string())),
            "ai-chat"
        );
        assert_eq!(
            resolve_plugin_namespace(None, Some("ai-ide".to_string())),
            "ai-ide"
        );
    }

    #[test]
    fn 主应用缺省回落_ai_chat() {
        assert_eq!(resolve_plugin_namespace(None, None), RAG_NS_DEFAULT);
        assert_eq!(
            resolve_plugin_namespace(None, Some(String::new())),
            RAG_NS_DEFAULT
        );
    }

    /// P1-2 前置探测：确认 bundled rusqlite 带 FTS5 + trigram 分词器。
    /// trigram 是中文关键词检索的前提（`unicode61` 对中文整段不分词）。
    /// 注意：trigram 的查询串**至少 3 个字符**才会命中（按 3-gram 建索引）。
    #[test]
    fn fts5_trigram_可用() {
        let conn =
            Connection::open_in_memory().expect("打开内存库失败（内存分配异常？）");
        if let Err(e) = conn.execute_batch(
            "CREATE VIRTUAL TABLE t USING fts5(body, tokenize='trigram');",
        ) {
            panic!("bundled rusqlite 未启用 FTS5 或 trigram 分词器: {e}");
        }
        conn.execute(
            "INSERT INTO t(body) VALUES ('内存泄漏排查方法与堆栈采样步骤')",
            [],
        )
        .expect("写入 fts 表失败");
        let n: i64 = conn
            .query_row("SELECT count(*) FROM t WHERE t MATCH '内存泄漏'", [], |r| {
                r.get(0)
            })
            .expect("MATCH 查询失败");
        assert_eq!(n, 1, "trigram 中文子串匹配未生效");
        // bm25 排序函数也应可用（混合检索要用它给关键词通道打分）
        let _rank: f64 = conn
            .query_row("SELECT bm25(t) FROM t WHERE t MATCH '泄漏'", [], |r| r.get(0))
            .unwrap_or(0.0);
    }
}
