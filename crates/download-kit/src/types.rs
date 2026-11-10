//! 公共类型：下载规格 / 任务 / 分片 / 引擎配置 / 事件载荷。
//!
//! 序列化口径：
//! - 对外（命令返回值、事件）统一 camelCase，前端可直接消费；
//! - 状态枚举用 snake_case 字符串，落库与事件共用同一套字面量；
//! - SQLite 里除 `urls` / `headers` 两个 JSON 列外，其余都是标量。

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// 下载引擎。
///
/// - `Auto`：由内核按任务形态选择（HLS → ffmpeg，多段 → native）；
/// - `Native`：综合下载引擎1，内置分块多连接；
/// - `Simple`：综合下载引擎2，内置单连接兼容；
/// - 其余为外部引擎（aria2c / ffmpeg / curl / wget）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum EngineKind {
    #[default]
    Auto,
    Native,
    Simple,
    Aria2,
    Ffmpeg,
    Curl,
    Wget,
}

impl EngineKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Native => "native",
            Self::Simple => "simple",
            Self::Aria2 => "aria2",
            Self::Ffmpeg => "ffmpeg",
            Self::Curl => "curl",
            Self::Wget => "wget",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "native" => Some(Self::Native),
            "simple" => Some(Self::Simple),
            "aria2" => Some(Self::Aria2),
            "ffmpeg" => Some(Self::Ffmpeg),
            "curl" => Some(Self::Curl),
            "wget" => Some(Self::Wget),
            _ => None,
        }
    }
}

/// 任务状态机：
/// `queued → probing → downloading → merging → completed`
/// 任意活动态可 `paused`，`paused/failed/canceled` 可重新入队。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Queued,
    Probing,
    Downloading,
    Paused,
    Merging,
    Completed,
    Failed,
    Canceled,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Probing => "probing",
            Self::Downloading => "downloading",
            Self::Paused => "paused",
            Self::Merging => "merging",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Canceled => "canceled",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(Self::Queued),
            "probing" => Some(Self::Probing),
            "downloading" => Some(Self::Downloading),
            "paused" => Some(Self::Paused),
            "merging" => Some(Self::Merging),
            "completed" => Some(Self::Completed),
            "failed" => Some(Self::Failed),
            "canceled" => Some(Self::Canceled),
            _ => None,
        }
    }

    /// 正在占用调度槽位的状态。
    pub fn is_active(self) -> bool {
        matches!(self, Self::Probing | Self::Downloading | Self::Merging)
    }
}

/// 分片状态。`Downloading` 只用于运行期展示，落库时允许存在。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PartState {
    Pending,
    Downloading,
    Completed,
}

impl PartState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Downloading => "downloading",
            Self::Completed => "completed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "downloading" => Some(Self::Downloading),
            "completed" => Some(Self::Completed),
            _ => None,
        }
    }
}

/// 入队参数。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSpec {
    /// 1..n 个地址。多地址按顺序拼接（需要 ffmpeg），用于 B 站 durl 之类的分段视频。
    pub urls: Vec<String>,
    /// 完整文件路径，或以 `/` `\` 结尾的目录（此时用 URL 文件名）。
    pub save_path: String,
    #[serde(default)]
    pub referer: Option<String>,
    #[serde(default)]
    pub cookie: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
    /// 额外请求头（防盗链 / 自定义鉴权）。
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub engine: EngineKind,
    /// 单任务连接数；缺省取全局配置。
    #[serde(default)]
    pub connections: Option<u32>,
    /// 大小上限（字节），超过则拒绝，避免异常大文件写爆磁盘。
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

/// 下载任务（不含分片明细，列表接口用它）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadTask {
    pub id: String,
    pub urls: Vec<String>,
    pub save_path: String,
    /// 展示用文件名（save_path 的最后一段）。
    pub filename: String,
    #[serde(default)]
    pub referer: Option<String>,
    #[serde(default)]
    pub cookie: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// 请求的引擎（可能是 auto）。
    pub engine: EngineKind,
    /// 实际选中的引擎。
    #[serde(default)]
    pub resolved_engine: Option<EngineKind>,
    pub status: TaskStatus,
    pub total_bytes: u64,
    pub downloaded_bytes: u64,
    #[serde(default)]
    pub max_bytes: Option<u64>,
    pub connections: u32,
    #[serde(default)]
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub completed_at: Option<i64>,
}

/// 任务 + 分片明细（单任务查询接口用它）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskDetail {
    #[serde(flatten)]
    pub task: DownloadTask,
    pub parts: Vec<DownloadPart>,
}

/// 单个分片。`end` 为开区间（不包含），`0` 表示服务端未给长度。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadPart {
    pub index: u32,
    pub url: String,
    pub start: u64,
    pub end: u64,
    pub downloaded: u64,
    pub state: PartState,
    /// 分片临时文件（每片独立，避免并发 seek 竞争）。
    pub temp_path: String,
}

