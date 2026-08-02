// 茑萝 · IDE 命令面板模块（cmdk 内核）
// 模式：默认=文件快速打开(Ctrl+P) | `>` 前缀=命令(Ctrl+Shift+P) | `#` 前缀=内容搜索(search_content)
// 由 IdeEditor 作为 overlay 渲染，通过 props 接收命令列表与打开文件回调。
const React = window.__HOST_REACT__;
const hostApi = window.__HOST_API__;
const { useState, useEffect, useMemo, useRef, useCallback } = React;
import { Command } from 'cmdk';
import { ideShared } from './shared';
import { File as FileIcon, Search, ChevronRight, Hash } from 'lucide-react';

export interface PaletteCommand {
  id: string;
  label: string;
  shortcut?: string;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  root: string | null;
  onOpenFile: (path: string) => void;
  commands: PaletteCommand[];
  /** 初始模式：'files' | 'commands'。由触发快捷键决定 */
  initialMode?: 'files' | 'commands';
}

interface FileItem { path: string; name: string; dir: string }
interface SearchHit { path: string; line: number; text: string }

// ===== 文件递归枚举（带缓存，避免每次打开面板重复遍历）=====
const fileCache = new Map<string, { files: FileItem[]; ts: number }>();
const FILE_CACHE_TTL = 60_000; // 60s
const MAX_FILES = 6000;
const MAX_DEPTH = 15;

async function enumerateFiles(root: string): Promise<FileItem[]> {
  const cached = fileCache.get(root);
  if (cached && Date.now() - cached.ts < FILE_CACHE_TTL) return cached.files;
  const files: FileItem[] = [];
  const sep = /\\/.test(root) ? '\\' : '/';
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length && files.length < MAX_FILES) {
    const { dir, depth } = queue.shift()!;
    if (depth > MAX_DEPTH) continue;
    try {
      const entries = await hostApi.invoke<{ name: string; path: string; is_dir: boolean }[]>('list_directory', { path: dir });
      for (const e of entries) {
        if (files.length >= MAX_FILES) break;
        if (e.is_dir) queue.push({ dir: e.path, depth: depth + 1 });
        else files.push({ path: e.path, name: e.name, dir: dir.slice(root.length).replace(/^[\\/]/, '') });
      }
    } catch { /* 跳过无权限目录 */ }
  }
  fileCache.set(root, { files, ts: Date.now() });
  return files;
}

// 简单模糊匹配：子串优先，再按路径长度（短=近根=优先）
function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const idx = t.indexOf(q);
  if (idx < 0) return -1;
  // 完整词匹配加分，路径短加分
  let score = 100 - idx;
  if (idx === 0 || t[idx - 1] === '/' || t[idx - 1] === '\\') score += 50;
  score -= t.length * 0.1;
  return score;
}

