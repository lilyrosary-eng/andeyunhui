//! 内置静态分析（纯 Rust / MIT / 进程内 / 毫秒级）
//!
//! 双轨制里的**内置轨**，设计对齐 pentest 的既有范式（内置 TCP Connect 扫描 + 可选 naabu SYN）：
//! - **内置轨（本文件）**：`object` 解析 PE/ELF/Mach-O → 取可执行段 → `iced-x86` 线性反汇编
//!   → 基本块划分（跳转目标/顺序切割）→ CFG 边 → 交 `cfg.rs` 做控制流反混淆
//!   → 常量池（字符串/立即数）与符号（导入/导出/函数）
//! - **深度轨（static_analysis.rs）**：`ghidra_headless` 外部进程，提供 P-Code IR、
//!   跨指令集（ARM/MIPS…）与更准的函数边界；未安装时如实回落本轨（engine 字段标注来源）
//!
//! 能力边界（写清楚，避免又被当成「万能反编译器」）：
//! - 线性扫描（linear sweep）而非递归下降：嵌在代码段里的数据可能被误当指令；
//!   故此处的函数列表来自符号表 + 跳转目标，不做「函数边界精确重建」的承诺。
//! - 只支持 x86/x64（iced-x86 的范围）。ARM 等架构需深度轨（Ghidra）。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use object::{Object, ObjectSection, ObjectSymbol, SectionKind, SymbolKind};

use super::cfg::{deobfuscate_cfg, BasicBlock};

/// 单次分析最多反汇编的文本段字节数（防超大二进制把内存/时间拖爆）
const MAX_TEXT_BYTES: usize = 8 * 1024 * 1024;
/// 单次分析最多保留的指令数（实测 400k 指令≈1s，1.5M 仍属人工触发的可接受范围）
const MAX_INSTRUCTIONS: usize = 1_500_000;
/// 常量池最多保留条数
const MAX_STRINGS: usize = 300;
/// 函数列表最多保留条数
const MAX_FUNCTIONS: usize = 500;
/// 常量池最短字符串长度
const MIN_STRING_LEN: usize = 6;

/// 段信息（审计/展示用）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SectionInfo {
    pub name: String,
    /// 虚拟地址
    pub address: u64,
    pub size: u64,
    /// 是否可执行
    pub executable: bool,
    /// 是否含初始化数据
    pub data: bool,
}

/// 函数信息（符号表 + 跳转目标推断）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FunctionInfo {
    pub name: String,
    pub address: u64,
    pub size: usize,
    /// 来源：`symbol`（符号表）/ `call_target`（调用目标推断）
    pub source: &'static str,
}

/// 控制流反混淆摘要（**只出计数，不出图**）
///
/// 真实二进制的基本块可达 20 万级（实测 4.2MB PE 为 22.3 万），把 `real_blocks`
/// 全量塞进 IPC 响应会让前端卡死几十秒；图数据属分析内部产物，UI 只需要结论数字。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DeobfuscationSummary {
    pub original_block_count: usize,
    pub dispatcher_count: usize,
    pub real_block_count: usize,
    pub real_edge_count: usize,
}

