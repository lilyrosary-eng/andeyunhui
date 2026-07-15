// ================= 专业模块「薄荷」后端工具依赖包 =================
// 作为内部 crate（path dependency）独立存在，主程序通过 `use pro_tools_kit::commands::*;` 引入。
//
// 设计说明：Tauri 2 的 `#[tauri::command]` 宏在 crate 根（lib.rs）中定义时，
// 函数不能标记为 `pub`（否则触发 E0255: `__cmd__xxx` 重复定义）。
// 因此将所有命令放在 `commands` 子模块中，由 lib.rs 重新导出。
pub mod commands;
