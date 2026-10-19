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
///
/// 2026-10-19 健壮性：
/// - `busy_timeout=5s`：并发写（摄取 + 重建 + 伴侣记忆同时写）时不再立刻 SQLITE_BUSY 失败
/// - `journal_mode=WAL`：读写不互斥，查询不会再被写事务卡住（失败不阻断，只 warn）
/// - `synchronous=NORMAL`：WAL 下的常规选择，掉电最多丢最后一个事务，不会坏库
fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    let conn = Connection::open(&path).map_err(|e| format!("打开 RAG 数据库失败: {}", e))?;
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| format!("设置 busy_timeout 失败: {}", e))?;
    // journal_mode 是「有返回值」的 pragma，用 query_row 读回实际模式；
    // 某些文件系统（网络盘/只读）上可能失败，不阻断（退回默认 journal）。
    match conn.query_row("PRAGMA journal_mode=WAL", [], |r| r.get::<_, String>(0)) {
        Ok(mode) => log::debug!("[rag] journal_mode={mode}"),
        Err(e) => log::warn!("[rag] 切换 WAL 失败（继续用默认 journal）: {e}"),
    }
    conn.execute_batch("PRAGMA synchronous=NORMAL; PRAGMA foreign_keys = ON;")
        .map_err(|e| format!("设置连接 pragma 失败: {}", e))?;
    init_schema(&conn)?;
    Ok(conn)
}

/// 写操作前的自动备份（数据第一）。
///
/// 用 `VACUUM INTO` 而不是 `fs::copy`：WAL 模式下直接拷主库文件可能拿到不一致的快照，
/// VACUUM INTO 产出的是一致性快照且天然紧凑。
/// 保留最近 `KEEP_BACKUPS` 份，按文件名时间戳排序删除更旧的。
pub fn rag_backup(app: &AppHandle, reason: &str) -> Result<Option<PathBuf>, String> {
    const KEEP_BACKUPS: usize = 3;
    let src = db_path(app)?;
    if !src.exists() {
        return Ok(None); // 还没有库，无需备份
    }
    let dir = src
        .parent()
        .ok_or_else(|| "无法确定备份目录".to_string())?
        .join("rag-backups");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建备份目录失败: {}", e))?;
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let safe_reason: String = reason
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let dst = dir.join(format!("rag-{safe_reason}-{ts}.sqlite"));

    let conn = Connection::open(&src).map_err(|e| format!("备份时打开数据库失败: {}", e))?;
    // VACUUM INTO 的目标是字面量，不能绑定参数 → 转义单引号
    let target = dst.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{target}'"))
        .map_err(|e| format!("备份失败（VACUUM INTO）: {}", e))?;
    drop(conn);
    log::info!("[rag] 已备份数据库 -> {}", dst.display());

    // 只保留最近 KEEP_BACKUPS 份
    if let Ok(rd) = std::fs::read_dir(&dir) {
        let mut files: Vec<PathBuf> = rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("sqlite"))
            .collect();
        files.sort();
        if files.len() > KEEP_BACKUPS {
            for old in &files[..files.len() - KEEP_BACKUPS] {
                if std::fs::remove_file(old).is_ok() {
                    log::info!("[rag] 清理旧备份 {}", old.display());
                }
            }
        }
    }
    Ok(Some(dst))
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
            namespace   TEXT NOT NULL DEFAULT 'ai-chat',
            embed_model TEXT NOT NULL DEFAULT '',
            embed_dim   INTEGER NOT NULL DEFAULT 0
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
            embed_model TEXT NOT NULL DEFAULT '',
            FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_id);
        CREATE INDEX IF NOT EXISTS idx_chunks_order  ON chunks(source_id, idx);
        CREATE INDEX IF NOT EXISTS idx_chunks_ns     ON chunks(namespace);
        -- 命名空间级状态（2026-10-19）：记录「这个库上次是用哪个模型/多少维写的」。
        -- 用途：换模型后 UI 能明确告诉用户「库里是 1024 维（qwen3），你现在配的是 768 维」，
        -- 而不是只给一堆块数让人猜。sources 上的 embed_* 是**每条来源**的，这里记**最近一次**。
        CREATE TABLE IF NOT EXISTS namespace_state (
            namespace   TEXT PRIMARY KEY,
            embed_model TEXT NOT NULL DEFAULT '',
            embed_dim   INTEGER NOT NULL DEFAULT 0,
            updated_at  TEXT NOT NULL
        );",
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
    // 自适应维度（2026-10-19）：记录每块/每来源是哪个模型、多少维产出的。
    // 这样换嵌入模型时**不需要清库**：旧块保留、检索按维度分流，需要时再按文本重建向量。
    // 为什么必须自适应：嵌入模型维度五花八门（768 / 1024 / 2560 / 4096），
    // 把维度写死等于让"换模型"变成不可用功能。
    for (tbl, col, ddl) in [
        ("sources", "embed_model", "TEXT NOT NULL DEFAULT ''"),
        ("sources", "embed_dim", "INTEGER NOT NULL DEFAULT 0"),
        ("chunks", "embed_model", "TEXT NOT NULL DEFAULT ''"),
    ] {
        if !has_column(conn, tbl, col)? {
            conn.execute(&format!("ALTER TABLE {tbl} ADD COLUMN {col} {ddl}"), [])
                .map_err(|e| format!("为表 {tbl} 补 {col} 列失败: {}", e))?;
            log::info!("[rag] 已为表 {tbl} 补 {col} 列（自适应维度）");
        }
    }
    Ok(())
}