/// 静态分析结果（内置轨）
///
/// 注意 IPC 体积：`blocks`/`edges` 仅在调用方显式要求图数据时填充（默认空），
/// 计数始终由 `block_count`/`edge_count` 给出。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct BinaryAnalysis {
    pub file: String,
    /// 容器格式：PE / ELF / Mach-O
    pub format: String,
    /// 架构：X86_64 / I386 / 其它（其它架构暂不支持反汇编，仅出段/符号/常量池）
    pub arch: String,
    pub entry: u64,
    pub is_64bit: bool,
    pub sections: Vec<SectionInfo>,
    pub functions: Vec<FunctionInfo>,
    /// 基本块总数（恒有值）
    pub block_count: usize,
    /// CFG 边总数（恒有值）
    pub edge_count: usize,
    /// 反汇编得到的基本块（默认空，`include_graph=true` 时填充）
    pub blocks: Vec<BasicBlock>,
    /// 基本块之间的边（block id → block id；默认空）
    pub edges: Vec<(usize, usize)>,
    pub instruction_count: usize,
    /// 常量池：字符串字面量（去重、按长度降序取前 N）
    pub strings: Vec<String>,
    pub imports: Vec<String>,
    pub exports: Vec<String>,
    /// 控制流反混淆摘要（裁掉高介数分发块后的真实块计数）
    pub deobfuscation: Option<DeobfuscationSummary>,
    /// WASM 模块结构（仅当输入是 WebAssembly 时存在；此时 blocks/edges 恒为空）
    pub wasm: Option<super::wasm::WasmSummary>,
    /// 实际使用的分析引擎（内置轨恒为 "builtin"；深度轨为 "ghidra"）
    pub engine: &'static str,
    /// 如实记录降级/截断原因
    pub warnings: Vec<String>,
}

impl BinaryAnalysis {
    /// 是否成功反汇编（有指令）
    pub fn disassembled(&self) -> bool {
        self.instruction_count > 0
    }
}

/// 反汇编产物（内部用）
struct Disasm {
    blocks: Vec<BasicBlock>,
    edges: Vec<(usize, usize)>,
    instruction_count: usize,
    call_targets: HashSet<u64>,
    warnings: Vec<String>,
}

/// 分析二进制文件（内置轨，同步阻塞；调用方应在 spawn_blocking 中执行）
///
/// `include_graph=false` 时不回传 blocks/edges（仅计数），避免 20 万级图数据过 IPC。
pub fn analyze_file(path: &Path, include_graph: bool) -> Result<BinaryAnalysis, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取文件失败 {}: {}", path.display(), e))?;
    analyze_bytes(&bytes, &path.display().to_string(), include_graph)
}

