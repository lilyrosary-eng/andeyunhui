//! 办公模块 · 表格公式（spike）
//!
//! 复用 gridcraft 的纯数据层 + 计算层（MIT OR Apache-2.0，不依赖 egui）：
//! - `sheet_calc`：前端把整张表的原文（数字 / 文本 / `=公式`）发来，后端建临时工作簿、
//!   全量重算并返回每个单元格的显示值。无状态，不做持久化。
//! - `sheet_read_xlsx`：读取 .xlsx 并保留公式原文，供前端导入时不再被 SheetJS 扁平化。
//!
//! 约定：行/列均为 0 基，与前端 `data[r][c]` 一致。

use super::*;
use gridcraft_calc::Calc;
use gridcraft_core::parse::parse_input;
use gridcraft_core::CellRef;
use gridcraft_model::{Cell, Formula, Workbook};
use std::sync::Arc;

/// 单次求值的单元格上限（前端网格 100×26，留足余量；超过说明调用方异常）。
const MAX_CELLS: usize = 20_000;
/// 导入时只取左上角一块：超大表整表回传会撑爆 IPC。
const MAX_IMPORT_ROWS: u32 = 2_000;
const MAX_IMPORT_COLS: u32 = 128;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetCellInput {
    pub row: u32,
    pub col: u32,
    pub text: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SheetCellOut {
    pub row: u32,
    pub col: u32,
    /// 原文（仅导入时回传；`=` 开头的公式会保留 `=`）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// 计算结果（General 格式；错误值为 `#DIV/0!` 等）。
    pub display: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetData {
    pub name: String,
    pub cells: Vec<SheetCellOut>,
}

fn make_cell(text: &str, date_system: gridcraft_core::DateSystem) -> Cell {
    if text.trim_start().starts_with('=') {
        Cell {
            value: gridcraft_core::Value::Empty,
            formula: Some(Arc::new(Formula::new(text))),
            style: Default::default(),
        }
    } else {
        let parsed = parse_input(text, date_system);
        Cell { value: parsed.value, formula: None, style: Default::default() }
    }
}

fn calc_cells(cells: Vec<SheetCellInput>) -> Result<Vec<SheetCellOut>, String> {
    if cells.len() > MAX_CELLS {
        return Err(format!("单元格数量超过上限: {} > {}", cells.len(), MAX_CELLS));
    }
    let mut wb = Workbook::new();
    let date_system = wb.date_system;
    for c in &cells {
        let at = CellRef::new(c.row, c.col);
        if !at.is_valid() {
            return Err(format!("非法单元格坐标: r{}c{}", c.row, c.col));
        }
        if c.text.is_empty() {
            continue;
        }
        let cell = make_cell(&c.text, date_system);
        if let Some(sh) = wb.sheet_mut(0) {
            sh.set_cell(at, cell);
        }
    }
    let mut calc = Calc::new();
    calc.recalc_all(&mut wb);
    let sh = wb.sheet(0).ok_or_else(|| "工作表缺失".to_string())?;
    // 保留入参顺序，空单元格不回传（前端按 key 覆盖即可）。
    Ok(cells
        .iter()
        .filter(|c| !c.text.is_empty())
        .map(|c| SheetCellOut {
            row: c.row,
            col: c.col,
            text: None,
            display: sh.value(CellRef::new(c.row, c.col)).display(),
        })
        .collect())
}

/// 无状态求值：输入整张表的原文，返回每个非空单元格的计算结果。
/// 走 blocking 线程池，避免大表重算卡住 Tauri IPC。
#[tauri::command]
pub async fn sheet_calc(cells: Vec<SheetCellInput>) -> Result<Vec<SheetCellOut>, String> {
    tauri::async_runtime::spawn_blocking(move || calc_cells(cells))
        .await
        .map_err(|e| format!("表格计算线程异常: {}", e))?
}

fn read_xlsx_sheets(bytes: &[u8]) -> Result<Vec<SheetData>, String> {
    let (mut wb, _report) = gridcraft_xlsx::read_xlsx(bytes).map_err(|e| format!("解析 XLSX 失败: {}", e))?;
    let mut calc = Calc::new();
    calc.recalc_all(&mut wb);
    let mut out = Vec::new();
    for i in 0..wb.sheets.len() {
        let sh = match wb.sheet(i) {
            Some(s) => s,
            None => continue,
        };
        let mut cells = Vec::new();
        if let Some(range) = sh.cells.used_range() {
            for (cref, cell) in sh.cells.iter_range(range) {
                if cref.row >= MAX_IMPORT_ROWS || cref.col >= MAX_IMPORT_COLS {
                    continue;
                }
                let display = sh.value(cref).display();
                let text = match &cell.formula {
                    Some(f) => format!("={}", f.text),
                    None => display.clone(),
                };
                cells.push(SheetCellOut { row: cref.row, col: cref.col, text: Some(text), display });
            }
        }
        cells.sort_by_key(|c| (c.row, c.col));
        out.push(SheetData { name: sh.name.clone(), cells });
    }
    Ok(out)
}

/// 读取 .xlsx：保留公式原文 + 计算值（含 Excel 缓存值被重算覆盖）。
#[tauri::command]
pub async fn sheet_read_xlsx(file_path: String) -> Result<Vec<SheetData>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = std::fs::read(&file_path).map_err(|e| format!("读取 XLSX 失败: {}", e))?;
        read_xlsx_sheets(&bytes)
    })
    .await
    .map_err(|e| format!("XLSX 解析线程异常: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(row: u32, col: u32, text: &str) -> SheetCellInput {
        SheetCellInput { row, col, text: text.to_string() }
    }

    fn display_of(out: &[SheetCellOut], row: u32, col: u32) -> String {
        out.iter()
            .find(|c| c.row == row && c.col == col)
            .map(|c| c.display.clone())
            .unwrap_or_else(|| panic!("missing cell r{row}c{col}"))
    }

    #[test]
    fn evaluates_arithmetic_and_dependency_chain() {
        let out = calc_cells(vec![
            input(0, 0, "2"),
            input(0, 1, "3"),
            input(0, 2, "=A1+B1"),
            input(1, 0, "=C1*2"),
        ])
        .expect("calc");
        assert_eq!(display_of(&out, 0, 2), "5");
        assert_eq!(display_of(&out, 1, 0), "10");
    }

    #[test]
    fn reports_excel_style_errors() {
        let out = calc_cells(vec![input(0, 0, "=1/0"), input(1, 0, "=NOPE(1)")]).expect("calc");
        assert_eq!(display_of(&out, 0, 0), "#DIV/0!");
        assert_eq!(display_of(&out, 1, 0), "#NAME?");
    }

    #[test]
    fn handles_text_and_ranges() {
        let out = calc_cells(vec![
            input(0, 0, "1"),
            input(1, 0, "2"),
            input(2, 0, "3"),
            input(0, 1, "=SUM(A1:A3)"),
            input(1, 1, "=CONCATENATE(\"a\",\"b\")"),
        ])
        .expect("calc");
        assert_eq!(display_of(&out, 0, 1), "6");
        assert_eq!(display_of(&out, 1, 1), "ab");
    }

    #[test]
    fn xlsx_round_trip_keeps_formula_text() {
        let mut wb = Workbook::new();
        let ds = wb.date_system;
        {
            let sh = wb.sheet_mut(0).expect("sheet");
            sh.set_cell(CellRef::new(0, 0), make_cell("2", ds));
            sh.set_cell(CellRef::new(0, 1), make_cell("3", ds));
            sh.set_cell(CellRef::new(0, 2), make_cell("=A1+B1", ds));
        }
        let mut calc = Calc::new();
        calc.recalc_all(&mut wb);
        let bytes = gridcraft_xlsx::write_xlsx(&wb).expect("write xlsx");

        let sheets = read_xlsx_sheets(&bytes).expect("read xlsx");
        let first = sheets.first().expect("one sheet");
        let c = first
            .cells
            .iter()
            .find(|c| c.row == 0 && c.col == 2)
            .expect("formula cell");
        assert_eq!(c.text.as_deref(), Some("=A1+B1"));
        assert_eq!(c.display, "5");
    }

    #[test]
    fn rejects_out_of_range_coordinates() {
        let err = calc_cells(vec![input(2_000_000, 0, "1")]).unwrap_err();
        assert!(err.contains("非法单元格坐标"));
    }
}
