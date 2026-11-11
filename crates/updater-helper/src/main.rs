#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod apply;
mod paths;
mod task;
mod user;

/// 与 Tauri 更新配置里的公钥保持一致（base64 编码的 minisign 公钥文件内容）。
/// 由 scripts/updater-keys.mjs 生成后写入；发布构建前必须替换 PLACEHOLDER。
const PUBKEY_B64: &str = include_str!("pubkey.b64");

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("");
    let result = match command {
        "--install-task" => task::install(),
        "--uninstall-task" => task::uninstall(),
        "--apply" => apply::run(PUBKEY_B64.trim()),
        "--version" => {
            println!("andeyunhui-updater {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        _ => Err(
            "用法: andeyunhui-updater [--install-task|--uninstall-task|--apply|--version]"
                .to_string(),
        ),
    };

    if let Err(error) = result {
        paths::log(&format!("执行 {command} 失败: {error}"));
        eprintln!("{error}");
        std::process::exit(1);
    }
}
