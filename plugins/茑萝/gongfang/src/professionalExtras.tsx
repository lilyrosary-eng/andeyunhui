/// <reference path="../../../global.d.ts" />
// 攻防模块 · P2 深度专业组件
// 三大专业级组件：
//   DisassemblyView — 逆向反汇编视图（IDA/Ghidra 风格符号表 + 伪反汇编预览）
//   ScriptEditor    — CodeMirror 6 脚本编辑器（语法高亮 + 模板插入 + localStorage 持久化）
//   ExportButton    — 会话报告导出（聚合多源数据 → JSON Blob 下载）
// 设计：复用宿主 React + 动态 import CodeMirror（避免首屏负担），所有数据本地聚合
const React = window.__HOST_REACT__;
const { useState, useEffect, useRef, useCallback, useMemo } = React;

import { CollapsibleSection } from './ui';

// ============ 通用：相对时间 ============
function fmtRel(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  return `${Math.floor(diff / 3_600_000)}h`;
}

// ============ 通用：时间戳格式化（导出文件名用） ============
function fmtStamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// ============ Tauri invoke 封装 ============
const tauriInvoke = <T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const w = window as unknown as {
    __TAURI_INTERNALS__?: { invoke: <U = T>(c: string, a?: Record<string, unknown>) => Promise<U> };
  };
  if (!w.__TAURI_INTERNALS__?.invoke) {
    return Promise.reject(new Error('Tauri 运行时不可用'));
  }
  return w.__TAURI_INTERNALS__.invoke<T>(cmd, args);
};

// =====================================================================
// 组件 1：DisassemblyView — 逆向反汇编视图
// =====================================================================
// 接收 SymbolSummary[]（与 frameworks.tsx 中 SymbolSummary 类型对齐）
// 左侧：按 url 分组的符号列表（可折叠）
// 右侧：选中符号后渲染反汇编表格（地址 | 字节码 | 指令 | 注释）
//
// 说明：当前后端 gongfang_symbols 返回的是已识别符号元信息（地址/类型/元数据），
// 不含真实反汇编字节流。本视图基于符号地址 hash 生成确定性伪字节流 + 通用
// x86-64 prologue/epilogue 指令模板，提供专业级可视化展示。
// 接入真实反汇编后端（如 iced-x86）后，可直接替换 generatePseudoAsm 函数。

interface SymbolSummaryLike {
  url: string;
  name: string;
  address: number;
  kind: string;
  meta: Record<string, string>;
}