/// 记录命名空间最近一次写入用的模型/维度（幂等 upsert）。
///
/// 为什么要单独存一份：`sources.embed_model/embed_dim` 是**每条来源**的元数据，
/// 而 UI 需要回答的是「这个库现在是什么模型写的」——多来源时前者无法直接回答。
fn upsert_namespace_state(
    conn: &Connection,
    ns: &str,
    model: &str,
    dim: usize,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO namespace_state (namespace, embed_model, embed_dim, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(namespace) DO UPDATE SET
           embed_model = excluded.embed_model,
           embed_dim   = excluded.embed_dim,
           updated_at  = excluded.updated_at",
        params![
            ns,
            model,
            dim as i64,
            chrono::Local::now().to_rfc3339()
        ],
    )
    .map_err(|e| format!("更新命名空间状态失败: {}", e))?;
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
    /// 按 `uri` 替换同命名空间下的旧来源（先删后写，级联删旧块）。
    ///
    /// 用于「重写式沉淀」：伴侣 persona / core 档案的 uri 是固定的，
    /// 每同步一次就新增一条会让库里堆满同一份数据的历史版本（检索被重复内容占满）。
    /// 对话记录这类 uri 天然唯一，不需要打开它。
    #[serde(default)]
    pub replace: bool,
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
    /// 产出该向量的嵌入模型名（如 `Qwen3-Embedding-0.6B`）。
    /// 换模型后旧块不会失效，只是**维度不同**——检索按维度分流，UI 可据此提示"这些块要重建"。
    #[serde(default)]
    pub embed_model: Option<String>,
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
    /// 嵌入模型名（该来源建库时用的）。老数据为空串。
    #[serde(default)]
    pub embed_model: String,
    /// 向量维度（768 / 1024 / 2560 / 4096 …）。老数据为 0。
    #[serde(default)]
    pub embed_dim: i64,
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
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct RagQueryResult {
    pub results: Vec<RagHit>,
    pub total: usize,
    /// 因维度与查询向量不一致而跳过的块数（换过嵌入模型时会 > 0）。
    /// 前端据此提示"有 N 块来自旧模型，未参与本次检索"。
    #[serde(default)]
    pub skipped_dim: usize,
    /// 同命名空间下实际参与比较的块数。
    #[serde(default)]
    pub compared: usize,
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

    // 重写式沉淀：同一 uri 先删旧来源（CASCADE 删旧块），避免历史版本堆积。
    // 必须在事务里、且在维度校验之前 —— 否则旧数据的维度会影响本次判断。
    if source.replace {
        let old = tx
            .execute(
                "DELETE FROM sources WHERE uri = ?1 AND namespace = ?2",
                params![source.uri, namespace],
            )
            .map_err(|e| format!("替换旧来源失败（已回滚）: {}", e))?;
        if old > 0 {
            log::info!(
                "[rag] replace 模式：已删除旧来源 uri={} ns={} 条数={}",
                source.uri,
                namespace,
                old
            );
        }
    }

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
            "SELECT length(vec) FROM chunks WHERE namespace = ?1 AND length(vec) > 0 LIMIT 1",
            params![namespace],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("查询命名空间既有向量维度失败: {}", e))?;
    if let Some(bytes) = existing_bytes {
        let existing_dim = (bytes.max(0) as usize) / 4;
        if existing_dim != first_dim {
            // 自适应维度：**不再拒绝**。旧块保留、检索按维度分流，
            // 需要时用现有文本重建向量即可（不需要重新上传文件）。
            log::warn!(
                "[rag] ns={} 已有向量 {} 维，本批 {} 维 —— 允许混存（检索时按维度分流）；\
                 旧块需要重建向量才能被新模型检索到",
                namespace,
                existing_dim,
                first_dim
            );
        }
    }
    let batch_model = chunks
        .iter()
        .find_map(|c| c.embed_model.clone().filter(|m| !m.trim().is_empty()))
        .unwrap_or_default();

    tx.execute(
        "INSERT INTO sources
           (id, title, uri, type, created_at, chunk_count, status, namespace, embed_model, embed_dim)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'ready', ?7, ?8, ?9)",
        params![
            source_id,
            source.title,
            source.uri,
            source.r#type,
            created_at,
            chunk_count as i64,
            namespace,
            batch_model,
            first_dim as i64
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
            "INSERT INTO chunks (id, source_id, idx, text, char_start, char_end, vec, meta, namespace, parent_idx, embed_model)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
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
                ch.parent_idx,
                ch.embed_model.clone().unwrap_or_else(|| batch_model.clone())
            ],
        )
        .map_err(|e| format!("写入分块失败: {}", e))?;
    }

    // 记录命名空间状态（最近一次写入用的模型/维度）
    upsert_namespace_state(&tx, &namespace, &batch_model, first_dim)?;

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
    let compared = hits.len() + score_filtered;
    if hits.len() > k {
        hits.truncate(k);
    }
    let total = hits.len();
    Ok(RagQueryResult {
        results: hits,
        total,
        skipped_dim: dim_skipped,
        compared,
    })
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
        embed_model: row.get(8).unwrap_or_default(),
        embed_dim: row.get(9).unwrap_or_default(),
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
            "SELECT id, title, uri, type, created_at, chunk_count, status, namespace, embed_model, embed_dim
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
    // 数据第一：删任何东西之前先备份（保留最近 3 份）。备份失败就中止删除。
    rag_backup(app, "delete")?;
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

