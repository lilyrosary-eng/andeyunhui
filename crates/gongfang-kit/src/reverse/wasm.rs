//! WebAssembly 语义解析（wasmparser，Apache-2.0 WITH LLVM-exception）
//!
//! 补齐逆向框架里「WASM 语义解析」这条宣称：**不执行** wasm，只做静态结构还原——
//! 节表 / 类型 / 导入导出 / 每个函数体的局部变量数与指令统计 / 控制块数 / 直接与间接调用数
//! / 数据段与其中的常量池字符串 / 自定义节名。
//!
//! 与 `disasm.rs` 的关系：二者同属「内置静态分析轨」，由 `disasm.rs` 按文件头 magic
//! 分发（`\0asm` → 本模块；PE/ELF/Mach-O → iced-x86 反汇编轨）。
//!
//! 能力边界（如实标注）：
//! - **不做** WASM → 表达式的语义等价还原，也不做 DFG（数据流图）——那需要 SSA 重建，
//!   属 Ghidra/专用反编译器范围；此处给的是「结构 + 规模 + 常量」，足以定位关键函数与硬编码
//! - 不执行、不验证运行时行为；`wasmparser` 的校验失败会如实回报，不做绕过

use std::collections::HashSet;

use wasmparser::{Operator, Parser, Payload};

/// 单个函数体的规模画像
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WasmFunction {
    /// 函数索引（含导入函数偏移）
    pub index: u32,
    /// 局部变量总数
    pub locals: usize,
    /// 指令数
    pub instrs: usize,
    /// 控制块数（block/loop/if 计数）
    pub blocks: usize,
    /// 调用次数（call + call_indirect）
    pub calls: usize,
    /// 函数体字节数
    pub size: usize,
}

/// WASM 模块静态结构
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WasmSummary {
    /// wasm 版本（当前为 1）
    pub version: u32,
    /// 类型（函数签名）数量
    pub type_count: usize,
    pub imports: Vec<String>,
    pub exports: Vec<String>,
    /// 内存段 / 表 / 全局数量
    pub memories: usize,
    pub tables: usize,
    pub globals: usize,
    /// 代码段函数总数（含被截断的部分）
    pub function_count: usize,
    /// 函数体明细（超限时只保留指令数最多的前 N 个）
    pub functions: Vec<WasmFunction>,
    pub total_instrs: usize,
    pub total_calls: usize,
    pub code_bytes: usize,
    pub data_segments: usize,
    pub data_bytes: usize,
    /// 数据段里的可打印字符串（常量池：URL/密钥/错误文案等常硬编码在此）
    pub strings: Vec<String>,
    pub custom_sections: Vec<String>,
    /// 如实记录截断/降级
    pub warnings: Vec<String>,
}

/// 函数明细最多保留条数（按指令数降序）
const MAX_FUNCTIONS: usize = 300;
/// 常量池最多保留条数
const MAX_STRINGS: usize = 300;
/// 常量池最短字符串长度
const MIN_STRING_LEN: usize = 6;

/// 是否为 WebAssembly 模块（magic: `\0asm`）
pub fn looks_like_wasm(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && &bytes[0..4] == b"\0asm"
}

