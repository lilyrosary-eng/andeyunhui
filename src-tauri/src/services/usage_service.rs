//! AI 用量 / 成本统计（持久化 + 聚合查询）。
//!
//! 设计要点：
//! - 持久化用 rusqlite（bundled SQLite），库位于 `app_data_dir()/usage.sqlite`。
//! - 每次对话请求结束时，从流式响应末尾的 `usage` 字段提取 token 数并落库一条记录。
//! - 既存原始 token，也按已知定价表折算成本（USD，6 位小数），记录时快照成本，
//!   避免日后改价影响历史记录。
//! - 聚合查询按「总览 + 按模型 + 按日」三视角返回，供前端用量面板渲染。
//!
//! 注意：本模块只做「记录 + 查询」，不负责采集。采集点在 ai_service/ai_chat.rs：
//! 流读结束拿到 `last_usage` 后调用 [record_usage_async] 落库。

use std::path::PathBuf;

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// SQLite 文件名（置于应用数据目录）。
const DB_FILENAME: &str = "usage.sqlite";

// ============ 成本表（USD / 每百万 tokens） ============
// OpenAI 兼容端点统一用 token 计费，这里按已知公开价快照折算，近似即可（历史单价本身会变）。
// 输入/输出分开存储，方便后续按需调整。_gen_ 开头的兜底单价仅用于未命中精确模型的 provider。
const PRICES: &[(&str, f64, f64)] = &[
    // (模型前缀, 输入价 USD/1M, 输出价 USD/1M)
    ("deepseek-chat", 0.27, 1.10),
    ("deepseek-reasoner", 0.55, 2.19),
    ("gpt-4o-mini", 0.15, 0.60),
    ("gpt-4o", 2.50, 10.00),
    ("claude-3-5-sonnet", 3.00, 15.00),
    ("claude-3-5-haiku", 0.80, 4.00),
    ("gemini-2.0-flash", 0.10, 0.40),
];

fn price_for(model: &str) -> (f64, f64) {
    let m = model.to_lowercase();
    for (prefix, pi, po) in PRICES {
        if m.starts_with(prefix) {
            return (*pi, *po);
        }
    }
    // 兜底：按 OpenAI 兼容一般价估算（避免 cost=0 误导，比例合理即可）
    (0.50, 1.50)
}

/// 提取到的单次用量数字（供 ai_chat 组装后落库）。
#[derive(Debug, Clone, Default)]
pub struct UsageNumbers {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cache_read: i64,
    pub cache_creation: i64,
}

/// 从 OpenAI 兼容 `usage` 对象稳妥提取整数（缺字段按 0）。兼容各厂字段差异：
/// - OpenAI：prompt_tokens / completion_tokens / total_tokens /
///   prompt_tokens_details.cached_tokens
/// - DeepSeek：prompt_cache_hit_tokens / prompt_cache_miss_tokens / total_tokens
/// - Anthropic：cache_read_input_tokens / cache_creation_input_tokens
pub fn parse_usage(usage: &serde_json::Value) -> UsageNumbers {
    let get = |json: &serde_json::Value, key: &str| -> i64 {
        json.get(key).and_then(|v| v.as_i64()).unwrap_or(0)
    };
    let mut u = UsageNumbers {
        prompt_tokens: get(usage, "prompt_tokens"),
        completion_tokens: get(usage, "completion_tokens"),
        cache_read: 0,
        cache_creation: 0,
    };
    // cache read
    let pc = get(usage, "prompt_cache_hit_tokens");
    if pc > 0 {
        u.cache_read = pc;
    }
    if let Some(pd) = usage.get("prompt_tokens_details") {
        let c = get(pd, "cached_tokens");
        if c > 0 {
            u.cache_read = c;
        }
    }
    let cr = get(usage, "cache_read_input_tokens");
    if cr > 0 {
        u.cache_read = cr;
    }
    // cache creation
    let cm = get(usage, "prompt_cache_miss_tokens");
    if cm > 0 {
        u.cache_creation = cm;
    }
    let cc = get(usage, "cache_creation_input_tokens");
    if cc > 0 {
        u.cache_creation = cc;
    }
    u
}

