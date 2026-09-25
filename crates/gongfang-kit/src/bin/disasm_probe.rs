//! 内置静态分析探针（dev-only）
//!
//! 用途：对真实二进制跑一遍**产品路径**（`commands::gongfang_binary_analyze`，
//! 即前端/AI 实际调用的那个命令，含 spawn_blocking 与体积校验），
//! 验证「段 / 符号 / 反汇编指令数 / 基本块 / CFG 边 / 常量池 / 反混淆」是否真有产出，
//! 并给出耗时——这是「逆向框架已交付能力」的可复现证据。
//!
//! 运行（在 crates/gongfang-kit 内）：
//!   cargo run --bin disasm_probe --features reverse -- <二进制路径>
//!   cargo run --bin disasm_probe --features reverse            # 默认拿本机 PE 样本
//!
//! 说明：bin 是独立 crate root，故经包名 `gongfang_kit` 引用 lib。
#![cfg(feature = "reverse")]

use std::path::PathBuf;

/// 默认样本：本仓已有的真实 Windows PE（4.1MB，curl-impersonate）
const DEFAULT_SAMPLE: &str = "../../external-deps/全局/curl-impersonate/curl-impersonate.exe";

#[tokio::main]
async fn main() {
    let arg = std::env::args().nth(1);
    let path = PathBuf::from(arg.unwrap_or_else(|| DEFAULT_SAMPLE.to_string()));
    println!("=== 内置静态分析探针（走产品命令 gongfang_binary_analyze）===");
    println!("样本: {}", path.display());

    if !path.exists() {
        println!("✗ 样本不存在；请传入一个 PE/ELF/Mach-O 路径");
        return;
    }

    let path_str = path.display().to_string();
    let started = std::time::Instant::now();
    let r = match gongfang_kit::commands::gongfang_binary_analyze(path_str, Some(true)).await {
        Ok(r) => r,
        Err(e) => {
            println!("✗ 分析失败: {e}");
            return;
        }
    };
    let elapsed = started.elapsed();

    println!("engine   = {}", r.engine);
    println!("format   = {} / arch = {} ({}bit)", r.format, r.arch, if r.is_64bit { 64 } else { 32 });
    println!("entry    = {:#x}", r.entry);
    println!("段       = {} 个", r.sections.len());
    for s in r.sections.iter().take(12) {
        println!("   {:<12} addr={:#010x} size={:<9} code={} data={}", s.name, s.address, s.size, s.executable, s.data);
    }
    println!("函数     = {} 个", r.functions.len());
    for f in r.functions.iter().take(8) {
        println!("   {:#010x}  {:<40} [{}]", f.address, f.name, f.source);
    }
    println!("指令     = {}", r.instruction_count);
    println!("基本块   = {}（回传 {} 条）", r.block_count, r.blocks.len());
    println!("CFG 边   = {}（回传 {} 条）", r.edge_count, r.edges.len());
    if let Some(d) = &r.deobfuscation {
        println!(
            "反混淆   = 原块 {} / 识别分发块 {} / 剩余真实块 {} / 剩余边 {}",
            d.original_block_count, d.dispatcher_count, d.real_block_count, d.real_edge_count
        );
    }
    println!("导入     = {} 个（示例）{:?}", r.imports.len(), r.imports.iter().take(5).collect::<Vec<_>>());
    println!("导出     = {} 个（示例）{:?}", r.exports.len(), r.exports.iter().take(5).collect::<Vec<_>>());
    println!("常量池   = {} 条（示例）", r.strings.len());
    for s in r.strings.iter().take(10) {
        println!("   {s}");
    }
    if !r.warnings.is_empty() {
        println!("警告:");
        for w in &r.warnings {
            println!("   · {w}");
        }
    }
    println!("耗时     = {} ms", elapsed.as_millis());
    println!(
        "\n自检: 反汇编={} 基本块={} 边={} 常量池={}",
        if r.disassembled() { "✓" } else { "✗" },
        r.blocks.len() > 0,
        r.edges.len() > 0,
        r.strings.len() > 0
    );
}