// 符号类型 → 颜色 + 中文标签
const SYM_KIND_META: Record<string, { label: string; cls: string }> = {
  function: { label: '函数', cls: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
  sbox: { label: 'S-Box', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  const: { label: '常量', cls: 'bg-violet-500/15 text-violet-600 dark:text-violet-400' },
  field: { label: '字段', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  import: { label: '导入', cls: 'bg-rose-500/15 text-rose-600 dark:text-rose-400' },
};
function symKindMeta(kind: string) {
  return SYM_KIND_META[kind] ?? { label: kind, cls: 'bg-neutral-500/15 text-neutral-500 dark:text-stone-400' };
}

// 基于地址 hash 生成确定性伪字节流（同地址每次结果一致）
function hashSeed(addr: number): number {
  let h = 0x811c9dc5;
  let x = addr;
  while (x !== 0) {
    h ^= x & 0xff;
    h = Math.imul(h, 0x01000193);
    x = Math.floor(x / 256);
  }
  return h >>> 0;
}

interface AsmLine {
  addr: number;
  bytes: number[];
  insn: string;
  comment: string;
}

// 基于符号地址生成 x86-64 风格伪反汇编（prologue + body + epilogue）
function generatePseudoAsm(sym: SymbolSummaryLike): AsmLine[] {
  const base = sym.address;
  const seed = hashSeed(base);
  const bodyLen = 6 + (seed % 12); // 6-17 条指令
  const lines: AsmLine[] = [];
  let off = 0;

  const push = (bytes: number[], insn: string, comment: string) => {
    lines.push({ addr: base + off, bytes, insn, comment });
    off += bytes.length;
  };

  // prologue
  push([0x55], 'push rbp', '保存帧指针');
  push([0x48, 0x89, 0xe5], 'mov rbp, rsp', '建立新栈帧');
  const stackSize = ((seed % 8) + 1) * 16;
  push([0x48, 0x83, 0xec, stackSize], `sub rsp, 0x${stackSize.toString(16)}`, `开辟 ${stackSize}B 栈空间`);

  // body（基于 seed 生成不同指令序列）
  const argRegs = ['rdi', 'rsi', 'rdx', 'rcx', 'r8', 'r9'];
  for (let i = 0; i < bodyLen; i++) {
    const choice = (seed + i * 17) % 6;
    if (choice === 0) {
      const reg = argRegs[(seed + i) % argRegs.length];
      push([0x48, 0x89, 0x7d, 0xf8 - i * 4], `mov [rbp-0x${(i * 4 + 8).toString(16)}], ${reg}`, `保存参数 ${i + 1}`);
    } else if (choice === 1) {
      push([0x48, 0x8b, 0x55, 0xf8 - i * 4], `mov rdx, [rbp-0x${(i * 4 + 8).toString(16)}]`, '加载局部变量');
    } else if (choice === 2) {
      const imm = (seed + i * 31) & 0xff;
      push([0x48, 0xc7, 0x45, 0xf0, imm], `mov qword [rbp-0x${(i * 4 + 16).toString(16)}], 0x${imm.toString(16)}`, '写入立即数');
    } else if (choice === 3) {
      push([0xe8, 0x00, 0x00, 0x00, 0x00], `call <relative>`, '函数调用（相对地址）');
    } else if (choice === 4) {
      push([0x48, 0x39, 0xd0], 'cmp rax, rdx', '比较');
    } else {
      push([0x74, 0x05], `je +5`, '条件跳转');
    }
  }

  // epilogue
  push([0x48, 0x83, 0xc4, stackSize], `add rsp, 0x${stackSize.toString(16)}`, '回收栈空间');
  push([0x5d], 'pop rbp', '恢复帧指针');
  push([0xc3], 'ret', '返回');

  return lines;
}

function fmtHex(n: number, width = 8): string {
  return '0x' + n.toString(16).padStart(width, '0');
}

function fmtBytes(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

export function DisassemblyView({ symbols }: { symbols: SymbolSummaryLike[] }) {
  const [selected, setSelected] = useState<SymbolSummaryLike | null>(null);
  const [collapsedUrls, setCollapsedUrls] = useState<Set<string>>(new Set());

  // 按 url 分组
  const grouped = useMemo(() => {
    const m = new Map<string, SymbolSummaryLike[]>();
    for (const s of symbols) {
      const key = s.url || '(无来源)';
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(s);
    }
    return Array.from(m.entries());
  }, [symbols]);

  // 自动选中第一个符号
  useEffect(() => {
    if (!selected && symbols.length > 0) {
      setSelected(symbols[0]);
    }
  }, [symbols, selected]);

  const asmLines = useMemo(() => (selected ? generatePseudoAsm(selected) : []), [selected]);

  const toggleUrl = useCallback((url: string) => {
    setCollapsedUrls((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }, []);

  return (
    <CollapsibleSection
      title="反汇编视图"
      storageKey="fw_reverse_disasm"
      defaultOpen={false}
      accent="info"
      right={
        <>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">伪反汇编</span>
          <span className="text-[10px] text-neutral-400">{symbols.length} 符号 · {grouped.length} 来源</span>
        </>
      }
    >
      {symbols.length === 0 ? (
        <p className="text-[11px] text-neutral-400 text-center py-4">暂无符号数据。执行符号库查询后，选中符号即可查看反汇编预览。</p>
      ) : (
        <div className="grid grid-cols-[220px_1fr] gap-3 h-[360px]">
          {/* 左侧：符号列表（按 url 分组） */}
          <div className="overflow-y-auto border border-black/5 dark:border-stone-700/50 rounded-lg bg-black/[0.02] dark:bg-black/20">
            {grouped.map(([url, syms]) => {
              const collapsed = collapsedUrls.has(url);
              return (
                <div key={url} className="border-b border-black/[0.03] dark:border-stone-700/30 last:border-b-0">
                  <button
                    onClick={() => toggleUrl(url)}
                    className="w-full flex items-center gap-1 px-2 py-1.5 text-left hover:bg-black/[0.03] dark:hover:bg-white/5"
                  >
                    <span className={`text-[9px] transition-transform ${collapsed ? '' : 'rotate-90'}`}>▶</span>
                    <span className="text-[10px] font-mono text-neutral-500 dark:text-stone-400 truncate flex-1" title={url}>{url}</span>
                    <span className="text-[9px] text-neutral-400 tabular-nums">{syms.length}</span>
                  </button>
                  {!collapsed && (
                    <div className="pb-1">
                      {syms.map((s, i) => {
                        const km = symKindMeta(s.kind);
                        const active = selected?.name === s.name && selected?.address === s.address;
                        return (
                          <button
                            key={i}
                            onClick={() => setSelected(s)}
                            className={`w-full flex items-center gap-1.5 px-2 py-1 pl-5 text-left text-[11px] transition-colors ${
                              active
                                ? 'bg-[var(--element-muted)] text-[var(--element-bg)]'
                                : 'hover:bg-black/[0.03] dark:hover:bg-white/5 text-neutral-600 dark:text-stone-300'
                            }`}
                            title={s.name}
                          >
                            <span className={`px-1 py-0.5 rounded text-[9px] shrink-0 ${km.cls}`}>{km.label}</span>
                            <span className="font-mono truncate flex-1">{s.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* 右侧：反汇编视图 */}
          {selected ? (
            <div className="flex flex-col overflow-hidden border border-black/5 dark:border-stone-700/50 rounded-lg bg-[#1e1e2e] dark:bg-[#0d0d14]">
              {/* 顶部元信息栏 */}
              <div className="flex items-center gap-3 px-3 py-2 border-b border-white/5 bg-black/30">
                <span className="text-xs font-mono text-sky-300">{selected.name}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-neutral-400 font-mono">{fmtHex(selected.address)}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${symKindMeta(selected.kind).cls}`}>{symKindMeta(selected.kind).label}</span>
                <span className="text-[10px] text-neutral-500 font-mono">size={asmLines.reduce((a, l) => a + l.bytes.length, 0)}B</span>
                <span className="text-[10px] text-neutral-500">x86-64 · SystemV AMD64</span>
              </div>

              {/* 反汇编表格 */}
              <div className="flex-1 overflow-auto font-mono text-[11px] leading-relaxed">
                {asmLines.map((line, i) => (
                  <div
                    key={i}
                    className="grid grid-cols-[110px_180px_1fr_140px] gap-2 px-3 py-0.5 hover:bg-white/5 border-b border-white/[0.02]"
                  >
                    <span className="text-neutral-500">{fmtHex(line.addr)}</span>
                    <span className="text-amber-300/80">{fmtBytes(line.bytes)}</span>
                    <span className="text-emerald-300">{line.insn}</span>
                    <span className="text-neutral-500 text-[10px] truncate" title={line.comment}>; {line.comment}</span>
                  </div>
                ))}
              </div>

              {/* 底部提示 */}
              <div className="px-3 py-1.5 border-t border-white/5 bg-black/30">
                <p className="text-[10px] text-neutral-500 leading-relaxed">
                  伪反汇编预览：基于符号地址确定性生成的 x86-64 指令模板（prologue/body/epilogue）。
                  接入 iced-x86 真实反汇编后端后，可替换为真实字节流解码结果。
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center border border-dashed border-black/10 dark:border-stone-700/50 rounded-lg text-xs text-neutral-400">
              从左侧选择一个符号查看反汇编
            </div>
          )}
        </div>
      )}
    </CollapsibleSection>
  );
}

// =====================================================================
// 组件 2：ScriptEditor — CodeMirror 6 脚本编辑器
// =====================================================================
// 动态 import codemirror + 语言包 + 暗色主题
// 支持 Python/JavaScript/JSON 语言切换 + 模板插入 + localStorage 持久化

type ScriptLang = 'python' | 'javascript' | 'json';

interface LoadedEditor {
  view: { destroy: () => void; dispatch: (txn: unknown) => void; state: { doc: { toString: () => string } } };
  setLanguage: (lang: ScriptLang) => void;
}

const LANG_LABEL: Record<ScriptLang, string> = {
  python: 'Python',
  javascript: 'JavaScript',
  json: 'JSON',
};

// 默认模板
const DEFAULT_TEMPLATES: { label: string; code: string }[] = [
  {
    label: 'HTTP 请求模板',
    code: '# HTTP 请求模板\nimport urllib.request\nimport json\n\nurl = "https://example.com/api"\nheaders = {"User-Agent": "Mozilla/5.0"}\nreq = urllib.request.Request(url, headers=headers)\nwith urllib.request.urlopen(req, timeout=10) as resp:\n    data = json.loads(resp.read())\n    print(json.dumps(data, indent=2, ensure_ascii=False))\n',
  },
  {
    label: 'Base64 解码',
    code: '# Base64 解码\nimport base64\n\ndef decode_b64(s: str) -> bytes:\n    """补齐 padding 后解码"""\n    s = s + "=" * (-len(s) % 4)\n    return base64.b64decode(s)\n\nif __name__ == "__main__":\n    enc = "SGVsbG8gV29ybGQ="\n    print(decode_b64(enc).decode("utf-8", errors="replace"))\n',
  },
  {
    label: '字节流分析',
    code: '# 字节流熵分析\nimport math\nfrom collections import Counter\n\ndef shannon_entropy(data: bytes) -> float:\n    if not data:\n        return 0.0\n    counter = Counter(data)\n    total = len(data)\n    return -sum((c / total) * math.log2(c / total) for c in counter.values())\n\nsample = b"\\x48\\x65\\x6c\\x6c\\x6f"\nprint(f"entropy = {shannon_entropy(sample):.3f} bits/byte")\n',
  },
];

export function ScriptEditor({
  storageKey = 'gongfang_script_default',
  templates,
  height = 320,
}: {
  storageKey?: string;
  templates?: { label: string; code: string }[];
  height?: number;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<LoadedEditor | null>(null);
  const [lang, setLang] = useState<ScriptLang>('python');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedTs, setSavedTs] = useState<number | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const allTemplates = templates ?? DEFAULT_TEMPLATES;

  // 初始内容：localStorage > 默认模板
  const initialContent = useMemo(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) return saved;
    } catch {}
    return allTemplates[0]?.code ?? '';
  }, [storageKey, allTemplates]);

  // 初始化 CodeMirror（动态 import）
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);

    (async () => {
      try {
        const mods = await Promise.all([
          import('codemirror'),
          import('@codemirror/lang-python'),
          import('@codemirror/lang-javascript'),
          import('@codemirror/lang-json'),
          import('@codemirror/theme-one-dark'),
          import('@codemirror/view'),
          import('@codemirror/state'),
        ]);
        if (cancelled || !containerRef.current) return;

        const [
          cmMod,
          pyMod,
          jsMod,
          jsonMod,
          themeMod,
          viewMod,
          stateMod,
        ] = mods as unknown as [
          { basicSetup: unknown },
          { python: () => unknown },
          { javascript: (cfg?: unknown) => unknown },
          { json: () => unknown },
          { oneDark: unknown },
          { EditorView: new (cfg: unknown) => { destroy: () => void; dispatch: (t: unknown) => void; state: { doc: { toString: () => string } } } },
          { EditorState: { create: (cfg: unknown) => unknown } },
        ];

        const langExtFor = (l: ScriptLang) =>
          l === 'python'
            ? pyMod.python()
            : l === 'javascript'
            ? jsMod.javascript()
            : jsonMod.json();

        const state = stateMod.EditorState.create({
          doc: initialContent,
          extensions: [
            cmMod.basicSetup,
            langExtFor(lang),
            themeMod.oneDark,
            viewMod.EditorView.theme({
              '&': { height: `${height}px`, fontSize: '12px' },
              '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
            }),
          ],
        });

        const view = new viewMod.EditorView({ state, parent: containerRef.current });

        editorRef.current = {
          view,
          setLanguage: (next: ScriptLang) => {
            // 重建 EditorView 切换语言（最简单可靠的方式）
            const doc = view.state.doc.toString();
            view.destroy();
            const newState = stateMod.EditorState.create({
              doc,
              extensions: [
                cmMod.basicSetup,
                langExtFor(next),
                themeMod.oneDark,
                viewMod.EditorView.theme({
                  '&': { height: `${height}px`, fontSize: '12px' },
                  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
                }),
              ],
            });
            const newView = new viewMod.EditorView({ state: newState, parent: containerRef.current! });
            editorRef.current!.view = newView;
          },
        };

        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setLoadError((e as Error)?.message ?? String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (editorRef.current) {
        editorRef.current.view.destroy();
        editorRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换语言：重建 EditorView
  const switchLang = useCallback((next: ScriptLang) => {
    setLang(next);
    if (!editorRef.current || !containerRef.current) return;
    editorRef.current.setLanguage(next);
  }, []);

  // 保存到 localStorage（debounce 500ms）
  const save = useCallback(() => {
    if (!editorRef.current) return;
    const content = editorRef.current.view.state.doc.toString();
    try {
      localStorage.setItem(storageKey, content);
      setSavedTs(Date.now());
    } catch (e) {
      setLoadError(`保存失败：${(e as Error)?.message ?? String(e)}`);
    }
  }, [storageKey]);

  // 自动保存（debounce 500ms）
  useEffect(() => {
    if (!editorRef.current) return;
    const id = setInterval(() => {
      // 仅在内容变化时保存（简单策略：每 2s 检查一次）
      save();
    }, 2000);
    return () => clearInterval(id);
  }, [save]);

  // 插入模板（替换全部内容）
  const insertTemplate = useCallback((code: string) => {
    if (!editorRef.current) return;
    const view = editorRef.current.view;
    const doc = view.state.doc.toString();
    view.dispatch({
      changes: { from: 0, to: doc.length, insert: code },
    });
    setShowTemplates(false);
  }, []);

  return (
    <CollapsibleSection
      title="脚本编辑器"
      storageKey="fw_automation_script_editor"
      defaultOpen={false}
      accent="info"
      right={
        <>
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-sky-500/15 text-sky-600 dark:text-sky-400">CodeMirror 6</span>
          <div className="flex items-center gap-1.5">
            {/* 语言切换 */}
            <div className="flex items-center rounded-lg border border-black/10 dark:border-stone-700/50 overflow-hidden">
              {(Object.keys(LANG_LABEL) as ScriptLang[]).map((l) => (
                <button
                  key={l}
                  onClick={() => switchLang(l)}
                  className={`px-2 py-1 text-[11px] transition-colors ${
                    lang === l
                      ? 'bg-[var(--element-bg)] text-white'
                      : 'text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/5'
                  }`}
                >
                  {LANG_LABEL[l]}
                </button>
              ))}
            </div>

            {/* 模板下拉 */}
            <div className="relative">
              <button
                onClick={() => setShowTemplates((v) => !v)}
                className="btn-press px-2 py-1 rounded-lg text-[11px] text-neutral-500 dark:text-stone-400 border border-black/10 dark:border-stone-700/50 hover:bg-black/5 dark:hover:bg-white/5"
              >
                模板 ▾
              </button>
              {showTemplates && (
                <div className="absolute right-0 top-full mt-1 z-10 min-w-[180px] rounded-lg border border-black/10 dark:border-stone-700/50 bg-white dark:bg-stone-800 shadow-lg py-1">
                  {allTemplates.map((t) => (
                    <button
                      key={t.label}
                      onClick={() => insertTemplate(t.code)}
                      className="block w-full text-left px-3 py-1.5 text-[11px] text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5"
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* 保存按钮 */}
            <button
              onClick={save}
              className="btn-press px-2.5 py-1 rounded-lg text-[11px] font-medium text-white bg-[var(--element-bg)] hover:opacity-90"
            >
              保存
            </button>
          </div>
        </>
      }
    >
      {/* 编辑器容器 */}
      <div className="relative rounded-lg overflow-hidden border border-black/10 dark:border-stone-700/50">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#1e1e2e] text-neutral-400 text-xs z-10">
            加载 CodeMirror 6...
          </div>
        )}
        {loadError && (
          <div className="absolute inset-0 flex items-center justify-center bg-rose-500/10 text-rose-600 dark:text-rose-400 text-xs z-10 p-4 text-center">
            加载失败：{loadError}
          </div>
        )}
        <div ref={containerRef} className="cm-host" />
      </div>

      {/* 底部状态栏 */}
      <div className="flex items-center justify-between text-[10px] text-neutral-400">
        <span>localStorage 键：<code className="font-mono text-neutral-500 dark:text-stone-400">{storageKey}</code></span>
        {savedTs && <span>最后保存：{fmtRel(savedTs)} 前</span>}
      </div>
    </CollapsibleSection>
  );
}

// =====================================================================
// 组件 3：ExportButton — 会话报告导出
// =====================================================================
// 聚合多源数据 → JSON Blob 下载
// 默认拉取：事件流 / 时序指标 / AI 推理日志 / 目标工作区
// 可通过 getData prop 注入额外数据（如各框架本地状态）

interface ExportResult {
  success: boolean;
  filename?: string;
  sizeBytes?: number;
  error?: string;
}

export function ExportButton({
  getData,
  filenamePrefix = 'gongfang_report',
  label = '导出会话报告',
  extraData,
}: {
  getData?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  filenamePrefix?: string;
  label?: string;
  extraData?: Record<string, unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExportResult | null>(null);

  const handleExport = useCallback(async () => {
    setBusy(true);
    setResult(null);
    try {
      // 并行拉取后端数据 + 用户自定义数据
      const [events, metrics, aiReasoning, targets, custom] = await Promise.all([
        tauriInvoke<unknown[]>('gongfang_events_recent', { n: 500 }).catch(() => []),
        tauriInvoke<unknown[]>('gongfang_metrics_history', { n: 600 }).catch(() => []),
        tauriInvoke<unknown[]>('gongfang_ai_reasoning_recent', { n: 50 }).catch(() => []),
        tauriInvoke<unknown[]>('gongfang_target_list').catch(() => []),
        Promise.resolve(getData ? getData() : {}).catch(() => ({})),
      ]);

      const report = {
        __meta: {
          exported_at: new Date().toISOString(),
          app: 'niaoluo-gongfang',
          version: '1.0',
        },
        events,
        metrics,
        ai_reasoning: aiReasoning,
        targets,
        custom,
        extra: extraData ?? null,
      };

      const json = JSON.stringify(report, null, 2);
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const filename = `${filenamePrefix}_${fmtStamp()}.json`;

      // 触发下载
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setResult({
        success: true,
        filename,
        sizeBytes: blob.size,
      });
    } catch (e) {
      setResult({
        success: false,
        error: (e as Error)?.message ?? String(e),
      });
    } finally {
      setBusy(false);
    }
  }, [getData, filenamePrefix, extraData]);

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleExport}
        disabled={busy}
        className="btn-press flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border border-black/10 dark:border-stone-700/50 text-neutral-600 dark:text-stone-300 hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
        title="导出事件流/时序指标/AI 推理/目标工作区为 JSON"
      >
        {busy ? (
          <>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" className="origin-center animate-spin" />
            </svg>
            导出中...
          </>
        ) : (
          <>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
            </svg>
            {label}
          </>
        )}
      </button>

      {result && (
        <span className={`text-[10px] ${result.success ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
          {result.success
            ? `已导出 ${result.filename} (${result.sizeBytes != null ? `${(result.sizeBytes / 1024).toFixed(1)} KB` : '?'})`
            : `失败：${result.error}`}
        </span>
      )}
    </div>
  );
}
