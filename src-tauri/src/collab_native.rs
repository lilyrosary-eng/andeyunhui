//! 「安得云荟」自身 AI 作为 native harness 的桥接层。
//!
//! ai-collab-kit 只定义 `NativeRunner` 接口（它不能反向依赖宿主），
//! 本文件在桌面入口里把接口接到宿主 AI 配置：成员模型就是设置页里的模型 id，
//! 执行走无 UI 的 Agent 工具循环（`agent_collect`）——与 AI 对话共用同一套工具、
//! 审批底座和上下文压缩，不另写第二套执行器。

use ai_collab_kit::native::{NativeFuture, NativeRequest, NativeRunner};
use andeyunhui_lib::services::ai_service;
use std::sync::Arc;
use tauri::AppHandle;

pub struct AppAiRunner {
    app: AppHandle,
}

/// 注册一次即可；宿主重复注册（热重载 / 多次 setup）返回 false，忽略。
pub fn register(app: AppHandle) {
    if !ai_collab_kit::native::register(Arc::new(AppAiRunner { app })) {
        eprintln!("[ai-collab] native runner 已注册，忽略重复注册");
    }
}

impl NativeRunner for AppAiRunner {
    fn run(&self, request: NativeRequest) -> NativeFuture {
        let app = self.app.clone();
        Box::pin(async move {
            // 成员模型支持 `provider/model` 写法。实际端点由「该模型属于哪个供应商」决定，
            // 这里只取模型 id；provider 段仅作人类可读标注。
            let raw = request.model.trim();
            let model_id = raw.rsplit('/').next().unwrap_or(raw).trim().to_string();
            if !model_id.is_empty() {
                // 明确校验：resolve_target 找不到模型时会静默回落到当前选中模型，
                // 多模型协作里那等于「悄悄换了个模型执行」，必须变成错误。
                let config = ai_service::load_config(&app);
                let known = config
                    .providers
                    .iter()
                    .any(|provider| provider.models.iter().any(|model| model.id == model_id));
                if !known {
                    return Err(format!(
                        "成员模型 {raw} 不在 AI 配置里：请先在设置中添加该模型，或清空成员模型以跟随当前选中模型"
                    ));
                }
            }
            ai_service::agent_collect::run_collect(
                app,
                ai_service::agent_collect::CollectRequest {
                    prompt: request.prompt,
                    system: None,
                    profile_id: if model_id.is_empty() { None } else { Some(model_id) },
                    workspace: request.workspace,
                    request_id: request.assignment_id,
                    // 计划按房间分槽：同一房间的多次任务共享一份计划，不污染其它房间。
                    plan_scope: request.room_id,
                },
            )
            .await
        })
    }
}
