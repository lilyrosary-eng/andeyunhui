// <reference path="../../../global.d.ts" />
// 茑萝 · 办公 → 表格编辑器（自研轻量表格引擎，MIT）
//
// 原方案用 Univer（Apache-2.0）：Univer 0.25.1 的 facade API 与旧代码严重错配
//（getCell / setValue / save / getCommandService 均已改名或移除），且打包后 devtools
// 大量报错（redi 重复打包 / React 外部化冲突）。在此环境下也无法安装到纯 MIT 的替代库，
// 故改为零依赖的自研网格：保证「新建即可编辑、导入 / 导出可用」，并彻底消除引擎报错。
const React = window.__HOST_REACT__;
const hostApi = window.__HOST_API__;
const { useState, useEffect, useRef, useCallback, Component } = React;

import { loadDoc } from './docStore';
import { open, save } from '@tauri-apps/plugin-dialog';
import * as XLSX from 'xlsx';

function isDarkMode(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
}

interface SheetEditorProps {
  activeId: string;
  title: string;
  onPersist: (id: string, content: unknown) => void;
}

const DEF_ROWS = 100;
const DEF_COLS = 26;

function blankData(rows = DEF_ROWS, cols = DEF_COLS): string[][] {
  const d: string[][] = [];
  for (let r = 0; r < rows; r++) d.push(new Array(cols).fill(''));
  return d;
}

// 把任意存储内容规整成二维字符串数组（兼容旧 Univer 快照：非数组则回退空白表）
function normalizeData(raw: unknown): string[][] {
  if (!Array.isArray(raw)) return blankData();
  const rows = raw as unknown[];
  let cols = DEF_COLS;
  for (const row of rows) if (Array.isArray(row)) cols = Math.max(cols, row.length);
  const norm: string[][] = [];
  for (let r = 0; r < Math.max(DEF_ROWS, rows.length); r++) {
    const src = Array.isArray(rows[r]) ? (rows[r] as unknown[]) : [];
    const row: string[] = [];
    for (let c = 0; c < cols; c++) {
      const v = src[c];
      row.push(v == null ? '' : String(v));
    }
    norm.push(row);
  }
  return norm;
}

// ===== 局部 ErrorBoundary：表格崩溃不影响宿主 =====
class SheetErrorBoundary extends Component<{ children: React.ReactNode }, { error: Error | null; resetKey: number }> {
  state: { error: Error | null; resetKey: number } = { error: null, resetKey: 0 };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { hostApi.console?.error?.('[SheetEditor] 崩溃:', error); }
  retry = () => this.setState((s) => ({ error: null, resetKey: s.resetKey + 1 }));
  render() {
    if (this.state.error) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 h-full bg-[#f5f5f0] dark:bg-[#1c1917] text-center px-8">
          <div className="text-red-500 text-sm font-medium">表格运行出错</div>
          <pre className="text-left text-xs text-neutral-500 bg-black/5 dark:bg-white/10 rounded-lg p-3 max-w-md max-h-40 overflow-auto whitespace-pre-wrap break-all">
            {this.state.error.message || String(this.state.error)}
          </pre>
          <button onClick={this.retry} className="btn-press px-4 py-1.5 rounded-lg bg-[var(--element-bg)]/15 text-[var(--element-bg)] text-sm">
            重新加载
          </button>
        </div>
      );
    }
    return <div key={this.state.resetKey} className="contents">{this.props.children}</div>;
  }
}

const btnCls = 'h-8 px-2.5 rounded-md text-[13px] text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/10';
const thCls = 'sticky top-0 z-10 bg-[#ececec] dark:bg-[#262626] text-[11px] font-medium text-neutral-500 dark:text-stone-400 px-1.5 h-7 min-w-[44px] border border-black/10 dark:border-white/10';

