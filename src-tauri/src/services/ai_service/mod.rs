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
pub mod ai_chat;
pub mod ai_tools;
pub mod gongfang_tools;
pub mod ai_session;
pub mod ai_agent;
pub mod ai_ocr;
pub mod ai_conversations;

// 对外重导出：保持 crate::services::ai_service::xxx 路径不变
pub use ai_profile::{AiProfile, AiProfiles, load_profiles, resolve_profile, warm_profile_cache, ai_get_profiles, ai_set_profiles, ai_set_profile_thinking};
pub use ai_chat::{ChatMessage, ai_chat};
pub use ai_agent::{ai_chat_agent, ai_agent_approve, ai_agent_apply_edits, ai_agent_fork, ai_agent_replay, ai_agent_cancel, ai_agent_status, ai_agent_sessions, ai_agent_events};
pub use ai_ocr::{ai_test_connection, ai_vision_ocr, translate_text, ai_ocr_enhance, ocr_export_pdf};
pub use ai_conversations::{ai_get_conversations, ai_save_conversations};

// Tauri command 宏在各子模块生成 __cmd__<name> / __tauri_command_name_<name> 符号，
// main.rs 的 generate_handler 通过 ai_service::__cmd__* 路径引用，需一并重导出以保持路径不变。
pub use ai_profile::{__cmd__ai_get_profiles, __cmd__ai_set_profiles, __cmd__ai_set_profile_thinking, __tauri_command_name_ai_get_profiles, __tauri_command_name_ai_set_profiles, __tauri_command_name_ai_set_profile_thinking};
pub use ai_chat::{__cmd__ai_chat, __tauri_command_name_ai_chat};
pub use ai_agent::{__cmd__ai_chat_agent, __cmd__ai_agent_approve, __cmd__ai_agent_apply_edits, __cmd__ai_agent_fork, __cmd__ai_agent_replay, __cmd__ai_agent_cancel, __cmd__ai_agent_status, __cmd__ai_agent_sessions, __cmd__ai_agent_events, __tauri_command_name_ai_chat_agent, __tauri_command_name_ai_agent_approve, __tauri_command_name_ai_agent_apply_edits, __tauri_command_name_ai_agent_fork, __tauri_command_name_ai_agent_replay, __tauri_command_name_ai_agent_cancel, __tauri_command_name_ai_agent_status, __tauri_command_name_ai_agent_sessions, __tauri_command_name_ai_agent_events};
pub use ai_ocr::{__cmd__ai_test_connection, __cmd__ai_vision_ocr, __cmd__translate_text, __cmd__ai_ocr_enhance, __cmd__ocr_export_pdf, __tauri_command_name_ai_test_connection, __tauri_command_name_ai_vision_ocr, __tauri_command_name_translate_text, __tauri_command_name_ai_ocr_enhance, __tauri_command_name_ocr_export_pdf};
pub use ai_conversations::{__cmd__ai_get_conversations, __cmd__ai_save_conversations, __tauri_command_name_ai_get_conversations, __tauri_command_name_ai_save_conversations};