// ============ 重建向量（reembed）：换嵌入模型后按原文重算，不需要重传文件 ============
//
// 为什么需要它：自适应维度让「换模型」不再是死功能，但换完之后旧块的维度不同，
// 检索会按维度分流跳过它们 —— 数据还在，只是搜不到。这时候唯一正确的动作是
// **用库里已有的 chunk 文本重新算一遍向量**（原文在 chunks.text，不需要用户重新上传文件）。
//
// 数据安全约定：
// - 一次重建 = 全有或全无：前端把所有批次算完才回调一次 update_vectors，
//   任一 id 不属于该来源就整批回滚，原数据不动。
// - 覆盖之前自动备份（rag_backup），保留最近 3 份。

/// 待重建的块（只有带向量的子块；父块没有向量，不参与）。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RagChunkRow {
    pub id: String,
    pub idx: i64,
    pub text: String,
    pub char_start: i64,
    pub char_end: i64,
    pub parent_idx: Option<i64>,
    /// 当前向量维度（length(vec)/4）。
    pub dim: i64,
    /// 当前向量由哪个模型产出（老数据为空串）。
    pub embed_model: String,
}

/// 列出某个来源下**带向量**的块（供前端重新嵌入）。只读。
pub fn rag_list_chunks(
    app: &AppHandle,
    source_id: String,
    namespace: Option<String>,
    plugin_id: Option<String>,
) -> Result<Vec<RagChunkRow>, String> {
    let ns = resolve_plugin_namespace(plugin_id.as_deref(), namespace);
    let conn = open_db(app)?;
    let owned: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sources WHERE id = ?1 AND namespace = ?2",
            params![source_id, ns],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("校验来源归属失败: {}", e))?;
    if owned.is_none() {
        return Err(format!("来源 {source_id} 不存在或不属于命名空间 {ns}"));
    }
    let mut stmt = conn
        .prepare(
            "SELECT id, idx, text, char_start, char_end, parent_idx, length(vec)/4, embed_model
             FROM chunks WHERE source_id = ?1 AND namespace = ?2 AND length(vec) > 0
             ORDER BY idx",
        )
        .map_err(|e| format!("准备查询失败: {}", e))?;
    let rows = stmt
        .query_map(params![source_id, ns], |row| {
            Ok(RagChunkRow {
                id: row.get(0)?,
                idx: row.get(1)?,
                text: row.get(2)?,
                char_start: row.get(3)?,
                char_end: row.get(4)?,
                parent_idx: row.get(5)?,
                dim: row.get(6)?,
                embed_model: row.get(7)?,
            })
        })
        .map_err(|e| format!("执行查询失败: {}", e))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("读取块失败: {}", e))?);
    }
    Ok(out)
}