/// 分析内存中的二进制数据（便于测试与后续对内存 dump 复用）
pub fn analyze_bytes(bytes: &[u8], label: &str, include_graph: bool) -> Result<BinaryAnalysis, String> {
    if bytes.is_empty() {
        return Err("文件为空".to_string());
    }

    // WASM 走独立解析轨（wasmparser），与 PE/ELF/Mach-O 的反汇编轨并列
    if super::wasm::looks_like_wasm(bytes) {
        return analyze_wasm(bytes, label);
    }

    let obj = object::File::parse(bytes).map_err(|e| format!("不是可识别的目标文件（PE/ELF/Mach-O/WASM）: {}", e))?;

    let arch = format!("{:?}", obj.architecture());
    let is_64bit = obj.is_64();
    let format = match obj.format() {
        object::BinaryFormat::Pe => "PE",
        object::BinaryFormat::Elf => "ELF",
        object::BinaryFormat::MachO => "Mach-O",
        other => return Err(format!("暂不支持的目标格式: {:?}", other)),
    }
    .to_string();

    // —— 段 ——
    let mut sections = Vec::new();
    for s in obj.sections() {
        sections.push(SectionInfo {
            name: s.name().unwrap_or("<unnamed>").to_string(),
            address: s.address(),
            size: s.size(),
            executable: s.kind() == SectionKind::Text,
            data: s.kind() == SectionKind::Data || s.kind() == SectionKind::ReadOnlyData,
        });
    }

    // —— 符号：导入/导出/函数 ——
    let mut imports = Vec::new();
    let mut exports = Vec::new();
    let mut functions: Vec<FunctionInfo> = Vec::new();
    for sym in obj.symbols() {
        let name = sym.name().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        match sym.kind() {
            SymbolKind::Text => functions.push(FunctionInfo {
                name,
                address: sym.address(),
                size: sym.size() as usize,
                source: "symbol",
            }),
            _ => {}
        }
    }
    for sym in obj.dynamic_symbols() {
        let name = sym.name().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        match sym.kind() {
            SymbolKind::Text => functions.push(FunctionInfo {
                name,
                address: sym.address(),
                size: sym.size() as usize,
                source: "symbol",
            }),
            _ => {}
        }
    }
    if let Ok(imports_iter) = obj.imports() {
        // 迭代元素是 Result<Import>，flatten 掉解析失败的项；PE 允许按序号导入
        for i in imports_iter.flatten() {
            imports.push(name_or_ordinal(i.name()));
        }
    }
    if let Ok(exports_iter) = obj.exports() {
        for e in exports_iter.flatten() {
            exports.push(name_or_ordinal(e.name()));
        }
    }
    imports.sort();
    imports.dedup();
    exports.sort();
    exports.dedup();

    // —— 常量池：扫描数据段中的可打印 ASCII 串 ——
    let mut strings = extract_strings(&obj);

    // —— 反汇编 + 基本块 + CFG ——
    let mut warnings = Vec::new();
    let disasm = if is_x86_arch(&arch) {
        disassemble(&obj, bytes, is_64bit, &mut warnings)?
    } else {
        warnings.push(format!(
            "架构 {} 不在内置轨范围（仅 x86/x64）：已跳过反汇编，仅输出段/符号/常量池；如需跨架构分析请接入 Ghidra 深度轨",
            arch
        ));
        Disasm {
            blocks: Vec::new(),
            edges: Vec::new(),
            instruction_count: 0,
            call_targets: HashSet::new(),
            warnings: Vec::new(),
        }
    };

    // 调用目标补齐函数列表（符号表缺失时仍能给出可读的函数入口）
    let mut seen_addr: HashSet<u64> = functions.iter().map(|f| f.address).collect();
    for addr in &disasm.call_targets {
        if seen_addr.insert(*addr) {
            functions.push(FunctionInfo {
                name: format!("sub_{:x}", addr),
                address: *addr,
                size: 0,
                source: "call_target",
            });
        }
    }
    functions.sort_by_key(|f| f.address);
    if functions.len() > MAX_FUNCTIONS {
        warnings.push(format!(
            "函数列表超限：共 {} 个，仅保留前 {} 个（按地址序）",
            functions.len(),
            MAX_FUNCTIONS
        ));
        functions.truncate(MAX_FUNCTIONS);
    }

    // —— 控制流反混淆（cfg.rs 的图论解法真正上桌：输入即为真实基本块）——
    let block_count = disasm.blocks.len();
    let edge_count = disasm.edges.len();
    let deobfuscation = if disasm.blocks.is_empty() {
        None
    } else {
        let blocks: Vec<BasicBlock> = disasm
            .blocks
            .iter()
            .map(|b| BasicBlock {
                id: b.id,
                start_addr: b.start_addr,
                end_addr: b.end_addr,
                instr_count: b.instr_count,
                is_dispatcher: false,
            })
            .collect();
        let d = deobfuscate_cfg(blocks, disasm.edges.clone());
        Some(DeobfuscationSummary {
            original_block_count: d.original_block_count,
            dispatcher_count: d.dispatcher_count,
            real_block_count: d.real_blocks.len(),
            real_edge_count: d.real_edge_count,
        })
    };

    strings.sort_by(|a, b| b.len().cmp(&a.len()).then(a.cmp(b)));
    strings.dedup();
    strings.truncate(MAX_STRINGS);

    warnings.extend(disasm.warnings.clone());

    Ok(BinaryAnalysis {
        file: label.to_string(),
        format,
        arch,
        entry: obj.entry(),
        is_64bit,
        sections,
        functions,
        block_count,
        edge_count,
        blocks: if include_graph { disasm.blocks } else { Vec::new() },
        edges: if include_graph { disasm.edges } else { Vec::new() },
        instruction_count: disasm.instruction_count,
        strings,
        imports,
        exports,
        deobfuscation,
        wasm: None,
        engine: "builtin",
        warnings,
    })
}

