import { useSyncExternalStore, useCallback, useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { FileText, File, Trash2, Inbox, ExternalLink, Download, Save, ScanText, Languages, Loader2, X, FileDown } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save, open } from '@tauri-apps/plugin-dialog';
import { join } from '@tauri-apps/api/path';
import { api, type ImportedFile } from '@/lib/api';
import {
  SOURCE_LANGS,
  TARGET_LANGS,
  loadSourceLang,
  loadTargetLang,
  saveSourceLang,
  saveTargetLang,
} from '@/lib/translateLanguages';

// 本地 PaddleOCR 引擎懒加载（与 CodeMirror/TipTap 同模式：read_external_dep_file + new Function，
// 在真实 window 全局作用域执行，挂载到 window.__EXT_PADDLEOCR__）。
let _paddleOcrLoading: Promise<any> | null = null;
async function loadPaddleOcr(): Promise<any> {
  const w = window as any;
  // 版本标记 _v 防御 Vite HMR 残留的旧 IIFE（每次引擎实现变更都要递增 _v 才能强制重载）
  if (w.__EXT_PADDLEOCR__?._v === 7) return w.__EXT_PADDLEOCR__;
  // 清除可能的旧版缓存
  delete w.__EXT_PADDLEOCR__;
  _paddleOcrLoading = null;

  _paddleOcrLoading = (async () => {
    const code = await invoke<string>('read_external_dep_file', { relativePath: '全局/paddleocr/index.js' });
    if (!code) throw new Error('本地 OCR 引擎未找到（external-deps/全局/paddleocr/index.js 不存在）');
    new Function(code)();
    if (!w.__EXT_PADDLEOCR__) throw new Error('OCR 引擎已读取但挂载失败（window.__EXT_PADDLEOCR__ 未定义）');
    return w.__EXT_PADDLEOCR__;
  })();
  return _paddleOcrLoading;
}

// 刷新订阅：App.tsx 在窗口拖入文件后调用 emitDropzoneChange() 触发本面板重新拉取后端列表
// （解析抽取的图片不会写 localStorage，必须回到文件系统真实扫描，因此面板直接读后端）。
const listeners = new Set<() => void>();
let refreshTick = 0;
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
function getTick(): number {
  return refreshTick;
}
export function emitDropzoneChange() {
  refreshTick += 1;
  listeners.forEach((l) => l());
}

interface TransferStationPanelProps {
  /** 文本类文件读取后传到外部（如「安得云荟」页面打开编辑） */
  onOpenReadableFile?: (file: ImportedFile, content: string) => void;
  /** 'main'：主站，点击 OCR / 翻译 实体按钮在左 / 右侧展开独立自包含工作区（支持拖入 / 选择 / 粘贴图片，不依赖中转站已存文件）；'floating'：浮窗，沿用内联结果（不受影响） */
  variant?: 'main' | 'floating';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FileIcon({ extension }: { extension: string }) {
  const textExts = ['md', 'txt', 'json', 'csv', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'log', 'html', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'sh', 'bat', 'env', 'sql', 'vue', 'svelte', 'astro'];
  if (textExts.includes(extension)) {
    return <FileText size={16} />;
  }
  return <File size={16} />;
}

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'heic', 'heif'];
function isImageFile(ext: string): boolean {
  return IMAGE_EXTS.includes((ext || '').toLowerCase());
}