/// 单块向量更新。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RagVecUpdate {
    pub id: String,
    pub vec: Vec<f32>,
    #[serde(default)]
    pub embed_model: Option<String>,
}

/// 批量写回新向量。**全有或全无**。
pub fn rag_update_vectors(
    app: &AppHandle,
    source_id: String,
    updates: Vec<RagVecUpdate>,
    namespace: Option<String>,
    plugin_id: Option<String>,
) -> Result<usize, String> {
    if updates.is_empty() {
        return Err("重建失败：没有要写回的向量".to_string());
    }
    let dim = updates[0].vec.len();
    if dim == 0 {
        return Err("重建失败：向量为空（嵌入未产出结果）".to_string());
    }
    if let Some(bad) = updates.iter().find(|u| u.vec.len() != dim) {
        return Err(format!(
            "重建失败：块 {} 维度 {} 与本批 {} 不一致",
            bad.id,
            bad.vec.len(),
            dim
        ));
    }
    let ns = resolve_plugin_namespace(plugin_id.as_deref(), namespace);

    // 数据第一：覆盖任何向量之前先备份
    rag_backup(app, "reembed")?;

    let mut conn = open_db(app)?;
    let batch_model = updates
        .iter()
        .find_map(|u| u.embed_model.clone().filter(|m| !m.trim().is_empty()))
        .unwrap_or_default();
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {}", e))?;

    // 归属校验：来源必须属于该命名空间（防跨模块覆盖别人的记忆）
    let owned: Option<i64> = tx
        .query_row(
            "SELECT 1 FROM sources WHERE id = ?1 AND namespace = ?2",
            params![source_id, ns],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("校验来源归属失败: {}", e))?;
    if owned.is_none() {
        return Err(format!("重建中止：来源 {source_id} 不存在或不属于命名空间 {ns}"));
    }

    let mut written = 0usize;
    for u in &updates {
        let model = u
            .embed_model
            .clone()
            .filter(|m| !m.trim().is_empty())
            .unwrap_or_else(|| batch_model.clone());
        let changed = tx
            .execute(
                "UPDATE chunks SET vec = ?1, embed_model = ?2
                 WHERE id = ?3 AND source_id = ?4 AND namespace = ?5",
                params![vec_to_blob(&u.vec), model, u.id, source_id, ns],
            )
            .map_err(|e| format!("写入向量失败（已回滚）: {}", e))?;
        if changed == 0 {
            return Err(format!(
                "重建中止：块 {} 不属于来源 {}（已回滚，原数据未改动）",
                u.id, source_id
            ));
        }
        written += 1;
    }

    tx.execute(
        "UPDATE sources SET embed_model = ?1, embed_dim = ?2, status = 'ready' WHERE id = ?3",
        params![batch_model, dim as i64, source_id],
    )
    .map_err(|e| format!("更新来源元数据失败（已回滚）: {}", e))?;

    upsert_namespace_state(&tx, &ns, &batch_model, dim)?;

    tx.commit().map_err(|e| format!("提交失败（已回滚）: {}", e))?;
    log::info!(
        "[rag] 重建完成：source={} 块数={} 维度={} 模型={}",
        source_id,
        written,
        dim,
        batch_model
    );
    Ok(written)
}

