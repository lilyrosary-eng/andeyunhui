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
//! 接入状态（已定，勿再当成待办）：**暂不接入**。
//! 依据：内置轨（`disasm.rs`）已覆盖 x86/x64 的反汇编 / 基本块 / CFG / 常量池，
//! 且为进程内毫秒级；Ghidra headless 的增量价值只在 **P-Code IR** 与 **跨指令集**
//! （ARM/MIPS…），对 400MB 级外部依赖 + Java 运行时而言，当前不值得随包分发。
//! 接口、结果结构与路径解析均已对齐：需要时把 Ghidra 放到
//! `external-deps/全局/ghidra/`（或设 `GHIDRA_HEADLESS` 指向 analyzeHeadless）即可启用。
//! - 输入：二进制文件路径（PE/ELF/Mach-O）
//! - 输出：P-Code IR + 反汇编 + 函数列表 + 控制流图
//! - 调用方式：tokio::process::Command 调用 analyzeHeadless

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

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
/// 1. 环境变量 `GHIDRA_HEADLESS`（指向 analyzeHeadless 或 analyzeHeadless.bat）
/// 2. `external-deps/全局/ghidra/support/analyzeHeadless(.bat)`（与 ffmpeg、curl-impersonate
///    同一「全局」约定；打包后对应 `user_external_deps/全局/ghidra/`）
/// 3. 历史兼容路径 `external-deps/ghidra/support/analyzeHeadless.bat`
/// 4. 系统 PATH（`where analyzeHeadless` / `which analyzeHeadless`）
pub fn find_ghidra_headless() -> Option<PathBuf> {
    // 1. 环境变量（注意：此前写成 GHIDRE_HEADLESS 的拼写错误已修正）
    if let Ok(path) = std::env::var("GHIDRA_HEADLESS") {
        let p = PathBuf::from(path);
        if p.exists() {
            return Some(p);
        }
    }

    let launcher = if cfg!(windows) { "analyzeHeadless.bat" } else { "analyzeHeadless" };
    // 2/3. 仓库内约定路径（dev 用；release 下外部依赖走 AppData，由宿主注入搜索根）
    let dev_paths = [
        PathBuf::from("external-deps").join("全局").join("ghidra").join("support").join(launcher),
        PathBuf::from("external-deps").join("ghidra").join("support").join(launcher),
        // 开发态兜底：crate 目录 → 上两级即仓库根
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("external-deps")
            .join("全局")
            .join("ghidra")
            .join("support")
            .join(launcher),
    ];
    for p in dev_paths.iter() {
        if p.exists() {
            return Some(p.clone());
        }
    }

    // 4. PATH 扫描
    if let Ok(paths) = std::env::var("PATH") {
        for dir in std::env::split_paths(&paths) {
            let cand = dir.join(launcher);
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    None
}