/// 解析 WASM 模块（同步阻塞；调用方应在 spawn_blocking 中执行）
pub fn analyze(bytes: &[u8]) -> Result<WasmSummary, String> {
    if !looks_like_wasm(bytes) {
        return Err("不是 WebAssembly 模块（缺少 \\0asm magic）".to_string());
    }

    let mut s = WasmSummary {
        version: u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
        type_count: 0,
        imports: Vec::new(),
        exports: Vec::new(),
        memories: 0,
        tables: 0,
        globals: 0,
        function_count: 0,
        functions: Vec::new(),
        total_instrs: 0,
        total_calls: 0,
        code_bytes: 0,
        data_segments: 0,
        data_bytes: 0,
        strings: Vec::new(),
        custom_sections: Vec::new(),
        warnings: Vec::new(),
    };

    let mut seen_strings: HashSet<String> = HashSet::new();
    // 函数索引从「导入的函数」之后开始计数（wasm 约定）
    let mut imported_funcs = 0u32;

    for payload in Parser::new(0).parse_all(bytes) {
        let payload = match payload {
            Ok(p) => p,
            Err(e) => {
                // 解析中断时保留已收集的部分，并如实说明
                s.warnings.push(format!("解析中断（已保留此前收集的结构）: {}", e));
                break;
            }
        };
        match payload {
            Payload::TypeSection(reader) => {
                for group in reader {
                    match group {
                        Ok(g) => s.type_count += g.into_types().count(),
                        Err(e) => s.warnings.push(format!("类型节解析失败: {}", e)),
                    }
                }
            }
            Payload::ImportSection(reader) => {
                // 0.259 的导入节按「组」给出（compact_imports 提案）：
                // Single / Compact1（同模块多类型）/ Compact2（同模块同类型多名）三种形态都要处理
                for g in reader.into_iter().flatten() {
                    match g {
                        wasmparser::Imports::Single(_, imp) => {
                            if matches!(imp.ty, wasmparser::TypeRef::Func(_)) {
                                imported_funcs += 1;
                            }
                            s.imports.push(format!("{}.{}", imp.module, imp.name));
                        }
                        wasmparser::Imports::Compact1 { module, items } => {
                            for it in items.into_iter().flatten() {
                                if matches!(it.ty, wasmparser::TypeRef::Func(_)) {
                                    imported_funcs += 1;
                                }
                                s.imports.push(format!("{}.{}", module, it.name));
                            }
                        }
                        wasmparser::Imports::Compact2 { module, ty, names } => {
                            for n in names.into_iter().flatten() {
                                if matches!(ty, wasmparser::TypeRef::Func(_)) {
                                    imported_funcs += 1;
                                }
                                s.imports.push(format!("{}.{}", module, n));
                            }
                        }
                    }
                }
            }
            Payload::ExportSection(reader) => {
                for e in reader.into_iter().flatten() {
                    s.exports.push(e.name.to_string());
                }
            }
            Payload::MemorySection(reader) => {
                s.memories = reader.count() as usize;
            }
            Payload::TableSection(reader) => {
                s.tables = reader.count() as usize;
            }
            Payload::GlobalSection(reader) => {
                s.globals = reader.count() as usize;
            }
            Payload::CodeSectionStart { count, range, .. } => {
                s.function_count = count as usize;
                s.code_bytes = (range.end.saturating_sub(range.start)) as usize;
            }
            Payload::CodeSectionEntry(body) => {
                let index = imported_funcs + s.functions.len() as u32;
                let mut locals = 0usize;
                match body.get_locals_reader() {
                    Ok(reader) => {
                        for l in reader.into_iter().flatten() {
                            locals += l.0 as usize;
                        }
                    }
                    Err(e) => s.warnings.push(format!("函数 {} 局部变量表解析失败: {}", index, e)),
                }
                let mut instrs = 0usize;
                let mut blocks = 0usize;
                let mut calls = 0usize;
                let mut truncated = false;
                match body.get_operators_reader() {
                    Ok(mut reader) => {
                        while !reader.eof() {
                            match reader.read() {
                                Ok(op) => {
                                    instrs += 1;
                                    match op {
                                        Operator::Block { .. }
                                        | Operator::Loop { .. }
                                        | Operator::If { .. } => blocks += 1,
                                        Operator::Call { .. } | Operator::CallIndirect { .. } => calls += 1,
                                        _ => {}
                                    }
                                }
                                Err(e) => {
                                    s.warnings.push(format!("函数 {} 指令流解析中断: {}", index, e));
                                    truncated = true;
                                    break;
                                }
                            }
                        }
                    }
                    Err(e) => {
                        s.warnings.push(format!("函数 {} 指令流不可读: {}", index, e));
                        truncated = true;
                    }
                }
                if truncated {
                    s.warnings.push(format!("函数 {} 的统计在中断点处截断", index));
                }
                s.total_instrs += instrs;
                s.total_calls += calls;
                s.functions.push(WasmFunction {
                    index,
                    locals,
                    instrs,
                    blocks,
                    calls,
                    size: (body.range().end.saturating_sub(body.range().start)) as usize,
                });
            }
            Payload::DataSection(reader) => {
                for d in reader.into_iter().flatten() {
                    s.data_segments += 1;
                    s.data_bytes += d.data.len();
                    collect_strings(d.data, &mut s.strings, &mut seen_strings);
                }
            }
            Payload::CustomSection(c) => {
                let name = c.name().to_string();
                if !s.custom_sections.contains(&name) {
                    s.custom_sections.push(name);
                }
            }
            _ => {}
        }
    }

    if s.functions.len() > MAX_FUNCTIONS {
        let mut sorted = s.functions.clone();
        sorted.sort_by(|a, b| b.instrs.cmp(&a.instrs));
        s.warnings.push(format!(
            "函数明细超限：共 {} 个，仅保留指令数最多的前 {} 个（总量统计仍覆盖全部）",
            s.functions.len(),
            MAX_FUNCTIONS
        ));
        sorted.truncate(MAX_FUNCTIONS);
        sorted.sort_by_key(|f| f.index);
        s.functions = sorted;
    }

    s.strings.sort_by(|a, b| b.len().cmp(&a.len()).then(a.cmp(b)));
    s.strings.truncate(MAX_STRINGS);
    // 解析告警去重（同一原因可能对多个函数重复出现）
    s.warnings.dedup();

    Ok(s)
}

/// 从数据段字节里提取可打印字符串并去重累计
fn collect_strings(data: &[u8], out: &mut Vec<String>, seen: &mut HashSet<String>) {
    let mut cur: Vec<u8> = Vec::new();
    for &b in data.iter().chain(std::iter::once(&0u8)) {
        if (0x20..0x7f).contains(&b) || b == b'\t' {
            cur.push(b);
        } else {
            if cur.len() >= MIN_STRING_LEN {
                if let Ok(t) = std::str::from_utf8(&cur) {
                    let t = t.trim().to_string();
                    if t.len() >= MIN_STRING_LEN && seen.insert(t.clone()) {
                        out.push(t);
                        if out.len() >= MAX_STRINGS * 4 {
                            return;
                        }
                    }
                }
            }
            cur.clear();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn magic_detection() {
        assert!(looks_like_wasm(b"\0asm\x01\0\0\0"));
        assert!(!looks_like_wasm(b"MZ\x90\0"));
        assert!(!looks_like_wasm(b"\0as"));
    }

    #[test]
    fn minimal_module_parses() {
        // 最小合法模块：magic(4) + version(4)
        let m = b"\0asm\x01\0\0\0";
        let s = analyze(m).expect("minimal module should parse");
        assert_eq!(s.version, 1);
        assert_eq!(s.function_count, 0);
    }

    #[test]
    fn non_wasm_rejected() {
        assert!(analyze(b"MZ\x90\0\x03\0").is_err());
    }
}