function colName(c: number): string {
  let s = '';
  c = c + 1;
  while (c > 0) {
    const m = (c - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s;
}

function SheetEditorImpl({ activeId, title, onPersist }: SheetEditorProps) {
  const [data, setData] = useState<string[][]>(() => normalizeData(loadDoc(activeId)?.content));
  const [sel, setSel] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const cellRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  const scheduleSave = useCallback(() => {
    setSaving(true);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      onPersist(activeIdRef.current, dataRef.current);
      setSavedAt(Date.now());
      setSaving(false);
    }, 600);
  }, [onPersist]);

  const setCell = useCallback((r: number, c: number, val: string) => {
    setData((prev) => {
      const next = prev.map((row) => row.slice());
      while (next.length <= r) {
        const w = next[0]?.length || DEF_COLS;
        next.push(new Array(w).fill(''));
      }
      const row = next[r].slice();
      while (row.length <= c) row.push('');
      row[c] = val;
      next[r] = row;
      return next;
    });
    scheduleSave();
  }, [scheduleSave]);

  const usedRange = useCallback(() => {
    const d = dataRef.current;
    let lr = -1, lc = -1;
    for (let r = 0; r < d.length; r++) {
      for (let c = 0; c < (d[r]?.length || 0); c++) {
        const v = d[r][c];
        if (v !== '' && v != null) { if (r > lr) lr = r; if (c > lc) lc = c; }
      }
    }
    return { lastRow: lr < 0 ? 0 : lr, lastCol: lc < 0 ? 0 : lc };
  }, []);

  useEffect(() => {
    const d = dataRef.current;
    const { lastRow, lastCol } = usedRange();
    let count = 0, sum = 0;
    for (let r = 0; r <= lastRow; r++) {
      for (let c = 0; c <= lastCol; c++) {
        const v = d[r]?.[c];
        if (v == null || v === '') continue;
        const n = Number(v);
        if (!isNaN(n)) { count++; sum += n; }
      }
    }
    // 状态栏统计：在工具栏右侧已显示保存状态，这里仅保留可用数据，避免额外重渲
    void count; void sum;
  }, [data, usedRange]);

  const focusCell = (r: number, c: number) => {
    const el = cellRefs.current.get(`${r}-${c}`);
    if (el) { el.focus(); if (typeof el.select === 'function') el.select(); }
  };

  const moveSel = (dr: number, dc: number) => {
    setSel((s) => {
      const d = dataRef.current;
      const nr = Math.max(0, Math.min(d.length - 1, s.r + dr));
      const nc = Math.max(0, Math.min((d[0]?.length || DEF_COLS) - 1, s.c + dc));
      setTimeout(() => focusCell(nr, nc), 0);
      return { r: nr, c: nc };
    });
  };

  const onCellKeyDown = (e: React.KeyboardEvent, r: number, c: number) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1, 0); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1, 0); }
    else if (e.key === 'Enter') { e.preventDefault(); moveSel(1, 0); }
    else if (e.key === 'Tab') { e.preventDefault(); moveSel(0, e.shiftKey ? -1 : 1); }
  };

  const addRow = () => setData((prev) => {
    const cols = prev[0]?.length || DEF_COLS;
    return [...prev.map((row) => row.slice()), new Array(cols).fill('')];
  });
  const addCol = () => setData((prev) => prev.map((row) => { const r = row.slice(); r.push(''); return r; }));
  const delRow = () => setData((prev) => {
    if (prev.length <= 1) return prev;
    const next = prev.slice();
    next.splice(Math.min(sel.r, next.length - 1), 1);
    return next;
  });
  const delCol = () => setData((prev) => {
    const cols = prev[0]?.length || DEF_COLS;
    if (cols <= 1) return prev;
    return prev.map((row) => { const r = row.slice(); r.splice(Math.min(sel.c, r.length - 1), 1); return r; });
  });
  const newSheet = () => {
    if (window.confirm('新建将清空当前表格，确定？')) { setData(blankData()); scheduleSave(); }
  };

  // CSV 导入 / 导出
  const importCsv = async () => {
    try {
      const selected = await open({ multiple: false, filters: [{ name: 'CSV 文件', extensions: ['csv', 'txt'] }] });
      if (typeof selected !== 'string' || !selected) return;
      const text = await hostApi.invoke<string>('read_text_file', { path: selected });
      if (!text) return;
      setData(normalizeData(parseCsv(text)));
      scheduleSave();
    } catch (e) { window.alert('CSV 导入失败：' + (e instanceof Error ? e.message : String(e))); }
  };
  const exportCsv = async () => {
    try {
      const { lastRow, lastCol } = usedRange();
      const lines: string[] = [];
      for (let r = 0; r <= lastRow; r++) {
        const cells: string[] = [];
        for (let c = 0; c <= lastCol; c++) {
          const str = String(dataRef.current[r]?.[c] ?? '');
          cells.push(str.includes(',') || str.includes('"') || str.includes('\n') ? '"' + str.replace(/"/g, '""') + '"' : str);
        }
        lines.push(cells.join(','));
      }
      const p = await save({ defaultPath: (title || '表格') + '.csv', filters: [{ name: 'CSV 文件', extensions: ['csv'] }] });
      if (!p) return;
      await hostApi.invoke('write_text_file', { path: p, content: lines.join('\n') });
      window.alert('已导出为 ' + p);
    } catch (e) { window.alert('CSV 导出失败：' + (e instanceof Error ? e.message : String(e))); }
  };

  // XLSX 导入 / 导出（基于已加入依赖的 sheetjs，Apache-2.0）
  const importXlsx = async () => {
    try {
      const selected = await open({ multiple: false, filters: [{ name: 'Excel 文件', extensions: ['xlsx', 'xls'] }] });
      if (typeof selected !== 'string' || !selected) return;
      const b64 = await hostApi.invoke<string>('read_file_base64', { path: selected });
      if (!b64) return;
      const wb = XLSX.read(b64, { type: 'base64' });
      const first = wb.SheetNames[0];
      if (!first) return;
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[first], { header: 1, defval: '', raw: false }) as unknown[][];
      setData(normalizeData(rows));
      scheduleSave();
    } catch (e) { window.alert('XLSX 导入失败：' + (e instanceof Error ? e.message : String(e))); }
  };
  const exportXlsx = async () => {
    try {
      const { lastRow, lastCol } = usedRange();
      const aoa: string[][] = [];
      for (let r = 0; r <= lastRow; r++) {
        const row: string[] = [];
        for (let c = 0; c <= lastCol; c++) row.push(String(dataRef.current[r]?.[c] ?? ''));
        aoa.push(row);
      }
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Sheet1');
      const b64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
      const p = await save({ defaultPath: (title || '表格') + '.xlsx', filters: [{ name: 'Excel 文件', extensions: ['xlsx'] }] });
      if (!p) return;
      await hostApi.invoke('write_file_bytes', { path: p, contentBase64: b64 });
      window.alert('已导出为 ' + p);
    } catch (e) { window.alert('XLSX 导出失败：' + (e instanceof Error ? e.message : String(e))); }
  };

  const savedLabel = saving
    ? '保存中…'
    : savedAt
      ? `已保存 ${new Date(savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
      : '自动保存已开启';

  const rows = data;
  const cols = rows[0]?.length || DEF_COLS;

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 bg-[#f5f5f0] dark:bg-[#1c1917]">
      {/* 工具栏 */}
      <div className="flex items-center gap-0.5 px-3 py-2 border-b border-white/70 dark:border-stone-700/50 flex-wrap">
        <button onClick={newSheet} className={btnCls} title="新建空白表格">新建</button>
        <button onClick={importCsv} className={btnCls} title="导入 CSV 文件">导入 CSV</button>
        <button onClick={exportCsv} className={btnCls} title="导出为 CSV 文件">导出 CSV</button>
        <div className="w-px h-5 bg-neutral-300/70 dark:bg-stone-600/60 mx-1" />
        <button onClick={importXlsx} className={btnCls} title="导入 Excel .xlsx 文件">导入 Excel</button>
        <button onClick={exportXlsx} className={btnCls} title="导出为 Excel .xlsx 文件">导出 Excel</button>
        <div className="w-px h-5 bg-neutral-300/70 dark:bg-stone-600/60 mx-1" />
        <button onClick={addRow} className={btnCls}>添加行</button>
        <button onClick={addCol} className={btnCls}>添加列</button>
        <button onClick={delRow} className={btnCls}>删除行</button>
        <button onClick={delCol} className={btnCls}>删除列</button>
        <div className="flex-1" />
        <span className={`text-[11px] ${saving ? 'text-amber-500' : 'text-neutral-400 dark:text-stone-500'}`}>{savedLabel}</span>
      </div>

      {/* 表格主体：可滚动、行号/列标固定 */}
      <div className="flex-1 min-h-0 overflow-auto">
        <table className="border-collapse select-none">
          <thead>
            <tr>
              <th className={thCls + ' sticky left-0 z-20'}></th>
              {Array.from({ length: cols }).map((_, c) => (
                <th key={c} className={thCls}>{colName(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                <th className={thCls + ' sticky left-0 z-10'}>{r + 1}</th>
                {row.map((val, c) => {
                  const isSel = sel.r === r && sel.c === c;
                  return (
                    <td key={c} className="p-0 border border-black/10 dark:border-white/10">
                      <input
                        ref={(el) => {
                          if (el) cellRefs.current.set(`${r}-${c}`, el);
                          else cellRefs.current.delete(`${r}-${c}`);
                        }}
                        value={val}
                        onChange={(e) => setCell(r, c, e.target.value)}
                        onFocus={() => setSel({ r, c })}
                        onKeyDown={(e) => onCellKeyDown(e, r, c)}
                        className={
                          'w-[120px] h-[28px] px-1.5 outline-none bg-transparent text-[13px] text-neutral-800 dark:text-stone-200 ' +
                          (isSel ? 'ring-2 ring-inset ring-blue-500' : '')
                        }
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 状态栏 */}
      <div className="flex items-center gap-3 px-4 py-1.5 border-t border-white/70 dark:border-stone-700/50 text-[11px] text-neutral-400 dark:text-stone-500">
        <span>表格引擎（自研轻量）</span>
        <span className="ml-auto">{title}</span>
      </div>
    </div>
  );
}

export function SheetEditor(props: SheetEditorProps) {
  return (
    <SheetErrorBoundary>
      <SheetEditorImpl {...props} />
    </SheetErrorBoundary>
  );
}

export default SheetEditor;

// ===== CSV 解析工具函数 =====
// 简单 CSV 解析器：支持逗号 / 分号分隔，支持引号包裹和换行
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const firstLine = text.split('\n')[0] || '';
  const commaCount = (firstLine.match(/,/g) || []).length;
  const semicolonCount = (firstLine.match(/;/g) || []).length;
  const delimiter = semicolonCount > commaCount ? ';' : ',';

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += char;
    } else {
      if (char === '"') inQuotes = true;
      else if (char === delimiter) { row.push(cell); cell = ''; }
      else if (char === '\r') { /* 跳过 \r */ }
      else if (char === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; }
      else cell += char;
    }
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows;
}