/// 由 token 数折算成本（USD），按模型输入/输出价。
pub fn calc_cost(model: &str, prompt_tokens: i64, completion_tokens: i64) -> f64 {
    let (pi, po) = price_for(model);
    (prompt_tokens as f64 / 1_000_000.0) * pi + (completion_tokens as f64 / 1_000_000.0) * po
}

// ============ 数据库访问 ============

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    Ok(dir.join(DB_FILENAME))
}

fn open(app: &AppHandle) -> Result<Connection, String> {
    let path = db_path(app)?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(&path).map_err(|e| format!("打开用量数据库失败: {}", e))?;
    init(&conn)?;
    Ok(conn)
}

fn init(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS usage_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            profile_id TEXT,
            provider TEXT,
            model TEXT,
            prompt_tokens INTEGER NOT NULL DEFAULT 0,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            cache_read INTEGER NOT NULL DEFAULT 0,
            cache_creation INTEGER NOT NULL DEFAULT 0,
            cost REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_stats(ts);
        CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_stats(model);",
    )
    .map_err(|e| format!("初始化用量表失败: {}", e))
}

/// 落库单次用量（阻塞 IO，调用方应经 spawn_blocking 包裹）。
pub fn record_usage(
    app: AppHandle,
    profile_id: String,
    provider: String,
    model: String,
    usage: UsageNumbers,
) -> Result<(), String> {
    let total = usage.prompt_tokens.saturating_add(usage.completion_tokens);
    let cost = calc_cost(&model, usage.prompt_tokens, usage.completion_tokens);
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let conn = open(&app)?;
    conn.execute(
        "INSERT INTO usage_stats
           (ts, profile_id, provider, model, prompt_tokens, completion_tokens, total_tokens, cache_read, cache_creation, cost)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            ts,
            profile_id,
            provider,
            model,
            usage.prompt_tokens,
            usage.completion_tokens,
            total,
            usage.cache_read,
            usage.cache_creation,
            cost
        ],
    )
    .map_err(|e| format!("写入用量记录失败: {}", e))?;
    Ok(())
}

/// 异步落库：把阻塞 IO 交给 spawn_blocking，供 ai_chat 等 async 场景直接 await。
pub async fn record_usage_async(
    app: &AppHandle,
    profile_id: String,
    provider: String,
    model: String,
    usage: UsageNumbers,
) {
    let app = app.clone();
    let _ = tokio::task::spawn_blocking(move || record_usage(app, profile_id, provider, model, usage))
        .await
        .map_err(|e| eprintln!("[usage] 落库任务失败: {}", e));
}

// ============ 聚合查询 ============

#[derive(Debug, Serialize)]
pub struct UsageModelStat {
    pub model: String,
    pub provider: String,
    pub requests: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub cost: f64,
}

#[derive(Debug, Serialize)]
pub struct UsageDayStat {
    /// 起算日（ts 所在自然日的 00:00 毫秒时间戳），前端可据此格式化。
    pub day: i64,
    pub requests: i64,
    pub total_tokens: i64,
    pub cost: f64,
}

#[derive(Debug, Serialize)]
pub struct UsageSummary {
    pub requests: i64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
    pub cost: f64,
    pub by_model: Vec<UsageModelStat>,
    /// 最近 N 天（含今天，缺的日期为 0）的逐日明细。
    pub by_day: Vec<UsageDayStat>,
}