export function CommandPalette({ open, onOpenChange, root, onOpenFile, commands, initialMode }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimer = useRef<number | null>(null);
  const inputRef = useRef<any>(null);

  // 模式判定
  const mode: 'commands' | 'content' | 'files' = query.startsWith('>') ? 'commands' : query.startsWith('#') ? 'content' : 'files';
  const term = mode === 'commands' ? query.slice(1).trim() : mode === 'content' ? query.slice(1).trim() : query.trim();

  // 打开时重置 + 预加载文件
  useEffect(() => {
    if (!open) return;
    setQuery(initialMode === 'commands' ? '>' : '');
    setSearchHits([]);
    if (root) {
      setLoadingFiles(true);
      enumerateFiles(root).then((f) => { setFiles(f); setLoadingFiles(false); });
    }
    // 聚焦输入框
    setTimeout(() => inputRef.current?.focus?.(), 0);
  }, [open, root, initialMode]);

  // 内容搜索：# 前缀，防抖 250ms
  useEffect(() => {
    if (mode !== 'content' || !root || term.length < 2) { setSearchHits([]); setSearching(false); return; }
    setSearching(true);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(async () => {
      try {
        const hits = await hostApi.invoke<SearchHit[]>('search_content', { root, pattern: term, max_results: 100 });
        setSearchHits(hits);
      } catch (e) {
        setSearchHits([]);
      } finally { setSearching(false); }
    }, 250);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [mode, term, root]);

  // 文件列表排序（模糊匹配 + MRU）
  const recent = useMemo(() => { try { return ideShared.recentFiles?.() || []; } catch { return []; } }, [files, open]);
  const rankedFiles = useMemo(() => {
    if (mode !== 'files' || !term) return files.slice(0, 200);
    const scored = files
      .map((f) => ({ f, s: fuzzyScore(term, f.name) }))
      .filter((x) => x.s >= 0);
    // MRU 加分
    const recentSet = new Set(recent);
    scored.forEach((x) => { if (recentSet.has(x.f.path)) x.s += 80; });
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, 200).map((x) => x.f);
  }, [files, term, mode, recent]);

  const handleOpenFile = useCallback((path: string) => {
    onOpenFile(path);
    onOpenChange(false);
  }, [onOpenFile, onOpenChange]);

  const handleCommand = useCallback((cmd: PaletteCommand) => {
    cmd.run();
    onOpenChange(false);
  }, [onOpenChange]);

  if (!open) return null;

  const filteredCommands = mode === 'commands' && term
    ? commands.filter((c) => c.label.toLowerCase().includes(term.toLowerCase()))
    : mode === 'commands' ? commands : [];

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] bg-black/30" onClick={() => onOpenChange(false)}>
      <div
        className="w-full max-w-xl mx-4 rounded-xl bg-white dark:bg-stone-900 border border-neutral-200 dark:border-stone-700 shadow-2xl overflow-hidden"
        onClick={(e: any) => e.stopPropagation()}
      >
        <Command shouldFilter={false} loop>
          <div className="flex items-center gap-2 px-3 py-2.5 border-b border-neutral-100 dark:border-stone-800">
            <Search size={15} className="text-neutral-400 shrink-0" />
            <Command.Input
              ref={inputRef as any}
              value={query}
              onValueChange={setQuery}
              placeholder="搜索文件…  > 命令  # 内容搜索"
              className="flex-1 bg-transparent outline-none text-sm text-neutral-800 dark:text-stone-100 placeholder:text-neutral-400"
            />
            <kbd className="text-[10px] text-neutral-400 border border-neutral-200 dark:border-stone-700 rounded px-1.5 py-0.5">ESC</kbd>
          </div>
          <Command.List className="max-h-[50vh] overflow-auto p-1">
            <Command.Empty className="py-6 text-center text-xs text-neutral-400">
              {mode === 'content' ? (searching ? '搜索中…' : term.length < 2 ? '输入至少 2 个字符搜索文件内容' : '无匹配内容') : loadingFiles ? '加载文件列表…' : '无匹配结果'}
            </Command.Empty>

            {/* 命令模式 */}
            {mode === 'commands' && (
              <Command.Group heading="命令" className="text-xs">
                {filteredCommands.map((cmd) => (
                  <Command.Item
                    key={cmd.id}
                    value={cmd.label}
                    onSelect={() => handleCommand(cmd)}
                    className="flex items-center gap-2 px-2.5 py-2 rounded-md cursor-pointer aria-selected:bg-blue-500/10 text-neutral-700 dark:text-stone-200"
                  >
                    <ChevronRight size={13} className="text-neutral-400" />
                    <span className="flex-1">{cmd.label}</span>
                    {cmd.shortcut && <kbd className="text-[10px] text-neutral-400">{cmd.shortcut}</kbd>}
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* 内容搜索模式 */}
            {mode === 'content' && searchHits.length > 0 && (
              <Command.Group heading={`内容匹配（${searchHits.length}）`} className="text-xs">
                {searchHits.map((hit, i) => (
                  <Command.Item
                    key={hit.path + ':' + hit.line + ':' + i}
                    value={hit.path + ' ' + hit.text}
                    onSelect={() => handleOpenFile(hit.path)}
                    className="flex flex-col gap-0.5 px-2.5 py-1.5 rounded-md cursor-pointer aria-selected:bg-blue-500/10"
                  >
                    <div className="flex items-center gap-1.5 text-neutral-700 dark:text-stone-200">
                      <FileIcon size={12} className="text-neutral-400 shrink-0" />
                      <span className="truncate text-xs">{hit.path.replace(/^.*[\\/]/, '')}</span>
                      <span className="text-[10px] text-neutral-400 shrink-0">:{hit.line}</span>
                    </div>
                    <div className="text-[11px] text-neutral-500 dark:text-stone-400 truncate pl-4">{hit.text}</div>
                  </Command.Item>
                ))}
              </Command.Group>
            )}

            {/* 文件模式 */}
            {mode === 'files' && rankedFiles.length > 0 && (
              <Command.Group heading={root ? `文件（${rankedFiles.length}${files.length > 200 ? '+' : ''}）` : '文件'} className="text-xs">
                {rankedFiles.map((f) => (
                  <Command.Item
                    key={f.path}
                    value={f.path + ' ' + f.name}
                    onSelect={() => handleOpenFile(f.path)}
                    className="flex items-center gap-2 px-2.5 py-1.5 rounded-md cursor-pointer aria-selected:bg-blue-500/10 text-neutral-700 dark:text-stone-200"
                  >
                    <FileIcon size={12} className="text-neutral-400 shrink-0" />
                    <span className="truncate">{f.name}</span>
                    {f.dir && <span className="text-[10px] text-neutral-400 truncate ml-auto pl-2">{f.dir}</span>}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