/// WASM 模块分析（复用同一 `BinaryAnalysis` 出口，便于前端/AI 统一处理）
fn analyze_wasm(bytes: &[u8], label: &str) -> Result<BinaryAnalysis, String> {
    let w = super::wasm::analyze(bytes)?;
    let mut warnings = w.warnings.clone();
    warnings.push(
        "WASM 走结构解析轨（wasmparser）：给出节表/函数规模/控制块/调用数与常量池；\
         不做 DFG 数据流还原，也不执行模块"
            .to_string(),
    );
    // 把函数列表映射成通用的 FunctionInfo（地址字段填函数索引，便于 UI 直接展示）
    let functions: Vec<FunctionInfo> = w
        .functions
        .iter()
        .map(|f| FunctionInfo {
            name: format!("func[{}]", f.index),
            address: f.index as u64,
            size: f.size,
            source: "wasm_func",
        })
        .collect();
    Ok(BinaryAnalysis {
        file: label.to_string(),
        format: "WASM".to_string(),
        arch: format!("wasm-v{}", w.version),
        entry: 0,
        is_64bit: false,
        sections: Vec::new(),
        functions,
        block_count: 0,
        edge_count: 0,
        blocks: Vec::new(),
        edges: Vec::new(),
        instruction_count: w.total_instrs,
        strings: w.strings.clone(),
        imports: w.imports.clone(),
        exports: w.exports.clone(),
        deobfuscation: None,
        wasm: Some(w),
        engine: "wasmparser",
        warnings,
    })
}

/// 架构名是否在内置反汇编器（iced-x86）覆盖范围内
fn is_x86_arch(arch: &str) -> bool {
    matches!(arch, "X86_64" | "I386")
}

/// 把 `NameOrOrdinal` 转成可读字符串（PE 允许按序号导入/导出）
fn name_or_ordinal<T: AsRef<[u8]>>(n: object::read::NameOrOrdinal<T>) -> String {
    match n {
        object::read::NameOrOrdinal::Name(b) => String::from_utf8_lossy(b.as_ref()).to_string(),
        object::read::NameOrOrdinal::Ordinal(o) => format!("#{}", o),
    }
}

/// 扫描数据段提取可打印 ASCII 字符串（常量池：Salt/IV/URL/错误信息等常在此暴露）
fn extract_strings(obj: &object::File<'_>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for section in obj.sections() {
        let kind = section.kind();
        // 只看数据类段：代码段里的字节多为指令，误报率高
        if !(kind == SectionKind::Data
            || kind == SectionKind::ReadOnlyData
            || kind == SectionKind::UninitializedData
            || kind == SectionKind::Other
            || kind == SectionKind::OtherString)
        {
            continue;
        }
        let Ok(data) = section.data() else { continue };
        // 单段上限，避免超大资源段
        let data = if data.len() > 8 * 1024 * 1024 { &data[..8 * 1024 * 1024] } else { data };
        let mut cur: Vec<u8> = Vec::new();
        for &b in data {
            let printable = (0x20..0x7f).contains(&b) || b == b'\t';
            if printable {
                cur.push(b);
            } else {
                if cur.len() >= MIN_STRING_LEN {
                    if let Ok(s) = std::str::from_utf8(&cur) {
                        let s = s.trim().to_string();
                        if s.len() >= MIN_STRING_LEN && seen.insert(s.clone()) {
                            out.push(s);
                            if out.len() >= MAX_STRINGS * 4 {
                                return out; // 先粗限，最终由调用方排序截断
                            }
                        }
                    }
                }
                cur.clear();
            }
        }
    }
    out
}