/// 汇总查询：返回累计总览 + 按模型 + 最近 N 天逐日。`days` 默认 30。
#[tauri::command]
pub fn usage_stats(app: AppHandle, days: Option<u32>) -> Result<UsageSummary, String> {
    let conn = open(&app)?;

    let total: UsageSummary = conn
        .prepare(
            "SELECT COUNT(*),
                    COALESCE(SUM(prompt_tokens),0),
                    COALESCE(SUM(completion_tokens),0),
                    COALESCE(SUM(total_tokens),0),
                    COALESCE(SUM(cost),0)
             FROM usage_stats",
        )
        .and_then(|mut st| {
            st.query_row([], |r| {
                let mut s = UsageSummary {
                    requests: r.get(0)?,
                    prompt_tokens: r.get(1)?,
                    completion_tokens: r.get(2)?,
                    total_tokens: r.get(3)?,
                    cost: r.get(4)?,
                    by_model: Vec::new(),
                    by_day: Vec::new(),
                };
                // 保留 4 位小数避免浮点噪音
                s.cost = (s.cost * 10_000.0).round() / 10_000.0;
                Ok(s)
            })
        })
        .map_err(|e| format!("查询用量总览失败: {}", e))?;

    let by_model: Vec<UsageModelStat> = conn
        .prepare(
            "SELECT model, COALESCE(MAX(provider),''), COUNT(*),
                    COALESCE(SUM(prompt_tokens),0),
                    COALESCE(SUM(completion_tokens),0),
                    COALESCE(SUM(total_tokens),0),
                    COALESCE(SUM(cost),0)
             FROM usage_stats
             GROUP BY model
             ORDER BY total_tokens DESC",
        )
        .and_then(|mut st| {
            let rows = st.query_map([], |r| {
                let mut m = UsageModelStat {
                    model: r.get(0)?,
                    provider: r.get(1)?,
                    requests: r.get(2)?,
                    prompt_tokens: r.get(3)?,
                    completion_tokens: r.get(4)?,
                    total_tokens: r.get(5)?,
                    cost: r.get(6)?,
                };
                m.cost = (m.cost * 10_000.0).round() / 10_000.0;
                Ok(m)
            });
            rows.and_then(|r| r.collect::<Result<Vec<_>, _>>())
        })
        .unwrap_or_default();

    let days = days.unwrap_or(30).clamp(1, 365);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let day_ms = 86_400_000i64;
    let today_start = now_ms / day_ms * day_ms;

    // 按时段聚合（SQLite strftime 以秒计；用整数运算按 (ts/day) 分桶更稳）
    let buckets: std::collections::HashMap<i64, (i64, i64, f64)> = conn
        .prepare(
            "SELECT (ts / ?1) AS day, COUNT(*), COALESCE(SUM(total_tokens),0), COALESCE(SUM(cost),0)
             FROM usage_stats WHERE ts >= ?2 GROUP BY day",
        )
        .and_then(|mut st| {
            let rows = st.query_map(params![day_ms, today_start - (days - 1) as i64 * day_ms], |r| {
                Ok((r.get::<_, i64>(0)?, (r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, f64>(3)?)))
            });
            rows.and_then(|r| r.collect::<Result<Vec<_>, _>>())
        })
        .unwrap_or_default()
        .into_iter()
        .collect();

    let mut by_day: Vec<UsageDayStat> = (0..days)
        .map(|i| {
            let day = today_start - (days - 1 - i) as i64 * day_ms;
            let v = buckets.get(&day).copied().unwrap_or((0, 0, 0.0));
            UsageDayStat {
                day,
                requests: v.0,
                total_tokens: v.1,
                cost: (v.2 * 10_000.0).round() / 10_000.0,
            }
        })
        .collect();
    by_day.retain(|d| d.requests > 0);

    Ok(UsageSummary { by_model, by_day, ..total })
}

/// 清空用量记录（危险操作，谨慎调用）。
#[tauri::command]
pub fn usage_reset(app: AppHandle) -> Result<(), String> {
    let conn = open(&app)?;
    conn.execute("DELETE FROM usage_stats", [])
        .map_err(|e| format!("清空用量记录失败: {}", e))?;
    Ok(())
}