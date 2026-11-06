//! ACP 权限桥接：把 agent 的 `session/request_permission` 变成用户可点的确认。
//!
//! 之前 acp_client 自动允许 `allow_once`、其余一律拒绝 —— 没有真正的「桥」。
//! 这里提供最小注册表：
//! - ACP 侧 `open()` 注册请求并拿到一个 oneshot 接收端；
//! - 前端调 `collab_permission_reply` 时 `reply()` 发送选择；
//! - 等待期间检查任务取消，超时按「拒绝」处理，避免 agent 永久卡住。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;
use tokio::sync::oneshot;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionPrompt {
    pub permission_id: String,
    pub room_id: String,
    pub assignment_id: String,
    pub title: String,
    pub tool_kind: Option<String>,
    pub options: Vec<PermissionOption>,
}

impl PermissionPrompt {
    pub fn payload(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::Value::Null)
    }
}

static PENDING: OnceLock<Mutex<HashMap<String, oneshot::Sender<Option<String>>>>> = OnceLock::new();

fn pending() -> &'static Mutex<HashMap<String, oneshot::Sender<Option<String>>>> {
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 注册一次权限请求，返回等待用户选择的接收端。
pub fn open(prompt: &PermissionPrompt) -> Result<oneshot::Receiver<Option<String>>, String> {
    let (sender, receiver) = oneshot::channel();
    pending()
        .lock()
        .map_err(|_| "权限注册表锁已损坏".to_string())?
        .insert(prompt.permission_id.clone(), sender);
    Ok(receiver)
}

/// 前端确认。返回是否命中一个仍在等待的请求。
pub fn reply(permission_id: &str, option_id: Option<&str>) -> bool {
    let sender = pending()
        .lock()
        .ok()
        .and_then(|mut map| map.remove(permission_id));
    match sender {
        Some(sender) => sender.send(option_id.map(|value| value.to_string())).is_ok(),
        None => false,
    }
}

fn discard(permission_id: &str) {
    if let Ok(mut map) = pending().lock() {
        map.remove(permission_id);
    }
}

/// 等待用户选择；`None` 表示超时 / 任务被取消 / 用户拒绝。
pub async fn wait(
    permission_id: &str,
    receiver: oneshot::Receiver<Option<String>>,
    assignment_id: &str,
    timeout: Duration,
) -> Option<String> {
    let cancel = async {
        loop {
            if crate::runtime::is_cancelled(assignment_id) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    };
    let selected = tokio::select! {
        result = tokio::time::timeout(timeout, receiver) => {
            result.ok().and_then(|inner| inner.ok()).flatten()
        },
        _ = cancel => None,
    };
    discard(permission_id);
    selected
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prompt() -> PermissionPrompt {
        PermissionPrompt {
            // 注册表是进程级全局，测试并行跑时必须用唯一 id，否则两个用例会互相覆盖 sender。
            permission_id: crate::runtime::new_id("perm"),
            room_id: "room_perm".to_string(),
            assignment_id: "task_perm".to_string(),
            title: "运行 npm test".to_string(),
            tool_kind: Some("execute".to_string()),
            options: vec![
                PermissionOption {
                    option_id: "allow_once".to_string(),
                    name: "允许一次".to_string(),
                    kind: "allow_once".to_string(),
                },
                PermissionOption {
                    option_id: "reject_once".to_string(),
                    name: "拒绝".to_string(),
                    kind: "reject_once".to_string(),
                },
            ],
        }
    }

    #[tokio::test]
    async fn reply_resolves_waiter() {
        let prompt = prompt();
        let receiver = open(&prompt).unwrap();
        assert!(reply(&prompt.permission_id, Some("allow_once")));
        let selected = wait(
            &prompt.permission_id,
            receiver,
            "task_perm",
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(selected.as_deref(), Some("allow_once"));
        // 请求已消费，重复回复必须失败（避免旧按钮误触发）。
        assert!(!reply(&prompt.permission_id, None));
    }

    #[tokio::test]
    async fn timeout_cancels_request() {
        let prompt = prompt();
        let receiver = open(&prompt).unwrap();
        let selected = wait(
            &prompt.permission_id,
            receiver,
            "task_perm",
            Duration::from_millis(100),
        )
        .await;
        assert!(selected.is_none());
        assert!(!reply(&prompt.permission_id, Some("allow_once")));
    }
}
