//! 静态分析（ghidra_headless 外部进程接口）
//!
//! 对应逆向细化维度六：跨指令集IR的务实降级。
//!
//! 替代原方案：
//! - 自建SSA IR（inkwell/LLVM 编译数小时）→ 删除
//! - 增量式重编译 → 删除
//! - 平台无关IR生成 → 用 ghidra_headless 输出 P-Code
//!
//! project_memory 硬约束："IR 分析用 ghidra_headless 外部进程而非 inkwell（避免 LLVM 编译数小时）"
//!
//! 接口占位：后续接入 ghidra_headless 外部进程
//! - 输入：二进制文件路径（PE/ELF/Mach-O）
//! - 输出：P-Code IR + 反汇编 + 函数列表 + 控制流图
//! - 调用方式：tokio::process::Command 调用 analyzeHeadless

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use super::cfg::BasicBlock;

/// 静态分析结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StaticAnalysisResult {
    /// 函数列表
    pub functions: Vec<FunctionInfo>,
    /// 控制流图（按函数分组）
    pub cfgs: HashMap<String, (Vec<BasicBlock>, Vec<(usize, usize)>)>,
    /// P-Code IR（Ghidra 输出）
    pub pcode: String,
}

/// 函数信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FunctionInfo {
    pub name: String,
    pub address: u64,
    pub size: usize,
    pub calling_convention: String,
}

/// 调用 ghidra_headless 进行静态分析（接口占位）
///
/// 命令示例：
/// ```sh
/// analyzeHeadless <project_dir> <project_name> \
///   -import <binary_path> \
///   -postScript ExportPCode.java \
///   -scriptPath <script_dir> \
///   -export <output_dir>
/// ```
pub async fn analyze_binary(
    binary_path: PathBuf,
    ghidra_headless_path: PathBuf,
) -> Result<StaticAnalysisResult, String> {
    log::info!(
        "[reverse] 静态分析 {} (ghidra_headless={})",
        binary_path.display(),
        ghidra_headless_path.display()
    );

    // TODO: 接入 ghidra_headless 外部进程
    // 1. 创建临时 Ghidra 项目
    // 2. 导入二进制文件
    // 3. 运行分析脚本（输出 P-Code + CFG + 函数列表）
    // 4. 解析输出 JSON
    // 5. 返回 StaticAnalysisResult

    log::warn!("[reverse] ghidra_headless 接口未实现，返回空结果");
    Ok(StaticAnalysisResult {
        functions: Vec::new(),
        cfgs: HashMap::new(),
        pcode: String::new(),
    })
}

/// 查找 ghidra_headless 可执行文件
///
/// 搜索顺序：
/// 1. 环境变量 GHIDRE_HEADLESS
/// 2. external-deps/ghidra/support/analyzeHeadless.bat
/// 3. 系统路径
pub fn find_ghidra_headless() -> Option<PathBuf> {
    // 1. 环境变量
    if let Ok(path) = std::env::var("GHIDRE_HEADLESS") {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }

    // 2. external-deps（开发环境）
    let dev_path = PathBuf::from("external-deps/ghidra/support/analyzeHeadless.bat");
    if dev_path.exists() {
        return Some(dev_path);
    }

    // 3. 系统路径（where analyzeHeadless）
    None
}
