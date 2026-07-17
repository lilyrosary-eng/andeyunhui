import { useSyncExternalStore, useCallback, useEffect, useState } from 'react';
import { FileText, File, Trash2, Inbox, ExternalLink, Download, Save, ScanText, Languages } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { save } from '@tauri-apps/plugin-dialog';
import { api, type ImportedFile } from '@/lib/api';

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
  /** 文本类文件读取后传到外部（如「鸢尾花」页面打开编辑） */
  onOpenReadableFile?: (file: ImportedFile, content: string) => void;
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

export function TransferStationPanel({ onOpenReadableFile }: TransferStationPanelProps) {
  const tick = useSyncExternalStore(subscribe, getTick, getTick);
  const [files, setFiles] = useState<ImportedFile[]>([]);
  const [loading, setLoading] = useState(false);
  // 悬停时预取图片字节仅用于显示缩略图；原生拖出由 Rust 端 DoDragDrop 完成，无需前端字节缓存
  const [imgUrls, setImgUrls] = useState<Record<string, string>>({});
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
  }, []);

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
  // 结果 / 错误 / loading 状态按 storedPath 维度存储，展开时显示
  const [aiResults, setAiResults] = useState<Record<string, { kind: 'ocr' | 'translate'; text: string } | { kind: 'error'; text: string } | { kind: 'loading'; kindLabel: string }>>({});

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
      setAiResults(prev => ({ ...prev, [file.storedPath]: { kind: 'error', text: '⚠ OCR 失败：' + String(err).slice(0, 200) + ' — 可在「全局设置 → 模型」检查模型是否支持视觉输入' } }));
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

  const clearAiResult = useCallback((storedPath: string) => {
    setAiResults(prev => {
      const next = { ...prev };
      delete next[storedPath];
      return next;
    });
  }, []);

  return (
    <div className="flex-1 h-full overflow-hidden main-panel-bg p-6 fade-in">
      <div className="max-w-lg mx-auto">
        {/* 标题栏 */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <span className="text-[var(--element-bg)]">
              <Inbox size={22} />
            </span>
            <h2 className="text-lg font-semibold text-neutral-800 dark:text-stone-100">中转站</h2>
          </div>
          {files.length > 0 && (
            <button
              onClick={handleClearAll}
              className="btn-press px-3 py-1.5 rounded-lg text-xs text-red-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            >
              清空全部
            </button>
          )}
        </div>

        {/* 使用提示 */}
        <div className="glass-panel p-3 mb-5">
          <p className="text-xs text-neutral-400 dark:text-stone-500">
            拖放任意文件到应用窗口、或导入文档/图片（docx/pptx/xlsx/pdf、png/jpg…）都会自动存入此处；图片会同时进入笔记预览与图标栏中转站。
            文本类文件在「鸢尾花」页面拖入时可直接打开编辑；把文件拖到桌面或文件夹即可导出原始文件，也可用「保存到…」另存。
          </p>
        </div>

        {/* 文件列表 */}
        {loading && files.length === 0 && savingItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-neutral-400 dark:text-stone-500">
            <p className="text-sm">加载中…</p>
          </div>
        ) : files.length === 0 && savingItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3 text-neutral-400 dark:text-stone-500">
            <Inbox size={40} className="opacity-30" />
            <p className="text-sm">暂无文件</p>
            <p className="text-xs text-neutral-400/60 dark:text-stone-600">拖入文件后会自动出现在这里</p>
          </div>
        ) : (
          <div className="space-y-2">
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
              const rowContent = (
                <>
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
                          onClick={() => runOcr(file)}
                          className="btn-press p-1.5 rounded-lg text-neutral-400 dark:text-stone-500 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)] transition-colors"
                          title="AI 视觉 OCR（提取图片文字）"
                        >
                          <ScanText size={15} />
                        </button>
                        <button
                          onClick={() => runTranslate(file)}
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
                const aiResult = aiResults[file.storedPath];
                return (
                  <div
                    key={file.storedPath}
                    className="glass-panel p-3 flex flex-col gap-2 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                  >
                    <div
                      onMouseEnter={() => prefetch(file)}
                      onMouseDown={(e) => startNativeDrag(e, file)}
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
                  className="glass-panel p-3 flex items-center gap-3 hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-grab active:cursor-grabbing"
                  title="拖动此行到桌面或文件夹即可导出真实文件；也可点「保存到…」"
                >
                  {rowContent}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default TransferStationPanel;
