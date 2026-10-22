// 全局 AI 服务（属于「全局」能力，供「茑萝 · AI 编程」子插件调用）
//
// 设计要点：
// - 插件沙箱屏蔽了 fetch / XMLHttpRequest / WebSocket，插件无法直接联网，
//   因此 LLM 调用必须走本 Rust 后端命令（reqwest 不受前端 CSP 约束）。
// - 兼容 OpenAI Chat Completions 协议（/v1/chat/completions），
//   可对接 OpenAI / DeepSeek / Moonshot / 通义 / 本地 Ollama 等一切兼容端点。
// - 流式输出：SSE 分块解析后通过 Tauri 事件 ai-delta / ai-done / ai-error 推给前端，
//   实现 Cursor / Claude Code 那样的逐字流式体验。
// - 配置（多份「模型档案」profiles，每份含 base_url / api_key / model / temperature 等）
//   持久化到 app_data_dir/ai_config.json，全局共享，任意插件都可读写；
//   ai_chat 可指定 profile_id 选用某份档案，未指定则用 active 激活项。

// 敏感字段（如 api_key）落盘加密：AES-256-GCM + scrypt 机器绑定，透明加解密
pub mod secret;

pub mod ai_profile;
pub mod legacy_compat;
pub mod caps_infer;
pub mod reasoning;
pub mod ai_discover;
pub mod ai_chat;
pub mod ai_tools;
pub mod gongfang_tools;
// codemode：模型写的 JS 跑在 QuickJS（rquickjs）里，工具调用不进模型上下文。
// 仅桌面编译（rquickjs 需要 cc 编译 QuickJS 源码；移动端不注册该工具）。
#[cfg(not(any(target_os = "android", target_os = "ios")))]
pub(crate) mod codemode;
pub mod ai_session;
pub mod ai_agent;
pub mod ai_ocr;
pub mod ai_conversations;
pub mod comfyui_build;
pub mod image_store;
pub mod caps_probe;
// 能力探测扩展：工具 / 向量 / 一次探多项（见模块注释）
pub mod caps_probe_ext;
// 从上游「上下文超限」报错里学真值并回写模型档案（覆盖率闭环，见模块注释）
pub mod ctx_learn;

// 对外重导出：保持 crate::services::ai_service::xxx 路径不变
// resolve_profile 与 ResolvedTarget / resolve_target 并存：11 个调用点改到 resolve_target
// 是 Task 3 的事，届时再摘掉 resolve_profile。
pub use ai_profile::{AiProfile, AiProfiles, AiConfig, Provider, ModelEntry, Caps, Overrides, Selection, ResolvedTarget, load_config, resolve_target, migrate_v1_to_v2, warm_profile_cache, ai_get_config, ai_set_config, ai_get_profiles, ai_set_profiles, ai_set_profile_thinking};
pub use legacy_compat::{to_legacy_profiles, from_legacy_profiles};
pub use ai_discover::{ai_fetch_models, FetchModelsInput, FetchModelsOutput, DiscoveredModel};
pub use ai_chat::{ChatMessage, ai_chat, ai_chat_cancel};
pub use ai_agent::{ai_chat_agent, ai_agent_approve, ai_agent_apply_edits, ai_agent_fork, ai_agent_replay, ai_agent_cancel, ai_agent_status, ai_agent_sessions, ai_agent_events};
pub use ai_ocr::{ai_test_connection, ai_vision_ocr, translate_text, ai_ocr_enhance, ocr_export_pdf};
pub use ai_conversations::{ai_get_conversations, ai_save_conversations};
pub use image_store::{ai_media_usage, ai_media_cleanup};
pub use caps_probe::{ai_probe_vision, ai_test_selfcheck};