impl DownloadPart {
    /// 该分片应下载的总字节数；未知长度返回 0。
    pub fn expected(&self) -> u64 {
        self.end.saturating_sub(self.start)
    }
}

/// 引擎与队列配置。可持久化到 `<base>/config.json`，缺字段走默认值。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EngineConfig {
    /// 默认引擎；`auto` 表示按任务形态自动选。
    pub default_engine: EngineKind,
    /// 单任务默认连接数（默认 8、上限 32）。
    pub connections: u32,
    /// 同时运行的下载任务数。
    pub max_concurrent_tasks: u32,
    /// 单个分片失败后的重试次数。
    pub retries: u32,
    /// 重试退避基数（毫秒），按指数增长。
    pub retry_base_ms: u64,
    /// 重试退避上限（毫秒）。
    pub retry_max_ms: u64,
    pub connect_timeout_secs: u64,
    /// 两次读数据之间的最长静默时间；不限制整个请求，避免大文件被总时限掐断。
    pub read_timeout_secs: u64,
    pub user_agent: String,
    /// aria2c 可执行文件路径；留空则自动在 external-deps / PATH 查找。
    #[serde(default)]
    pub aria2_path: Option<String>,
    /// ffmpeg 可执行文件路径；留空则自动在 external-deps / PATH 查找。
    #[serde(default)]
    pub ffmpeg_path: Option<String>,
    /// curl 可执行文件路径；留空则自动在 external-deps / PATH 查找。
    #[serde(default)]
    pub curl_path: Option<String>,
    /// wget 可执行文件路径；留空则自动在 external-deps / PATH 查找。
    #[serde(default)]
    pub wget_path: Option<String>,
    /// 启动时是否自动续传上一进程遗留的活动任务；false 则置为暂停。
    pub resume_on_start: bool,
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            default_engine: EngineKind::Auto,
            connections: 8,
            max_concurrent_tasks: 3,
            retries: 4,
            retry_base_ms: 800,
            retry_max_ms: 30_000,
            connect_timeout_secs: 20,
            read_timeout_secs: 60,
            user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36".to_string(),
            aria2_path: None,
            ffmpeg_path: None,
            curl_path: None,
            wget_path: None,
            resume_on_start: true,
        }
    }
}

impl EngineConfig {
    /// 把越界值收敛到安全范围，避免用户传 0 连接 / 0 并发导致任务卡死。
    pub fn normalize(mut self) -> Self {
        self.connections = self.connections.clamp(1, 32);
        self.max_concurrent_tasks = self.max_concurrent_tasks.clamp(1, 8);
        self.retries = self.retries.min(10);
        self.retry_base_ms = self.retry_base_ms.clamp(100, 10_000);
        self.retry_max_ms = self.retry_max_ms.clamp(self.retry_base_ms, 120_000);
        self.connect_timeout_secs = self.connect_timeout_secs.clamp(5, 300);
        self.read_timeout_secs = self.read_timeout_secs.clamp(5, 900);
        self.user_agent = self.user_agent.trim().to_string();
        if self.user_agent.is_empty() {
            self.user_agent = Self::default().user_agent;
        }
        self.aria2_path = normalize_path(self.aria2_path);
        self.ffmpeg_path = normalize_path(self.ffmpeg_path);
        self.curl_path = normalize_path(self.curl_path);
        self.wget_path = normalize_path(self.wget_path);
        self
    }
}

fn normalize_path(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// 探测请求。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeRequest {
    pub url: String,
    #[serde(default)]
    pub referer: Option<String>,
    #[serde(default)]
    pub cookie: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

/// 探测结果。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    /// 跟随重定向后的最终地址。
    pub final_url: String,
    pub total_bytes: u64,
    pub accept_ranges: bool,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub filename: Option<String>,
}

/// 引擎描述：设置页/命令行只需消费这个列表，不必知道具体实现。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub kind: EngineKind,
    /// 展示名，例如「综合下载引擎1」。
    pub name: String,
    pub description: String,
    /// 内置（随应用编译）或外部可执行文件。
    pub builtin: bool,
    pub platform: String,
    pub available: bool,
    #[serde(default)]
    pub path: Option<String>,
    pub default: bool,
}

/// 引擎总览。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub default_engine: EngineKind,
    pub engines: Vec<EngineInfo>,
}

/// 进度事件载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressPayload {
    pub task_id: String,
    pub status: TaskStatus,
    pub downloaded: u64,
    pub total: u64,
    /// 字节/秒（按两次事件间隔估算）。
    pub speed: f64,
    pub connections: u32,
    pub parts_total: u32,
    pub parts_done: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
