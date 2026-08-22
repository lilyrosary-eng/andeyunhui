
// 全局 AI 服务 · 子模块：对话持久化（Conversations）
// （由 ai_service.rs 机械拆分而来，逻辑零改动）

use std::fs;
use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

// ========== 对话持久化 ==========
//
// 设计要点：
// - 对话（含多条历史 + 全部消息）持久化到 app_data_dir/ai_conversations.json，
//   与 ai_config.json 同目录、同模式（serde_json + fs::write），零新增依赖。
// - 不引入 NPSL / IndexedDB / SQLite：对话量级为「几条到几十条」桌面场景，
//   JSON 文件足够；强传染协议（GPL/AGPL 系）依赖被用户明确禁止。
// - 流式状态（streaming）不持久化：加载后所有消息默认 streaming=false。
// - 错误消息（error=true）仍持久化，便于回看失败上下文；前端可手动清除。

/// 单条对话消息（前端 Msg 的子集，仅持久化必要字段）
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AiMessage {
    pub id: String,
    pub role: String, // "user" | "assistant"
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<bool>,
}

/// 单条对话（含标题与全部消息）
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AiConversation {
    pub id: String,
    pub title: String,
    pub messages: Vec<AiMessage>,
}

/// 持久化的对话集合（顶层包装，便于后续扩展元数据字段）
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AiConversations {
    #[serde(default)]
    pub conversations: Vec<AiConversation>,
    /// 持久化时的活跃对话 id（前端 AiPanel 当前打开的对话）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_id: Option<String>,
}

fn conversations_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("获取应用数据目录失败: {}", e))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建应用数据目录失败: {}", e))?;
    Ok(dir.join("ai_conversations_v2.json"))
}

/// 读取全部持久化的对话；文件不存在或解析失败时返回空集合（不抛错，避免阻塞 UI）。
#[tauri::command]
pub fn ai_get_conversations(app: AppHandle) -> AiConversations {
    let path = match conversations_path(&app) {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[ai] 读取对话失败（路径）: {}", e);
            return AiConversations::default();
        }
    };
    if !path.exists() {
        return AiConversations::default();
    }
    let text = match fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) => {
            log::warn!("[ai] 读取对话失败（IO）: {}", e);
            return AiConversations::default();
        }
    };
    match serde_json::from_str::<AiConversations>(&text) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[ai] 解析对话 JSON 失败（已忽略旧格式）: {}", e);
            AiConversations::default()
        }
    }
}

/// 保存全部对话 + 当前激活 id。
/// 前端防抖调用（约 500ms），避免流式增量触发频繁磁盘写入。
#[tauri::command]
pub fn ai_save_conversations(app: AppHandle, payload: AiConversations) -> Result<(), String> {
    let path = conversations_path(&app)?;
    // 先写临时文件再 rename，避免写入中途崩溃导致 JSON 损坏（原子性近似）
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(&payload).map_err(|e| format!("序列化失败: {}", e))?;
    fs::write(&tmp, json).map_err(|e| format!("写入临时文件失败: {}", e))?;
    fs::rename(&tmp, &path).map_err(|e| format!("重命名失败: {}", e))?;
    Ok(())
}