/// 线性反汇编可执行段 → 基本块 + CFG 边 + 调用目标
///
/// 算法（两遍，均只依赖已解码的指令序列，不再二次解码）：
/// 1. 解码pass：线性扫描收集 (地址, 长度, 流控, 跳转目标)，同时收集领导者地址
///    （段首 + 跳转/调用目标 + 终止指令的下一条）
/// 2. 切块pass：按领导者地址切分基本块；再据每块末尾指令的类型连边
///    （跳转→目标块；条件跳转/调用→顺序后继块；返回/无条件跳转→无顺序后继）
fn disassemble(
    obj: &object::File<'_>,
    _bytes: &[u8],
    is_64bit: bool,
    warnings: &mut Vec<String>,
) -> Result<Disasm, String> {
    use iced_x86::{Decoder, DecoderOptions, FlowControl};

    /// 一条已解码指令的摘要
    struct Decoded {
        ip: u64,
        len: u32,
        flow: FlowControl,
        target: Option<u64>,
    }

    let bitness: u32 = if is_64bit { 64 } else { 32 };
    let mut blocks: Vec<BasicBlock> = Vec::new();
    let mut edges: Vec<(usize, usize)> = Vec::new();
    let mut instruction_count = 0usize;
    let mut call_targets: HashSet<u64> = HashSet::new();

    for section in obj.sections() {
        if section.kind() != SectionKind::Text {
            continue;
        }
        let Ok(data) = section.data() else { continue };
        let truncated = data.len() > MAX_TEXT_BYTES;
        let data = if truncated { &data[..MAX_TEXT_BYTES] } else { data };
        if data.is_empty() {
            continue;
        }
        if truncated {
            warnings.push(format!(
                "段 {} 超过 {}MB，仅反汇编前 {}MB",
                section.name().unwrap_or("<unnamed>"),
                MAX_TEXT_BYTES / 1024 / 1024,
                MAX_TEXT_BYTES / 1024 / 1024
            ));
        }

        let base = section.address();
        let mut decoder = Decoder::with_ip(bitness, data, base, DecoderOptions::NONE);

        // —— pass 1：解码 + 收集领导者 ——
        let mut instrs: Vec<Decoded> = Vec::new();
        let mut leaders: HashSet<u64> = HashSet::new();
        leaders.insert(base);
        let mut hit_cap = false;
        while decoder.can_decode() {
            let instr = decoder.decode();
            let ip = instr.ip();
            let len = instr.len() as u32;
            let flow = instr.flow_control();
            let target = near_branch_target(&instr);
            if let Some(t) = target {
                leaders.insert(t); // 跳转/调用目标都是新块起点
                if matches!(flow, FlowControl::Call) {
                    call_targets.insert(t);
                }
            }
            // 终止指令的下一条也是新块起点（条件跳转/调用的顺序落入）
            if is_block_terminator(flow) {
                leaders.insert(ip + len as u64);
            }
            instrs.push(Decoded { ip, len, flow, target });
            instruction_count += 1;
            if instruction_count >= MAX_INSTRUCTIONS {
                hit_cap = true;
                break;
            }
        }
        if hit_cap {
            warnings.push(format!(
                "指令数达上限 {}：已截断（大二进制建议用 Ghidra 深度轨）",
                MAX_INSTRUCTIONS
            ));
        }

        // —— pass 2：按领导者切块 ——
        let mut addr_to_block: HashMap<u64, usize> = HashMap::new();
        // 与 blocks 平行：每块的末尾语义（跳转目标 / 是否有顺序后继）
        let mut block_tail: Vec<(Option<u64>, bool)> = Vec::new();
        let mut open_start: Option<u64> = None;
        let mut open_instrs = 0usize;
        let mut open_end = base;
        let mut open_tail: (Option<u64>, bool) = (None, false);

        for d in &instrs {
            // 遇到领导者 → 先把上一块收尾
            if leaders.contains(&d.ip) && open_start.is_some() {
                let id = blocks.len();
                addr_to_block.insert(open_start.unwrap(), id);
                blocks.push(BasicBlock {
                    id,
                    start_addr: open_start.unwrap(),
                    end_addr: open_end,
                    instr_count: open_instrs,
                    is_dispatcher: false,
                });
                block_tail.push(open_tail);
                open_start = None;
                open_instrs = 0;
                open_tail = (None, false);
            }
            if open_start.is_none() {
                open_start = Some(d.ip);
            }
            open_instrs += 1;
            open_end = d.ip + d.len as u64;
            // 末尾语义：以终止指令为准（非终止指令的 fallthrough 由领导者切割保证）
            match d.flow {
                FlowControl::UnconditionalBranch | FlowControl::IndirectBranch => {
                    open_tail = (d.target, false);
                }
                FlowControl::ConditionalBranch => {
                    open_tail = (d.target, true);
                }
                FlowControl::Call | FlowControl::IndirectCall => {
                    open_tail = (d.target, true); // 调用后通常顺序继续
                }
                FlowControl::Return
                | FlowControl::Interrupt
                | FlowControl::Exception
                | FlowControl::XbeginXabortXend => {
                    open_tail = (None, false);
                }
                _ => {}
            }
            // 顺序落入下一条且下一条不是领导者时，本块继续（不在此收尾）
        }
        if let Some(start) = open_start {
            let id = blocks.len();
            addr_to_block.insert(start, id);
            blocks.push(BasicBlock {
                id,
                start_addr: start,
                end_addr: open_end,
                instr_count: open_instrs,
                is_dispatcher: false,
            });
            block_tail.push(open_tail);
        }

        // —— 连边：目标块必须存在（否则目标落在被截断/非代码区）——
        for (idx, (target, has_fallthrough)) in block_tail.iter().enumerate() {
            if let Some(t) = target {
                if let Some(&to) = addr_to_block.get(t) {
                    edges.push((idx, to));
                }
            }
            if *has_fallthrough {
                let end = blocks[idx].end_addr;
                if let Some(&to) = addr_to_block.get(&end) {
                    edges.push((idx, to));
                }
            }
        }
    }

    edges.sort_unstable();
    edges.dedup();

    Ok(Disasm {
        blocks,
        edges,
        instruction_count,
        call_targets,
        warnings: Vec::new(),
    })
}