// ============ 统计（给 UI 判断"要不要重建"） ============

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DimStat {
    pub dim: i64,
    pub chunks: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ModelStat {
    pub model: String,
    pub chunks: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct RagStats {
    pub sources: i64,
    pub chunks: i64,
    pub dims: Vec<DimStat>,
    pub models: Vec<ModelStat>,
    /// 最近一次写入用的模型名（namespace_state；未写过的库为空）。
    #[serde(default)]
    pub current_model: String,
    /// 最近一次写入用的维度。
    #[serde(default)]
    pub current_dim: i64,
    /// 最近一次写入时间（RFC3339）。
    #[serde(default)]
    pub updated_at: String,
}

/// 命名空间内的维度/模型分布。换模型后 UI 据此提示"库里有 N 块是旧维度"。
pub fn rag_stats(
    app: &AppHandle,
    namespace: Option<String>,
    plugin_id: Option<String>,
) -> Result<RagStats, String> {
    let ns = resolve_plugin_namespace(plugin_id.as_deref(), namespace);
    let conn = open_db(app)?;

    let sources: i64 = conn
        .query_row(
            "SELECT count(*) FROM sources WHERE namespace = ?1",
            params![ns],
            |r| r.get(0),
        )
        .unwrap_or(0);
    let chunks: i64 = conn
        .query_row(
            "SELECT count(*) FROM chunks WHERE namespace = ?1 AND length(vec) > 0",
            params![ns],
            |r| r.get(0),
        )
        .unwrap_or(0);

    let mut dims = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT length(vec)/4 AS dim, count(*) FROM chunks
         WHERE namespace = ?1 AND length(vec) > 0 GROUP BY dim ORDER BY count(*) DESC",
    ) {
        if let Ok(rows) = stmt.query_map(params![ns], |row| {
            Ok(DimStat {
                dim: row.get(0)?,
                chunks: row.get(1)?,
            })
        }) {
            for r in rows.flatten() {
                dims.push(r);
            }
        }
    }

    let mut models = Vec::new();
    if let Ok(mut stmt) = conn.prepare(
        "SELECT COALESCE(NULLIF(embed_model, ''), '(未知)') AS m, count(*) FROM chunks
         WHERE namespace = ?1 AND length(vec) > 0 GROUP BY m ORDER BY count(*) DESC",
    ) {
        if let Ok(rows) = stmt.query_map(params![ns], |row| {
            Ok(ModelStat {
                model: row.get(0)?,
                chunks: row.get(1)?,
            })
        }) {
            for r in rows.flatten() {
                models.push(r);
            }
        }
    }

    // 最近一次写入的模型/维度（可能还没有记录 —— 老库第一次启动时为空）
    let state: Option<(String, i64, String)> = conn
        .query_row(
            "SELECT embed_model, embed_dim, updated_at FROM namespace_state WHERE namespace = ?1",
            params![ns],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| format!("读取命名空间状态失败: {}", e))?;
    let (current_model, current_dim, updated_at) = state.unwrap_or_default();

    Ok(RagStats {
        sources,
        chunks,
        dims,
        models,
        current_model,
        current_dim,
        updated_at,
    })
}

/// 清理「对话记录」类来源，只保留最近 `keep_recent` 条。
///
/// 为什么只清 `type='chat'`：persona / core / memory 是用户资产的浓缩，不能自动删。
/// 安全策略：
/// - 只在总数超过 `keep_recent * 1.5` 时才动手（避免每次启动都删一遍）
/// - `keep_recent < 10` 直接拒绝（防手滑把库清空）
/// - 删除前自动备份
pub fn rag_prune(
    app: &AppHandle,
    namespace: Option<String>,
    keep_recent: Option<usize>,
    plugin_id: Option<String>,
) -> Result<usize, String> {
    let keep = keep_recent.unwrap_or(200);
    if keep < 10 {
        return Err("keep_recent 至少 10（防误删）".to_string());
    }
    let ns = resolve_plugin_namespace(plugin_id.as_deref(), namespace);
    let mut conn = open_db(app)?;

    let total: i64 = conn
        .query_row(
            "SELECT count(*) FROM sources WHERE namespace = ?1 AND type = 'chat'",
            params![ns],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if (total.max(0) as usize) <= keep * 3 / 2 {
        return Ok(0); // 没超过 1.5 倍，不动
    }

    let ids: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT id FROM sources WHERE namespace = ?1 AND type = 'chat'
                 ORDER BY created_at DESC LIMIT -1 OFFSET ?2",
            )
            .map_err(|e| format!("准备清理语句失败: {}", e))?;
        let rows = stmt
            .query_map(params![ns, keep as i64], |row| row.get::<_, String>(0))
            .map_err(|e| format!("查询待清理来源失败: {}", e))?;
        let mut v = Vec::new();
        for r in rows {
            v.push(r.map_err(|e| format!("读取待清理来源失败: {}", e))?);
        }
        v
    };
    if ids.is_empty() {
        return Ok(0);
    }

    rag_backup(app, "prune")?;
    let tx = conn
        .transaction()
        .map_err(|e| format!("开启事务失败: {}", e))?;
    let mut deleted = 0usize;
    for id in &ids {
        deleted += tx
            .execute(
                "DELETE FROM sources WHERE id = ?1 AND namespace = ?2",
                params![id, ns],
            )
            .map_err(|e| format!("删除旧对话记录失败（已回滚）: {}", e))?;
    }
    tx.commit().map_err(|e| format!("提交失败（已回滚）: {}", e))?;
    log::info!(
        "[rag] prune：ns={} 原有 {} 条对话记录，保留 {} 条，删除 {} 条",
        ns,
        total,
        keep,
        deleted
    );
    Ok(deleted)
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
            // 显式打印请求形状：嵌入 400 最常见的原因是「模型不支持 /v1/embeddings」
            // 或「input 条数超过端点上限」，不打印就只能看到一行上游文案。
            eprintln!(
                "[rag-embed] 上游拒绝 HTTP {} · endpoint={} · model={} · 本批 {} 条 · 最长 {} 字
  响应体={}",
                status,
                endpoint,
                model,
                req.texts.len(),
                req.texts.iter().map(|t| t.chars().count()).max().unwrap_or(0),
                txt.chars().take(400).collect::<String>()
            );
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
