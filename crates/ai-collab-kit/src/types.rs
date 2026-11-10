//! 协作域的数据类型：前后端共用一份形状，序列化统一 camelCase。
//!
//! 这里的字段刻意保持「宿主无关」：Room / Agent / Assignment / Event 都不依赖
//! 具体 harness。以后接入 ACP 或 CLI 时，只增加 AgentSpec 上的配置字段，
//! 不改变任务状态机本身。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 一个可接入的 harness 适配器（P0 只有 echo，其余为占位状态）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessInfo {
    pub id: String,
    pub name: String,
    /// echo | acp | stream-json | mailbox
    pub kind: String,
    pub available: bool,
    /// 给用户看的可用性说明（缺什么、P几接入）。
    pub detail: String,
}

/// 房间成员。`harness_id` 指向 HarnessInfo::id。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpec {
    pub id: String,
    pub name: String,
    pub harness_id: String,
    #[serde(default)]
    pub persona: String,
    #[serde(default)]
    pub model: String,
    /// ACP 原生会话 id。每个成员独立，避免多 agent 房间共用同一个 dsh 会话。
    #[serde(default)]
    pub native_session_id: Option<String>,
}

/// 房间的外部来源。当前支持从 DeepSeek Harness 的持久会话导入。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSource {
    /// dsh-import | native
    pub kind: String,
    #[serde(default)]
    pub session_id: Option<String>,
}

/// 一个协作房间（群聊 / 协作组态的最小单位）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Room {
    pub id: String,
    pub name: String,
    /// 默认承接未 @ 消息的成员 id。
    pub lead_id: String,
    pub agents: Vec<AgentSpec>,
    /// 房间绑定的工作目录。用于外部 harness 扫描 `.adyh/collab/` 镜像与执行 harness 的 cwd。
    #[serde(default)]
    pub workspace: Option<String>,
    /// 导入/原生来源；None 表示本模块原生新建。
    #[serde(default)]
    pub source: Option<RoomSource>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AssignmentStatus {
    Queued,
    Running,
    /// 等待子任务或等待用户输入（P0 暂不产生，保留给 P1 收件箱）。
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

impl AssignmentStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }
}

/// 一次任务的模型用量。
/// 目前只有自有 harness（native）能从响应里拿到；dsh / CLI / 信箱等外部 harness
/// 不回报用量时保持 None，界面显示「未知」而不是填 0 假装统计过。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskUsage {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
}

/// 一次任务分派。P0 只做单层与一层子任务，`parent_id` 已为 P1 的树保留。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
    pub id: String,
    pub room_id: String,
    pub parent_id: Option<String>,
    pub assignee_id: String,
    pub brief: String,
    pub status: AssignmentStatus,
    pub result: Option<String>,
    /// 谁认领了这个任务（MCP 的 `from`）。用于审计「外部 harness 接了哪单」。
    /// serde default 保证旧任务表仍能读。
    #[serde(default)]
    pub claimed_by: Option<String>,
    /// 真正开始执行的时刻（状态首次进入 running）。用于算 durationMs。
    #[serde(default)]
    pub started_at: Option<i64>,
    /// 执行耗时（毫秒）；排队时间不计入。旧任务没有这个字段时为空。
    #[serde(default)]
    pub duration_ms: Option<u64>,
    /// 模型用量；外部 harness 不回报时为空。
    #[serde(default)]
    pub usage: Option<TaskUsage>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// 协作事件。事件是持久化的唯一事实源，UI 只消费事件与任务快照。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollabEvent {
    pub seq: u64,
    pub at: i64,
    pub room_id: String,
    /// message | assignment.created | assignment.running |
    /// assignment.progress | assignment.completed | assignment.failed | assignment.cancelled
    pub kind: String,
    pub agent_id: Option<String>,
    pub assignment_id: Option<String>,
    pub text: Option<String>,
    pub assignment: Option<Assignment>,
    pub data: Option<Value>,
}

/// 前端进入房间时的一次性快照，避免逐条重放历史。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomSnapshot {
    pub room: Room,
    pub assignments: Vec<Assignment>,
    pub events: Vec<CollabEvent>,
}