// Tauri command 宏在各子模块生成 __cmd__<name> / __tauri_command_name_<name> 符号，
// main.rs 的 generate_handler 通过 ai_service::__cmd__* 路径引用，需一并重导出以保持路径不变。
pub use ai_profile::{__cmd__ai_get_profiles, __cmd__ai_set_profiles, __cmd__ai_set_profile_thinking, __cmd__ai_get_config, __cmd__ai_set_config, __tauri_command_name_ai_get_profiles, __tauri_command_name_ai_set_profiles, __tauri_command_name_ai_set_profile_thinking, __tauri_command_name_ai_get_config, __tauri_command_name_ai_set_config};
pub use ai_discover::{__cmd__ai_fetch_models, __tauri_command_name_ai_fetch_models};
pub use ai_chat::{__cmd__ai_chat, __cmd__ai_chat_cancel, __tauri_command_name_ai_chat, __tauri_command_name_ai_chat_cancel};
pub use ai_agent::{__cmd__ai_chat_agent, __cmd__ai_agent_approve, __cmd__ai_agent_apply_edits, __cmd__ai_agent_fork, __cmd__ai_agent_replay, __cmd__ai_agent_cancel, __cmd__ai_agent_status, __cmd__ai_agent_sessions, __cmd__ai_agent_events, __tauri_command_name_ai_chat_agent, __tauri_command_name_ai_agent_approve, __tauri_command_name_ai_agent_apply_edits, __tauri_command_name_ai_agent_fork, __tauri_command_name_ai_agent_replay, __tauri_command_name_ai_agent_cancel, __tauri_command_name_ai_agent_status, __tauri_command_name_ai_agent_sessions, __tauri_command_name_ai_agent_events};
pub use ai_ocr::{__cmd__ai_test_connection, __cmd__ai_vision_ocr, __cmd__translate_text, __cmd__ai_ocr_enhance, __cmd__ocr_export_pdf, __tauri_command_name_ai_test_connection, __tauri_command_name_ai_vision_ocr, __tauri_command_name_translate_text, __tauri_command_name_ai_ocr_enhance, __tauri_command_name_ocr_export_pdf};
pub use ai_conversations::{__cmd__ai_get_conversations, __cmd__ai_save_conversations, __tauri_command_name_ai_get_conversations, __tauri_command_name_ai_save_conversations};
pub use image_store::{__cmd__ai_media_usage, __cmd__ai_media_cleanup, __tauri_command_name_ai_media_usage, __tauri_command_name_ai_media_cleanup};
pub use caps_probe::{__cmd__ai_probe_vision, __cmd__ai_test_selfcheck, __tauri_command_name_ai_probe_vision, __tauri_command_name_ai_test_selfcheck};

// ============ 上游 4xx 诊断（2026-10-19） ============
//
// 背景：端点只回 `{"error":{"message":"Toolcall params are invalid, detail:invalid tool type"}}`，
// 前端拿到的就是这一行 —— 但**请求是谁发的、带了几个工具、哪个工具坏了，一概不知道**。
// 那次 400 的真因是 4 个工具 schema 漏了 `"type": "function"`，而 tools 是整批发送，
// 于是「一个工具写错 = 整个 agent 模式全废」，排查却只能靠翻代码。
//
// 这里统一在 4xx 分支把**请求形状**打出来（不回显 message 正文，避免日志里落隐私）。
pub(crate) fn log_rejected_request(
    scope: &str,
    url: &str,
    body: &serde_json::Value,
    status: u16,
    text: &str,
) {
    let msg_n = body
        .get("messages")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let tools = body.get("tools").and_then(|v| v.as_array());
    let tool_names: Vec<&str> = tools
        .map(|a| {
            a.iter()
                .filter_map(|t| t.pointer("/function/name").and_then(|n| n.as_str()))
                .collect()
        })
        .unwrap_or_default();
    let missing_type: Vec<&str> = tools
        .map(|a| {
            a.iter()
                .filter(|t| t.get("type").and_then(|v| v.as_str()) != Some("function"))
                .filter_map(|t| t.pointer("/function/name").and_then(|n| n.as_str()))
                .collect()
        })
        .unwrap_or_default();
    let roles: Vec<&str> = body
        .get("messages")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|m| m.get("role").and_then(|r| r.as_str())).collect())
        .unwrap_or_default();
    eprintln!(
        "[{scope}] 上游拒绝 HTTP {status}\n  url={url}\n  model={}\n  messages={msg_n} roles={roles:?}\n  tools={} 缺type={missing_type:?}\n  工具清单={tool_names:?}\n  effort={:?} thinking={:?} temperature={:?} max_tokens={:?}\n  stream={:?}\n  响应体={text}",
        body.get("model").and_then(|m| m.as_str()).unwrap_or("?"),
        tool_names.len(),
        body.get("reasoning_effort"),
        body.get("thinking"),
        body.get("temperature"),
        body.get("max_tokens"),
        body.get("stream"),
    );
}
