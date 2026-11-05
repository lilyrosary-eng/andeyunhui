//! 独立 MCP 入口（开发 / 冒烟测试用）。
//!
//! 正式安装包不附带这个文件：宿主 exe 自身带 `--mcp` 就进入同一套实现，
//! 见 `ai_collab_kit::mcp`。保留它是为了不启动 GUI 也能验证协议与工具。

fn main() {
    std::process::exit(ai_collab_kit::mcp::run_stdio());
}