/// 该流控类型是否结束当前基本块
fn is_block_terminator(flow: iced_x86::FlowControl) -> bool {
    use iced_x86::FlowControl::*;
    matches!(
        flow,
        UnconditionalBranch
            | IndirectBranch
            | ConditionalBranch
            | Return
            | IndirectCall
            | Call
            | Interrupt
            | XbeginXabortXend
            | Exception
    )
}

/// 取近跳转/调用的目标地址（相对位移型操作数；寄存器/内存间接跳转无静态目标）
fn near_branch_target(instr: &iced_x86::Instruction) -> Option<u64> {
    use iced_x86::{FlowControl, OpKind};
    match instr.flow_control() {
        FlowControl::UnconditionalBranch | FlowControl::ConditionalBranch | FlowControl::Call => {
            match instr.op0_kind() {
                OpKind::NearBranch16 | OpKind::NearBranch32 | OpKind::NearBranch64 => {
                    Some(instr.near_branch_target())
                }
                _ => None,
            }
        }
        _ => None,
    }
}

/// 统计各段大小（审计辅助）
pub fn section_summary(a: &BinaryAnalysis) -> BTreeMap<String, u64> {
    let mut m = BTreeMap::new();
    for s in &a.sections {
        m.insert(s.name.clone(), s.size);
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_errors() {
        assert!(analyze_bytes(&[], "empty", false).is_err());
    }

    #[test]
    fn garbage_input_errors_not_panics() {
        let junk = vec![0x41u8; 512];
        assert!(analyze_bytes(&junk, "junk", false).is_err());
    }

    #[test]
    fn x86_arch_detection() {
        assert!(is_x86_arch("X86_64"));
        assert!(is_x86_arch("I386"));
        assert!(!is_x86_arch("Aarch64"));
    }
}