export function TransferStationPanel({ onOpenReadableFile, variant = 'main' }: TransferStationPanelProps) {
  const tick = useSyncExternalStore(subscribe, getTick, getTick);
  const [files, setFiles] = useState<ImportedFile[]>([]);
  const [loading, setLoading] = useState(false);
  // 悬停时预取图片字节仅用于显示缩略图；原生拖出由 Rust 端 DoDragDrop 完成，无需前端字节缓存
  const [imgUrls, setImgUrls] = useState<Record<string, string>>({});
  // 选中态：点选文件行选中（中转站与浮窗共用）
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // 复选模式（参照音乐模块 TrackList）：开启后每行显示复选框，可批量保存 / 删除
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // OCR / 翻译 结果 / 错误 / loading 状态按 storedPath 维度存储
  // 该状态仅用于「中转站浮窗」内联结果；主站改用下方自包含工作区（OcrWorkspace / TranslateWorkspace）
  const [aiResults, setAiResults] = useState<Record<string, { kind: 'ocr' | 'translate'; text: string } | { kind: 'error'; text: string } | { kind: 'loading'; kindLabel: string }>>({});
  // 主站 OCR / 翻译 工作区开关（绝对定位贴左右边缘，不撑宽中间）
  const [ocrOpen, setOcrOpen] = useState(false);
  const [translateOpen, setTranslateOpen] = useState(false);
  // 主站 OCR 工作区预填充图片（来自文件行点击 / 选中图片，可为 null = 空，等待拖入 / 粘贴）
  const [ocrPrefill, setOcrPrefill] = useState<string | null>(null);
  const selectedFile = files.find((f) => f.storedPath === selectedPath) ?? null;
  // 中转站「保存中」占位：录屏等巨大文件保存时，Rust 先广播 dropzone-saving 占位，
  // 后台拷贝完成再广播 dropzone-saving-done 移除占位（绝不静默）。仅前端临时态，不落盘。
  const [savingItems, setSavingItems] = useState<{ tempId: string; name: string; label: string }[]>([]);
  useEffect(() => {
    const unSaving = listen<{ tempId: string; name: string; label: string }>(
      'dropzone-saving',
      (e) => {
        const p = e.payload;
        setSavingItems((prev) =>
          prev.some((x) => x.tempId === p.tempId) ? prev : [...prev, p],
        );
      },
    );
    const unDone = listen<{ tempId: string }>('dropzone-saving-done', (e) => {
      const t = e.payload.tempId;
      setSavingItems((prev) => prev.filter((x) => x.tempId !== t));
    });
    return () => {
      void unSaving.then((fn) => fn());
      void unDone.then((fn) => fn());
    };
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listDropzoneFiles()
      .then(setFiles)
      .catch((err) => console.error('[Dropzone] 列表加载失败:', err))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [tick, load]);

  // 选中项自适应：保持已有选中（若仍存在）；否则自动选中最新一张图片，保证 OCR / 翻译 按钮随时可用
  useEffect(() => {
    setSelectedPath((prev) => {
      if (prev && files.some((f) => f.storedPath === prev)) return prev;
      const latestImg = [...files].reverse().find((f) => isImageFile(f.extension));
      return latestImg ? latestImg.storedPath : null;
    });
  }, [files]);

  // 悬停预取图片字节仅用于渲染缩略图（data URL 直接作 <img> src）
  const prefetch = useCallback((file: ImportedFile) => {
    if (imgUrls[file.storedPath] || !isImageFile(file.extension)) return;
    api
      .readDropzoneBase64(file.storedPath)
      .then((d) => setImgUrls((m) => ({ ...m, [file.storedPath]: d })))
      .catch((err) => console.error('[Dropzone] 缩略图预取失败:', file.storedPath, err));
  }, [imgUrls]);

  // 原生拖出：在文件行上按下鼠标即发起系统级拖拽（由 Rust 端 DoDragDrop 写出真实文件到桌面/文件夹）。
  // 完全绕过 WebView2 对 JS dataTransfer 拖出的限制，是根治「文件拖不出」的方案。
  const startNativeDrag = useCallback((e: React.MouseEvent, file: ImportedFile) => {
    if (e.button !== 0) return; // 仅左键
    if (selectionMode) return; // 多选模式下禁用拖拽，点击改为切换选中
    if (!file.absolutePath) return;
    const target = e.target as HTMLElement;
    if (target.closest('button')) return; // 让删除/保存等按钮正常工作
    e.preventDefault();
    // 标记本次为「应用内拖出」，拖回应用内时不重复导入
    (window as unknown as Record<string, unknown>).__andengDragging = true;
    invoke('start_native_file_drag', { files: [file.absolutePath] })
      .catch((err) => console.error('[Dropzone] 原生拖出失败:', err))
      .finally(() => {
        (window as unknown as Record<string, unknown>).__andengDragging = false;
      });
  }, [selectionMode]);

  // 兜底：用系统「另存为」对话框把文件导出到任意位置（拖出在所有环境下不一定可用）
  const handleSave = useCallback(async (file: ImportedFile) => {
    try {
      const dest = await save({ defaultPath: file.originalName });
      if (!dest) return;
      await api.exportDropzoneFile(file.storedPath, dest);
    } catch (err) {
      console.error('[Dropzone] 导出失败:', err);
    }
  }, []);

  // OCR / 翻译：AI 优先，失败时给出与 AI 编程一致的降级提示
  // 结果 / 错误 / loading 状态按 storedPath 维度存储，展开时显示（aiResults 已在上方声明）
  // —— 以下 runOcr / runTranslate 仅用于「中转站浮窗」内联结果（不影响主站工作区）
  const runOcr = useCallback(async (file: ImportedFile) => {
    if (!isImageFile(file.extension)) return;
    setAiResults(prev => ({ ...prev, [file.storedPath]: { kind: 'loading', kindLabel: 'OCR' } }));
    try {
      // 复用现有 imgUrls（data URL: data:image/png;base64,xxx）
      let dataUrl = imgUrls[file.storedPath];
      if (!dataUrl) {
        dataUrl = await api.readDropzoneBase64(file.storedPath);
        setImgUrls(m => ({ ...m, [file.storedPath]: dataUrl }));
      }
      // 拆分 mime 与 base64 部分
      const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
      if (!m) throw new Error('图片数据格式错误');
      const mime = m[1];
      const b64 = m[2];
      const text = await api.aiVisionOcr(b64, mime);
      setAiResults(prev => ({ ...prev, [file.storedPath]: { kind: 'ocr', text } }));
    } catch (err) {
      console.error('[OCR] 云端识别失败:', err);
      const msg = String(err);
      // 未配置 API Key 时降级到本地 PaddleOCR 引擎
      if (msg.includes('未配置') || msg.includes('API Key')) {
        try {
          const local = await loadPaddleOcr();
          const du = imgUrls[file.storedPath] || await api.readDropzoneBase64(file.storedPath);
          const t = await local.recognize(du);
          if (t && t.trim()) {
            setAiResults(prev => ({ ...prev, [file.storedPath]: { kind: 'ocr', text: t } }));
            return;
          }
        } catch (e2) {
          console.warn('[OCR] 本地识别失败:', e2);
        }
      }
      const hint = /不支持|support|image|vision|400|模型/i.test(msg)
        ? ' — 可在「全局设置 → 模型」确认已为 OCR 单独指定「视觉模型」（对话模型往往不支持图片）'
        : '';
      setAiResults(prev => ({ ...prev, [file.storedPath]: { kind: 'error', text: '⚠ OCR 失败：' + msg.slice(0, 300) + hint } }));
    }
  }, [imgUrls]);

  const runTranslate = useCallback(async (file: ImportedFile) => {
    if (!isImageFile(file.extension)) return;
    setAiResults(prev => ({ ...prev, [file.storedPath]: { kind: 'loading', kindLabel: '翻译' } }));
    try {
      // 先做 OCR，再翻译
      let dataUrl = imgUrls[file.storedPath];
      if (!dataUrl) {
        dataUrl = await api.readDropzoneBase64(file.storedPath);
        setImgUrls(m => ({ ...m, [file.storedPath]: dataUrl }));
      }
      const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
      if (!m) throw new Error('图片数据格式错误');
      const ocrText = await api.aiVisionOcr(m[2], m[1]);
      if (!ocrText.trim()) {
        setAiResults(prev => ({ ...prev, [file.storedPath]: { kind: 'error', text: '⚠ 未识别到文字（图片可能不含文字或模型识别失败）' } }));
        return;
      }
      const translated = await api.translateText(ocrText, '中文');
      setAiResults(prev => ({ ...prev, [file.storedPath]: { kind: 'translate', text: translated } }));
    } catch (err) {
      setAiResults(prev => ({ ...prev, [file.storedPath]: { kind: 'error', text: '⚠ 翻译失败：' + String(err).slice(0, 200) } }));
    }
  }, [imgUrls]);

  // 浮窗内联结果清除；主站工作区清除
  const clearAiResult = useCallback((storedPath: string) => {
    setAiResults(prev => {
      const next = { ...prev };
      delete next[storedPath];
      return next;
    });
  }, []);

  // 主站 OCR / 翻译 工作区：点击实体按钮在左 / 右侧展开自包含工作区（支持拖入 / 选择 / 粘贴图片，不依赖中转站已存文件）
  // 与浮窗的 OcrBox / TranslateBox 行为一致；结果存于工作区自身局部状态，与浮窗 aiResults 完全隔离
  const openOcr = useCallback((file?: ImportedFile) => {
    if (ocrOpen) {
      setOcrOpen(false);
      return;
    }
    setOcrOpen(true);
    if (file && isImageFile(file.extension)) {
      const p = file.storedPath;
      const existing = imgUrls[p];
      if (existing) {
        setOcrPrefill(existing);
      } else {
        api.readDropzoneBase64(p).then((d) => setOcrPrefill(d)).catch(() => {});
      }
    } else {
      setOcrPrefill(null);
    }
  }, [ocrOpen, imgUrls]);

  const openTranslate = useCallback(() => {
    setTranslateOpen((v) => !v);
  }, []);

  // 按 variant 选择 OCR / 翻译 处理函数：主站走自包含工作区，浮窗走内联
  const onOcr = variant === 'main' ? openOcr : runOcr;
  const onTranslate = variant === 'main' ? openTranslate : runTranslate;

  const handleDelete = useCallback(
    async (file: ImportedFile) => {
    try {
      await invoke('delete_dropzone_file', { storedPath: file.storedPath });
      load();
      } catch (err) {
        console.error('[Dropzone] 删除失败:', err);
      }
    },
    [load],
  );

  // 复选模式切换：退出时清空已选
  const toggleSelectMode = useCallback(() => {
    setSelectionMode((prev) => {
      if (prev) setSelectedIds(new Set());
      return !prev;
    });
  }, []);
  // 切换单个文件选中态
  const toggleSelect = useCallback((path: string) => {
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  }, []);
  const allSelected = files.length > 0 && selectedIds.size === files.length;
  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) =>
      prev.size === files.length ? new Set<string>() : new Set(files.map((f) => f.storedPath)),
    );
  }, [files]);
  // 批量保存：弹一次目录选择，把所有选中文件导出到该目录（解决逐个另存为的繁琐）
  const batchSave = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const dir = await open({ directory: true, title: '选择保存目录（批量）' }).catch(() => null);
    if (!dir || typeof dir !== 'string') return;
    for (const f of files) {
      if (!selectedIds.has(f.storedPath)) continue;
      const dest = await join(dir, f.originalName);
      await api.exportDropzoneFile(f.storedPath, dest).catch(() => {});
    }
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, [files, selectedIds]);
  // 批量删除：删除所有选中文件（「存档」快照不受影响）
  const batchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    for (const f of files) {
      if (!selectedIds.has(f.storedPath)) continue;
      await invoke('delete_dropzone_file', { storedPath: f.storedPath }).catch(() => {});
    }
    await load();
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, [files, selectedIds, load]);

  const handleClearAll = useCallback(async () => {
    if (!confirm('确定清空中转站所有暂存文件？此操作不可恢复（不影响「存档」快照）。')) return;
    try {
      await invoke('clear_dropzone');
      setImgUrls({});
      load();
    } catch (err) {
      console.error('[Dropzone] 清空失败:', err);
    }
  }, [load]);

  const handleOpenFile = useCallback(
    async (file: ImportedFile) => {
      if (!file.isReadable) return;
      try {
        const content: string = await invoke('read_dropzone_file', { storedPath: file.storedPath });
        onOpenReadableFile?.(file, content);
      } catch (err) {
        console.error('[Dropzone] 读取失败:', err);
      }
    },
    [onOpenReadableFile],
  );

  return (
    <div className="relative flex-1 h-full overflow-hidden main-panel-bg p-6 fade-in flex flex-col">
      {/* 主站左侧：OCR 工作区（自包含，支持拖入 / 选择 / 粘贴图片） */}
      {variant === 'main' && ocrOpen && (
        <div className="absolute left-6 top-6 bottom-6 w-80 z-10">
          <OcrWorkspace prefillDataUrl={ocrPrefill} onClose={() => setOcrOpen(false)} />
        </div>
      )}

      {/* 中间：文件列表（主站与浮窗共用，保持原来居中空阔的版式） */}
      <div className="max-w-lg mx-auto w-full h-full flex flex-col">
        {/* 标题栏 */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <span className="text-[var(--element-bg)]">
              <Inbox size={22} />
            </span>
            <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">中转站</h2>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleSelectMode}
              className={`btn-press px-3 py-1.5 rounded-lg text-xs transition-colors ${selectionMode ? 'text-[var(--element-bg)] bg-[var(--element-muted)]' : 'text-neutral-400 dark:text-stone-500 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)]'}`}
              title={selectionMode ? '退出多选' : '多选后可批量保存 / 删除'}
            >
              {selectionMode ? '退出多选' : '多选'}
            </button>
            {files.length > 0 && (
              <button
                onClick={handleClearAll}
                className="btn-press px-3 py-1.5 rounded-lg text-xs text-red-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
              >
                清空全部
              </button>
            )}
          </div>
        </div>

        {/* 多选模式工具条：全选 / 批量保存 / 批量删除 */}
        {selectionMode && (
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <button
              onClick={toggleSelectAll}
              className="btn-press px-2.5 py-1.5 rounded-lg text-xs border border-[var(--element-border)] text-neutral-600 dark:text-stone-300 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)] transition-colors"
            >
              {allSelected ? '取消全选' : '全选'}
            </button>
            <button
              onClick={batchSave}
              disabled={selectedIds.size === 0}
              className="btn-press px-2.5 py-1.5 rounded-lg text-xs text-[var(--element-bg)] bg-[var(--element-muted)] hover:opacity-90 disabled:opacity-40 transition-colors"
            >
              批量保存{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
            </button>
            <button
              onClick={batchDelete}
              disabled={selectedIds.size === 0}
              className="btn-press px-2.5 py-1.5 rounded-lg text-xs text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-40 transition-colors"
            >
              批量删除
            </button>
            <span className="text-xs text-neutral-400 dark:text-stone-500">已选 {selectedIds.size} / {files.length}</span>
          </div>
        )}

        {/* 使用提示 */}
        <div className="glass-panel p-3 mb-5">
          <p className="text-xs text-neutral-400 dark:text-stone-500">
            拖放任意文件到应用窗口、或导入文档/图片（docx/pptx/xlsx/pdf、png/jpg…）都会自动存入此处；图片会同时进入笔记预览与图标栏中转站。
            文本类文件在「安得云荟」页面拖入时可直接打开编辑；把文件拖到桌面或文件夹即可导出原始文件，也可用「保存到…」另存。
          </p>
        </div>

        {/* OCR / 翻译 实体按钮：主站点击在左 / 右侧展开对应自包含工作区（浮窗走自身拓展框，此处隐藏） */}
        {variant === 'main' && !(loading && files.length === 0) && (
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <span className="text-xs text-neutral-400 dark:text-stone-500 truncate max-w-[40%]" title={selectedFile?.originalName}>
              {selectedFile ? `已选：${selectedFile.originalName}` : '点选图片以启用 OCR / 翻译'}
            </span>
            <button
              type="button"
              onClick={() => openOcr(selectedFile ?? undefined)}
              className={`btn-press px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 border transition-colors ${ocrOpen ? 'border-[var(--element-bg)] bg-[var(--element-muted)] text-[var(--element-bg)]' : 'border-[var(--element-border)] text-neutral-600 dark:text-stone-300 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)]'}`}
              title="在左侧展开 OCR 工作区（拖入 / 选择 / 粘贴图片即可识别）"
            >
              <ScanText size={14} /> OCR
            </button>
            <button
              type="button"
              onClick={() => openTranslate()}
              className={`btn-press px-3 py-1.5 rounded-lg text-xs flex items-center gap-1.5 border transition-colors ${translateOpen ? 'border-[var(--element-bg)] bg-[var(--element-muted)] text-[var(--element-bg)]' : 'border-[var(--element-border)] text-neutral-600 dark:text-stone-300 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)]'}`}
              title="在右侧展开翻译工作区（粘贴 / 输入文字即可翻译）"
            >
              <Languages size={14} /> 翻译
            </button>
          </div>
        )}

        {/* 文件列表 */}
        {loading && files.length === 0 && savingItems.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-16 gap-3 text-neutral-400 dark:text-stone-500">
            <p className="text-sm">加载中…</p>
          </div>
        ) : files.length === 0 && savingItems.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center py-16 gap-3 text-neutral-400 dark:text-stone-500">
            <Inbox size={40} className="opacity-30" />
            <p className="text-sm">暂无文件</p>
            <p className="text-xs text-neutral-400/60 dark:text-stone-600">拖入文件后会自动出现在这里</p>
          </div>
        ) : (
          <div className="space-y-2 overflow-y-auto flex-1 min-h-0 pr-1">
            {/* 中转站「保存中」占位行：巨大文件后台拷贝时即时占位，绝不静默 */}
            {savingItems.map((s) => (
              <div
                key={s.tempId}
                className="glass-panel p-3 flex items-center gap-3 opacity-80"
                title="文件正在后台存入中转站"
              >
                <div className="w-9 h-9 rounded-lg bg-[var(--element-muted)] flex items-center justify-center text-[var(--element-bg)] flex-shrink-0 animate-pulse">
                  <File size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-neutral-700 dark:text-stone-200 truncate">
                    {s.name}
                  </div>
                  <div className="text-xs text-neutral-400 dark:text-stone-500">{s.label}…</div>
                </div>
                <div className="text-xs text-[var(--element-bg)] animate-pulse flex-shrink-0">保存中</div>
              </div>
            ))}
            {files.map((file) => {
              const imgSrc = isImageFile(file.extension) ? imgUrls[file.storedPath] : undefined;
              // 内联结果仅浮窗显示；主站结果统一在左右工作区展示
              const aiResult = variant === 'floating' ? aiResults[file.storedPath] : undefined;
              const rowContent = (
                <>
                  {selectionMode && (
                    <input
                      type="checkbox"
                      checked={selectedIds.has(file.storedPath)}
                      onChange={() => toggleSelect(file.storedPath)}
                      onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      className="w-4 h-4 rounded border-neutral-300 dark:border-stone-600 bg-white dark:bg-stone-700 text-[var(--element-bg)] focus:ring-[var(--element-bg)] cursor-pointer flex-shrink-0"
                    />
                  )}
                  {/* 图标或图片缩略图 */}
                  {imgSrc ? (
                    <img
                      src={imgSrc}
                      alt={file.originalName}
                      draggable={false}
                      className="w-9 h-9 rounded-lg object-cover flex-shrink-0"
                    />
                  ) : (
                    <div className="w-9 h-9 rounded-lg bg-[var(--element-muted)] flex items-center justify-center text-[var(--element-bg)] flex-shrink-0">
                      <FileIcon extension={file.extension} />
                    </div>
                  )}

                  {/* 文件信息 */}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-neutral-700 dark:text-stone-200 truncate">
                      {file.originalName}
                    </div>
                    <div className="text-xs text-neutral-400 dark:text-stone-500 flex items-center gap-2">
                      <span>{file.importedAt}</span>
                      <span>{formatSize(file.size)}</span>
                      {file.isReadable && <span className="text-[var(--element-bg)]">· 可预览</span>}
                    </div>
                  </div>

                  {/* 操作按钮 */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <span
                      className="btn-press p-1.5 rounded-lg text-neutral-300 dark:text-stone-600"
                      title="拖拽到桌面或文件夹即可导出；也可点「保存到…」"
                    >
                      <Download size={15} />
                    </span>
                    <button
                      onClick={() => handleSave(file)}
                      className="btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)] transition-colors"
                      title="保存到…（另存为）"
                    >
                      <Save size={15} />
                    </button>
                    {isImageFile(file.extension) && (
                      <>
                        <button
                          onClick={() => onOcr(file)}
                          className="btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)] transition-colors"
                          title="AI 视觉 OCR（提取图片文字）"
                        >
                          <ScanText size={15} />
                        </button>
                        <button
                          onClick={() => onTranslate(file)}
                          className="btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)] transition-colors"
                          title="AI 翻译（OCR + 中译）"
                        >
                          <Languages size={15} />
                        </button>
                      </>
                    )}
                    {file.isReadable && onOpenReadableFile && (
                      <button
                        onClick={() => handleOpenFile(file)}
                        className="btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)] transition-colors"
                        title="打开"
                      >
                        <ExternalLink size={15} />
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(file)}
                      className="btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
                      title="删除"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </>
              );
              // 图片行：按下即发起原生系统拖拽（拖出由 Rust 完成），根治 WebView2 限制
              if (imgSrc) {
                return (
                  <div
                    key={file.storedPath}
                    onClick={() => (selectionMode ? toggleSelect(file.storedPath) : setSelectedPath(file.storedPath))}
                    className={`glass-panel p-3 flex flex-col gap-2 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer ${file.storedPath === selectedPath ? 'ring-2 ring-[var(--element-bg)]' : ''}${selectionMode && selectedIds.has(file.storedPath) ? ' outline outline-2 outline-[var(--element-bg)] bg-black/[0.04] dark:bg-white/[0.06]' : ''}`}
                  >
                    <div
                      onMouseEnter={() => prefetch(file)}
                      onMouseDown={(e) => startNativeDrag(e, file)}
                      onClick={() => (selectionMode ? toggleSelect(file.storedPath) : setSelectedPath(file.storedPath))}
                      className="flex items-center gap-3 cursor-grab active:cursor-grabbing"
                      title="拖动此行到桌面或文件夹即可导出真实文件"
                    >
                      {rowContent}
                    </div>
                    {aiResult && (
                      <div className={`rounded-lg border px-3 py-2 text-xs ${
                        aiResult.kind === 'error'
                          ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/40 text-amber-700 dark:text-amber-300'
                          : aiResult.kind === 'loading'
                            ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800/40 text-blue-700 dark:text-blue-300 animate-pulse'
                            : 'bg-white/60 dark:bg-stone-800/60 border-white/80 dark:border-stone-700/50 text-neutral-700 dark:text-stone-200'
                      }`}>
                        <div className="flex items-center justify-between mb-1">
                          <span className="font-medium">
                            {aiResult.kind === 'ocr' && '🔍 OCR 识别结果'}
                            {aiResult.kind === 'translate' && '🌐 翻译结果（中译）'}
                            {aiResult.kind === 'loading' && `⏳ ${aiResult.kindLabel}处理中…`}
                            {aiResult.kind === 'error' && '⚠ 降级提示'}
                          </span>
                          {aiResult.kind !== 'loading' && (
                            <div className="flex gap-1">
                              {(aiResult.kind === 'ocr' || aiResult.kind === 'translate') && (
                                <button
                                  onClick={() => navigator.clipboard?.writeText(aiResult.text)}
                                  className="px-2 py-0.5 rounded text-[10px] bg-white/70 dark:bg-stone-700/70 hover:bg-white"
                                >
                                  复制
                                </button>
                              )}
                              <button
                                onClick={() => clearAiResult(file.storedPath)}
                                className="px-2 py-0.5 rounded text-[10px] bg-white/70 dark:bg-stone-700/70 hover:bg-white"
                              >
                                关闭
                              </button>
                            </div>
                          )}
                        </div>
                        {(aiResult.kind === 'ocr' || aiResult.kind === 'translate' || aiResult.kind === 'error') && (
                          <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed">{aiResult.text}</pre>
                        )}
                      </div>
                    )}
                  </div>
                );
              }
              // 非图片行：同样按下即发起原生系统拖拽（拖出由 Rust 完成）
              return (
                <div
                  key={file.storedPath}
                  onMouseEnter={() => prefetch(file)}
                  onMouseDown={(e) => startNativeDrag(e, file)}
                  onClick={() => (selectionMode ? toggleSelect(file.storedPath) : setSelectedPath(file.storedPath))}
                  className={`glass-panel p-3 flex items-center gap-3 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-grab active:cursor-grabbing ${file.storedPath === selectedPath ? 'ring-2 ring-[var(--element-bg)]' : ''}${selectionMode && selectedIds.has(file.storedPath) ? ' outline outline-2 outline-[var(--element-bg)] bg-black/[0.04] dark:bg-white/[0.06]' : ''}`}
                  title="拖动此行到桌面或文件夹即可导出真实文件；也可点「保存到…」"
                >
                  {rowContent}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 主站右侧：翻译工作区（自包含，支持粘贴 / 输入文字翻译） */}
      {variant === 'main' && translateOpen && (
        <div className="absolute right-6 top-6 bottom-6 w-80 z-10">
          <TranslateWorkspace onClose={() => setTranslateOpen(false)} />
        </div>
      )}
    </div>
  );
}

/**
 * 主站 OCR 工作区（与中转站浮窗 OcrBox 行为一致）：
 * 拖入 / 点击选择 / 粘贴图片 → AI 视觉 OCR，结果可复制或存入中转站；不依赖中转站已存文件。
 * prefillDataUrl 来自文件行点击 / 选中图片，可为 null（空，等待用户拖入或粘贴）。
 */
function OcrWorkspace({ prefillDataUrl, onClose }: { prefillDataUrl: string | null; onClose: () => void }) {
  const [dataUrl, setDataUrl] = useState<string | null>(prefillDataUrl);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 识别引擎：auto=优先云端视觉 OCR（不支持图片的模型如 DeepSeek 自动降级本地 PaddleOCR）；local=仅本地 PaddleOCR
  const [mode, setMode] = useState<'auto' | 'local'>('auto');
  // AI 深度增强：把 OCR 原文交给文本模型校对 / 整理（用于不支持识图的模型）。
  // 默认关，需用户主动开启（即同意），可随时关闭。
  const [enhance, setEnhance] = useState(false);
  const [enhanceLoading, setEnhanceLoading] = useState(false);
  const [enhancedText, setEnhancedText] = useState('');
  const [pdfLoading, setPdfLoading] = useState(false);

  // 将 OCR 原文交给文本模型校对整理（本地 PaddleOCR 识别 + DeepSeek 之类文本模型分析纠错）
  const applyEnhance = useCallback(async (src: string) => {
    setEnhanceLoading(true);
    try {
      const r = await api.aiOcrEnhance(src);
      setEnhancedText(r || '');
    } catch (e) {
      setEnhancedText('');
      setError('⚠ 深度增强失败：' + String(e).slice(0, 200) + '（已保留原始 OCR 文本）');
    } finally {
      setEnhanceLoading(false);
    }
  }, []);

  const toggleEnhance = () => {
    const next = !enhance;
    setEnhance(next);
    if (next && text) void applyEnhance(text);
    else if (!next) setEnhancedText('');
  };

  const exportPdf = async () => {
    if (!dataUrl) return;
    const p = await save({
      defaultPath: `ocr_${Date.now()}.pdf`,
      filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
    });
    if (!p) return;
    setPdfLoading(true);
    try {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
      const mime = m ? m[1] : 'image/png';
      const b64 = m ? m[2] : dataUrl.split(',')[1] || '';
      await api.ocrExportPdf(p, b64, mime);
      setError(null);
    } catch (e) {
      setError('⚠ 导出 PDF 失败：' + String(e).slice(0, 200));
    } finally {
      setPdfLoading(false);
    }
  };

  const display = enhance && enhancedText ? enhancedText : text;

  const run = useCallback(async (url: string) => {
    setLoading(true);
    setError(null);
    setDataUrl(url);
    setEnhancedText('');
    try {
      let ocrText = '';
      if (mode === 'local') {
        // 本地优先：跳过云端，直接用 PaddleOCR（离线、零 API 成本）
        const local = await loadPaddleOcr();
        ocrText = (await local.recognize(url)) || '';
      } else {
        // 云端优先：AI 视觉 OCR（质量更高）
        try {
          const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
          if (!m) throw new Error('图片数据格式错误');
          ocrText = (await api.aiVisionOcr(m[2], m[1])) || '';
        } catch (apiErr) {
          const msg = String(apiErr ?? '');
          const noApi = msg.includes('未配置') || msg.includes('API Key');
          // 不支持图片识别的模型（如 DeepSeek：unknown variant image_url / 400）同样降级到本地 PaddleOCR
          const visionUnsupported = /不支持|support|image|vision|400|variant|未知|image_url/i.test(msg);
          if (!noApi && !visionUnsupported) throw apiErr; // 其它错误（网络/鉴权）不降级
          try {
            const local = await loadPaddleOcr();
            const t = await local.recognize(url);
            if (t && t.trim()) ocrText = t;
            else throw apiErr;
          } catch (localErr) {
            if (noApi || visionUnsupported) {
              throw new Error(
                noApi
                  ? '未配置 API Key，且本地 PaddleOCR 未返回结果'
                  : '该模型不支持图片识别，且本地 PaddleOCR 未返回结果（可改用「本地 PaddleOCR」模式）',
              );
            }
            throw apiErr;
          }
        }
      }
      setText(ocrText || '');
      if (enhance && ocrText) await applyEnhance(ocrText);
    } catch (e) {
      console.error('[OCR] 识别失败:', e);
      const msg = String(e);
      const hint = /不支持|support|image|vision|400|模型/i.test(msg)
        ? ' — 可在「全局设置 → 模型」确认已为 OCR 单独指定「视觉模型」（对话模型往往不支持图片）'
        : '';
      setError('⚠ OCR 失败：' + msg.slice(0, 300) + hint);
    } finally {
      setLoading(false);
    }
  }, [mode, enhance, applyEnhance]);

  // 预填充：来自文件行 / 选中图片（prefill 变化时自动识别）
  useEffect(() => {
    if (prefillDataUrl) {
      setText('');
      setError(null);
      void run(prefillDataUrl);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillDataUrl]);

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => void run(r.result as string);
    r.readAsDataURL(f);
    e.target.value = '';
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (!f || !f.type.startsWith('image/')) return;
    const r = new FileReader();
    r.onload = () => void run(r.result as string);
    r.readAsDataURL(f);
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData.items;
    for (const it of Array.from(items)) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f && f.type.startsWith('image/')) {
          e.preventDefault();
          const r = new FileReader();
          r.onload = () => void run(r.result as string);
          r.readAsDataURL(f);
          return;
        }
      }
    }
  };

  const store = async () => {
    if (!dataUrl) return;
    try {
      await api.addBytesToDropzone(dataUrl, `ocr_${Date.now()}.png`);
    } catch {
      setError('存入中转站失败');
    }
  };

  return (
    <div className="w-full h-full flex flex-col glass-panel rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--element-border)] flex-shrink-0">
        <span className="text-sm font-medium flex items-center gap-1.5 text-neutral-700 dark:text-stone-200">
          <ScanText size={15} /> OCR 工作区
        </span>
        <button
          onClick={onClose}
          className="btn-press p-1 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-200 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          title="收起工作区"
        >
          <X size={15} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3">
        <div
          data-ocr-drop
          onClick={() => fileRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          onPaste={onPaste}
          className={`rounded-lg border-2 border-dashed px-3 py-5 text-center cursor-pointer text-xs transition-colors flex-shrink-0 ${dragOver ? 'border-[var(--element-bg)] bg-[var(--element-muted)]' : 'border-[var(--element-border)] text-neutral-400 dark:text-stone-500 hover:border-[var(--element-bg)]'}`}
        >
          {loading ? (
            <span className="inline-flex items-center gap-2 text-[var(--element-bg)]">
              <Loader2 size={16} className="animate-spin" /> 识别中…
            </span>
          ) : dataUrl ? (
            <img src={dataUrl} alt="预览" draggable={false} className="max-h-40 mx-auto rounded object-contain" />
          ) : (
            '拖入图片 / 点击选择图片 / 粘贴图片 → AI 视觉 OCR'
          )}
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={onFile} />
        </div>
        {error && (
          <div className="text-xs text-amber-600 dark:text-amber-400 flex-shrink-0">{error}</div>
        )}
        <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
          <div className="flex rounded-lg border border-[var(--element-border)] overflow-hidden text-[10px]">
            <button
              onClick={() => setMode('auto')}
              className={`px-2 py-0.5 transition-colors ${mode === 'auto' ? 'bg-[var(--element-bg)] text-white' : 'text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/10'}`}
            >
              自动（云端优先）
            </button>
            <button
              onClick={() => setMode('local')}
              className={`px-2 py-0.5 transition-colors ${mode === 'local' ? 'bg-[var(--element-bg)] text-white' : 'text-neutral-500 dark:text-stone-400 hover:bg-black/5 dark:hover:bg-white/10'}`}
            >
              本地 PaddleOCR
            </button>
          </div>
          <label
            className="flex items-center gap-1 text-[10px] text-neutral-500 dark:text-stone-400 cursor-pointer select-none"
            title="开启后把 OCR 文本交给文本模型（如 DeepSeek）校对 / 整理，会消耗 token；可随时关闭"
          >
            <input type="checkbox" checked={enhance} onChange={toggleEnhance} className="accent-[var(--element-bg)]" />
            AI 深度增强（纠错 / 整理）
          </label>
        </div>
        {enhanceLoading && (
          <div className="text-[10px] text-[var(--element-bg)] flex items-center gap-1 flex-shrink-0">
            <Loader2 size={11} className="animate-spin" /> 深度增强整理中…
          </div>
        )}
        <div className="flex items-center justify-between mb-1 flex-shrink-0">
          <span className="font-medium text-xs text-neutral-600 dark:text-stone-300">
            识别结果{enhance && enhancedText ? '（已增强）' : ''}
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => display && navigator.clipboard?.writeText(display)}
              disabled={!display}
              className="px-2 py-0.5 rounded text-[10px] bg-white/70 dark:bg-stone-700/70 hover:bg-white dark:hover:bg-stone-600 transition-colors disabled:opacity-40"
            >
              复制
            </button>
            <button
              onClick={() => void store()}
              disabled={!dataUrl}
              className="px-2 py-0.5 rounded text-[10px] bg-white/70 dark:bg-stone-700/70 hover:bg-white dark:hover:bg-stone-600 transition-colors disabled:opacity-40"
            >
              存入中转站
            </button>
            <button
              onClick={() => void exportPdf()}
              disabled={!dataUrl || pdfLoading}
              className="px-2 py-0.5 rounded text-[10px] bg-white/70 dark:bg-stone-700/70 hover:bg-white dark:hover:bg-stone-600 transition-colors disabled:opacity-40 flex items-center gap-1"
              title="将原始图片导出为保留版面的 PDF"
            >
              {pdfLoading ? <Loader2 size={11} className="animate-spin" /> : <FileDown size={11} />} 保存为 PDF
            </button>
          </div>
        </div>
        <pre className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed flex-1 min-h-0 overflow-y-auto bg-white/60 dark:bg-stone-800/60 border border-white/80 dark:border-stone-700/50 rounded-lg px-3 py-2 text-neutral-700 dark:text-stone-200">
          {display || 'OCR 文本将显示在这里…'}
        </pre>
      </div>
    </div>
  );
}

/**
 * 主站翻译工作区（与中转站浮窗 TranslateBox 行为一致）：
 * 粘贴 / 输入文字 → AI 翻译（中译），结果可复制；不依赖中转站已存文件。
 */
function TranslateWorkspace({ onClose }: { onClose: () => void }) {
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sourceLang, setSourceLang] = useState<string>(() => loadSourceLang());
  const [targetLang, setTargetLang] = useState<string>(() => loadTargetLang());

  const run = useCallback(async () => {
    if (!input.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.translateText(input, targetLang, sourceLang);
      setOutput(res || '');
    } catch (e) {
      setError('⚠ 翻译失败：' + String(e).slice(0, 200));
    } finally {
      setLoading(false);
    }
  }, [input, targetLang, sourceLang]);

  const selCls =
    'text-xs rounded-lg border border-[var(--element-border)] bg-white/60 dark:bg-stone-800/60 px-2 py-1 text-neutral-700 dark:text-stone-200 outline-none focus:border-[var(--element-bg)]';

  return (
    <div className="w-full h-full flex flex-col glass-panel rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--element-border)] flex-shrink-0">
        <span className="text-sm font-medium flex items-center gap-1.5 text-neutral-700 dark:text-stone-200">
          <Languages size={15} /> 翻译工作区
        </span>
        <button
          onClick={onClose}
          className="btn-press p-1 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-neutral-600 dark:hover:text-stone-200 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
          title="收起工作区"
        >
          <X size={15} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-3 flex flex-col gap-3">
        {/* 当前语言：放在上方输入框（原文）上面，含「自动识别」 */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-neutral-500 dark:text-stone-400">当前语言</span>
          <select
            value={sourceLang}
            onChange={(e) => {
              setSourceLang(e.target.value);
              saveSourceLang(e.target.value);
            }}
            className={selCls}
          >
            {SOURCE_LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center justify-between flex-shrink-0">
          <span className="text-xs font-medium text-neutral-600 dark:text-stone-300">原文</span>
          <button
            onClick={() => void run()}
            disabled={loading || !input.trim()}
            className="btn-press px-3 py-1 rounded-lg text-xs flex items-center gap-1.5 border border-[var(--element-border)] text-neutral-600 dark:text-stone-300 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)] transition-colors disabled:opacity-40"
          >
            <Languages size={14} /> 翻译
          </button>
        </div>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="粘贴或输入要翻译的文字…"
          className="flex-1 min-h-[80px] resize-none rounded-lg border border-[var(--element-border)] p-2 text-xs font-mono text-neutral-700 dark:text-stone-200 bg-white/60 dark:bg-stone-800/60 outline-none focus:border-[var(--element-bg)]"
        />
        {error && (
          <div className="text-xs text-amber-600 dark:text-amber-400 flex-shrink-0">{error}</div>
        )}
        {/* 目标语言：放在下方输入框（译文）上面，无「自动识别」 */}
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-neutral-500 dark:text-stone-400">目标语言</span>
          <select
            value={targetLang}
            onChange={(e) => {
              setTargetLang(e.target.value);
              saveTargetLang(e.target.value);
            }}
            className={selCls}
          >
            {TARGET_LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center justify-between flex-shrink-0">
          <span className="text-xs font-medium text-neutral-600 dark:text-stone-300">译文</span>
          <button
            onClick={() => output && navigator.clipboard?.writeText(output)}
            disabled={!output}
            className="px-2 py-0.5 rounded text-[10px] bg-white/70 dark:bg-stone-700/70 hover:bg-white dark:hover:bg-stone-600 transition-colors disabled:opacity-40"
          >
            复制
          </button>
        </div>
        <textarea
          readOnly
          value={output}
          placeholder="译文将显示在这里…"
          className="flex-1 min-h-[80px] resize-none rounded-lg border border-white/80 dark:border-stone-700/50 p-2 text-xs font-mono text-neutral-700 dark:text-stone-200 bg-white/60 dark:bg-stone-800/60"
        />
      </div>
    </div>
  );
}

export default TransferStationPanel;
