// 茑萝 · IDE 文件浏览器模块（从 index.tsx IdeSidebar 演进而来，增强：搜索/图标/右键菜单/重命名）
// 由宿主作为 sidebar 独立渲染，通过 ideShared + 'ide-project-changed' 事件与 IdeEditor 通信。
const React = window.__HOST_REACT__;
const hostApi = window.__HOST_API__;
const { useState, useCallback, useEffect, useMemo } = React;
import { ideShared, isWindows } from './shared';
import {
  Folder,
  FolderOpen,
  File as FileIcon,
  FileCode2,
  FileJson2,
  FileText,
  Image as ImageIcon,
  ChevronRight,
  ChevronDown,
  RefreshCw,
  Search,
  FilePlus,
  FolderPlus,
  Pencil,
  Trash2,
  Copy,
} from 'lucide-react';
import * as ContextMenu from '@radix-ui/react-context-menu';

type DirEntry = { name: string; path: string; is_dir: boolean };

// 目录优先、同类按名称排序
function sortEntries(list: DirEntry[]): DirEntry[] {
  return [...list].sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
}

// 取路径 basename
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

// 按扩展名映射文件图标（lucide，轻量 SVG）
const EXT_ICON_MAP: Record<string, any> = {
  ts: FileCode2, tsx: FileCode2, js: FileCode2, jsx: FileCode2, mjs: FileCode2, cjs: FileCode2,
  rs: FileCode2, go: FileCode2, py: FileCode2, java: FileCode2, c: FileCode2, cpp: FileCode2, h: FileCode2,
  rb: FileCode2, php: FileCode2, swift: FileCode2, kt: FileCode2, sh: FileCode2, ps1: FileCode2,
  html: FileCode2, css: FileCode2, scss: FileCode2, less: FileCode2, vue: FileCode2, svelte: FileCode2,
  json: FileJson2, toml: FileJson2, yaml: FileJson2, yml: FileJson2, xml: FileJson2,
  md: FileText, txt: FileText, log: FileText,
  png: ImageIcon, jpg: ImageIcon, jpeg: ImageIcon, gif: ImageIcon, svg: ImageIcon, webp: ImageIcon, ico: ImageIcon,
  bmp: ImageIcon, tiff: ImageIcon,
};
function getFileIcon(name: string): any {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  return EXT_ICON_MAP[ext] || FileIcon;
}

// 路径转义（用于 shell 命令中的双引号包裹）
function shellQuote(p: string): string {
  return '"' + p.replace(/"/g, '\\"') + '"';
}

export function FileExplorer() {
  const [root, setRoot] = useState<string | null>(null);
  const [rootEntries, setRootEntries] = useState<DirEntry[]>([]);
  const [childrenMap, setChildrenMap] = useState<Record<string, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [folderError, setFolderError] = useState<string | null>(null);
  const [query, setQuery] = useState(''); // 文件名过滤
  const [renaming, setRenaming] = useState<{ path: string; isDir: boolean } | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [creating, setCreating] = useState<{ parent: string; isDir: boolean } | null>(null);
  const [createVal, setCreateVal] = useState('');
  const [busy, setBusy] = useState(false);

  const reloadDir = useCallback(async (dirPath: string) => {
    try {
      const list = await hostApi.invoke<DirEntry[]>('list_directory', { path: dirPath });
      const sorted = sortEntries(list);
      if (dirPath === root) setRootEntries(sorted);
      else setChildrenMap((prev) => ({ ...prev, [dirPath]: sorted }));
    } catch (e) {
      setFolderError('刷新目录失败：' + (e as Error).message);
    }
  }, [root]);

  const pickFolder = async () => {
    try {
      const picked = await hostApi.invoke<string | null>('pick_directory', {});
      const dir = picked ? picked.trim() : '';
      if (!dir) return;
      setRoot(dir);
      ideShared.projectRoot = dir;
      window.dispatchEvent(new CustomEvent('ide-project-changed', { detail: dir }));
      setFolderError(null);
      setQuery('');
      const list = await hostApi.invoke<DirEntry[]>('list_directory', { path: dir });
      setRootEntries(sortEntries(list));
      setChildrenMap({});
      setExpanded(new Set());
    } catch (e) {
      console.error('[IDE] 打开文件夹失败:', e);
      setFolderError('打开文件夹失败：' + (e as Error).message);
    }
  };

  const toggleDir = async (dirPath: string) => {
    if (expanded.has(dirPath)) {
      setExpanded((prev) => { const n = new Set(prev); n.delete(dirPath); return n; });
      return;
    }
    if (!childrenMap[dirPath]) {
      setLoading((prev) => new Set([...prev, dirPath]));
      try {
        const list = await hostApi.invoke<DirEntry[]>('list_directory', { path: dirPath });
        setChildrenMap((prev) => ({ ...prev, [dirPath]: sortEntries(list) }));
      } catch (e) {
        setFolderError('展开目录失败：' + (e as Error).message);
        setLoading((prev) => { const n = new Set(prev); n.delete(dirPath); return n; });
        return;
      }
      setLoading((prev) => { const n = new Set(prev); n.delete(dirPath); return n; });
    }
    setExpanded((prev) => new Set([...prev, dirPath]));
  };

  const openFile = async (p: string) => {
    if (!ideShared.addFileTab) {
      setFolderError('编辑器尚未就绪，请稍候再试');
      return;
    }
    try {
      const content = await hostApi.invoke<string>('read_text_file', { path: p });
      ideShared.addFileTab(p, content);
    } catch (e) {
      console.error('[IDE] 打开文件失败:', p, e);
      setFolderError('打开文件失败：' + (e as Error).message);
    }
  };

  // ===== 右键菜单操作 =====
  const startRename = (entry: DirEntry) => {
    setRenaming({ path: entry.path, isDir: entry.is_dir });
    setRenameVal(entry.name);
  };
  const commitRename = async () => {
    if (!renaming) return;
    const newName = renameVal.trim();
    if (!newName || newName === baseName(renaming.path)) { setRenaming(null); return; }
    const parent = renaming.path.replace(/[\\/][^\\/]+$/, '');
    const newPath = parent + (isWindows ? '\\' : '/') + newName;
    setBusy(true);
    try {
      // 取巧：rename 走 run_shell_command（move/mv 对文件和目录都生效），避免新增后端命令
      const cmd = isWindows
        ? `move /Y ${shellQuote(renaming.path)} ${shellQuote(newPath)}`
        : `mv ${shellQuote(renaming.path)} ${shellQuote(newPath)}`;
      await hostApi.invoke('run_shell_command', { command: cmd });
      if (parent === root) await reloadDir(root!);
      else if (expanded.has(parent)) await reloadDir(parent);
      setRenaming(null);
    } catch (e) {
      setFolderError('重命名失败：' + (e as Error).message);
    } finally { setBusy(false); }
  };

  const startCreate = (parent: string, isDir: boolean) => {
    setCreating({ parent, isDir });
    setCreateVal('');
  };
  const commitCreate = async () => {
    if (!creating) return;
    const name = createVal.trim();
    if (!name) { setCreating(null); return; }
    const newPath = creating.parent + (isWindows ? '\\' : '/') + name;
    setBusy(true);
    try {
      if (creating.isDir) {
        await hostApi.invoke('ensure_directory', { path: newPath });
      } else {
        await hostApi.invoke('write_text_file', { path: newPath, content: '' });
      }
      if (!expanded.has(creating.parent) && creating.parent !== root) {
        setExpanded((prev) => new Set([...prev, creating.parent]));
      }
      await reloadDir(creating.parent);
      setCreating(null);
    } catch (e) {
      setFolderError('新建失败：' + (e as Error).message);
    } finally { setBusy(false); }
  };

  const deleteEntry = async (entry: DirEntry) => {
    if (!confirm(`确定删除「${entry.name}」？${entry.is_dir ? '该操作将递归删除目录内所有内容。' : ''}`)) return;
    setBusy(true);
    try {
      if (entry.is_dir) {
        // 目录删除走 run_shell_command（delete_file 仅支持文件）
        const cmd = isWindows ? `rmdir /S /Q ${shellQuote(entry.path)}` : `rm -rf ${shellQuote(entry.path)}`;
        await hostApi.invoke('run_shell_command', { command: cmd });
      } else {
        await hostApi.invoke('delete_file', { path: entry.path });
      }
      const parent = entry.path.replace(/[\\/][^\\/]+$/, '');
      if (parent === root) await reloadDir(root!);
      else if (expanded.has(parent)) await reloadDir(parent);
    } catch (e) {
      setFolderError('删除失败：' + (e as Error).message);
    } finally { setBusy(false); }
  };

  const copyPath = (entry: DirEntry) => {
    try { navigator.clipboard?.writeText(entry.path); } catch { /* 忽略 */ }
  };

  // 文件名过滤：query 非空时仅显示匹配条目（含祖先目录）
  const q = query.trim().toLowerCase();
  const nameMatches = (e: DirEntry): boolean => !q || e.name.toLowerCase().includes(q);

  const renderEntry = (entry: DirEntry, depth: number): React.ReactNode => {
    const isExpandedDir = entry.is_dir && expanded.has(entry.path);
    const Icon = entry.is_dir ? (isExpandedDir ? FolderOpen : Folder) : getFileIcon(entry.name);
    const isRenaming = renaming?.path === entry.path;
    const isCreatingHere = creating?.parent === entry.path;
    const children = childrenMap[entry.path];
    // 搜索时：目录若自身不匹配且无匹配子项则折叠隐藏
    const showChildren = isExpandedDir && children && (!q || children.some(nameMatches) || entry.name.toLowerCase().includes(q));

    return (
      <React.Fragment key={entry.path}>
        <ContextMenu.Root>
          <ContextMenu.Trigger asChild>
            <div
              onClick={() => (entry.is_dir ? toggleDir(entry.path) : openFile(entry.path))}
              onDoubleClick={() => entry.is_dir && toggleDir(entry.path)}
              style={{ paddingLeft: 6 + depth * 13 }}
              className={`group flex items-center gap-1.5 pr-2 py-[3px] cursor-pointer text-xs transition-colors hover:bg-black/5 dark:hover:bg-white/5 ${
                entry.is_dir ? 'text-neutral-600 dark:text-stone-300' : 'text-neutral-500 dark:text-stone-400'
              }`}
            >
              <span className="w-3 shrink-0 flex justify-center text-neutral-400 dark:text-stone-500">
                {entry.is_dir ? (loading.has(entry.path) ? <RefreshCw size={11} className="animate-spin" /> : isExpandedDir ? <ChevronDown size={13} /> : <ChevronRight size={13} />) : null}
              </span>
              <Icon size={13} className="shrink-0 text-neutral-400 dark:text-stone-500" />
              {isRenaming ? (
                <input
                  autoFocus
                  value={renameVal}
                  onChange={(e: any) => setRenameVal(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e: any) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onClick={(e: any) => e.stopPropagation()}
                  className="flex-1 min-w-0 bg-white dark:bg-stone-800 border border-blue-400 rounded px-1 text-xs outline-none"
                />
              ) : (
                <span className="flex-1 truncate">{entry.name}</span>
              )}
            </div>
          </ContextMenu.Trigger>
          <ContextMenu.Portal>
            <ContextMenu.Content className="min-w-[140px] rounded-lg bg-white dark:bg-stone-800 border border-neutral-200 dark:border-stone-700 shadow-lg p-1 z-50 text-xs">
              <ContextMenu.Item className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer outline-none hover:bg-blue-500/10 text-neutral-700 dark:text-stone-200" onSelect={() => startCreate(entry.is_dir ? entry.path : entry.path.replace(/[\\/][^\\/]+$/, ''), false)}>
                <FilePlus size={12} /> 新建文件
              </ContextMenu.Item>
              <ContextMenu.Item className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer outline-none hover:bg-blue-500/10 text-neutral-700 dark:text-stone-200" onSelect={() => startCreate(entry.is_dir ? entry.path : entry.path.replace(/[\\/][^\\/]+$/, ''), true)}>
                <FolderPlus size={12} /> 新建文件夹
              </ContextMenu.Item>
              <ContextMenu.Item className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer outline-none hover:bg-blue-500/10 text-neutral-700 dark:text-stone-200" onSelect={() => startRename(entry)}>
                <Pencil size={12} /> 重命名
              </ContextMenu.Item>
              <ContextMenu.Item className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer outline-none hover:bg-blue-500/10 text-neutral-700 dark:text-stone-200" onSelect={() => copyPath(entry)}>
                <Copy size={12} /> 复制路径
              </ContextMenu.Item>
              <ContextMenu.Separator className="h-px bg-neutral-200 dark:bg-stone-700 my-1" />
              <ContextMenu.Item className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer outline-none hover:bg-red-500/10 text-red-600 dark:text-red-400" onSelect={() => deleteEntry(entry)}>
                <Trash2 size={12} /> 删除
              </ContextMenu.Item>
            </ContextMenu.Content>
          </ContextMenu.Portal>
        </ContextMenu.Root>
        {/* 内联新建输入框 */}
        {isCreatingHere && (
          <div style={{ paddingLeft: 6 + (depth + 1) * 13 }} className="flex items-center gap-1.5 py-[3px]">
            {creating?.isDir ? <Folder size={13} className="text-neutral-400" /> : <FilePlus size={13} className="text-neutral-400" />}
            <input
              autoFocus
              value={createVal}
              onChange={(e: any) => setCreateVal(e.target.value)}
              onBlur={commitCreate}
              onKeyDown={(e: any) => {
                if (e.key === 'Enter') { e.preventDefault(); commitCreate(); }
                if (e.key === 'Escape') setCreating(null);
              }}
              placeholder={creating?.isDir ? '文件夹名' : '文件名'}
              className="flex-1 min-w-0 bg-white dark:bg-stone-800 border border-blue-400 rounded px-1 text-xs outline-none"
            />
          </div>
        )}
        {showChildren && (
          children.length === 0 ? (
            <div style={{ paddingLeft: 6 + (depth + 1) * 13 }} className="pr-3 py-1 text-[11px] text-neutral-300 dark:text-stone-600">（空）</div>
          ) : (
            children.filter(nameMatches).map((c) => renderEntry(c, depth + 1))
          )
        )}
      </React.Fragment>
    );
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-2 py-2 border-b border-neutral-200/30 dark:border-stone-700/30 shrink-0 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <button onClick={pickFolder}
            className="flex-1 py-1.5 px-2 rounded-lg text-xs font-medium bg-[var(--element-bg)]/10 text-[var(--element-bg)] hover:bg-[var(--element-bg)]/20 transition-colors truncate">
            {root ? baseName(root) : '打开文件夹'}
          </button>
          {root && (
            <button onClick={() => reloadDir(root)} title="刷新"
              className="p-1.5 rounded-lg text-neutral-400 hover:text-neutral-600 dark:hover:text-stone-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
              <RefreshCw size={13} className={busy ? 'animate-spin' : ''} />
            </button>
          )}
        </div>
        {root && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-black/5 dark:bg-white/5">
            <Search size={12} className="text-neutral-400 shrink-0" />
            <input
              value={query}
              onChange={(e: any) => setQuery(e.target.value)}
              placeholder="过滤文件…"
              className="flex-1 min-w-0 bg-transparent outline-none text-xs text-neutral-700 dark:text-stone-200 placeholder:text-neutral-400"
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-neutral-400 hover:text-neutral-600 text-xs">✕</button>
            )}
          </div>
        )}
        {folderError && (
          <div className="px-2 py-1 text-[11px] text-red-500 dark:text-red-400 bg-red-500/10 rounded">{folderError}</div>
        )}
      </div>
      <div className="flex-1 overflow-auto min-h-0">
        {!root ? (
          <div className="px-2 py-4 text-xs text-neutral-400 dark:text-stone-500 text-center">选择项目目录开始浏览</div>
        ) : rootEntries.length === 0 ? (
          <div className="px-2 py-4 text-xs text-neutral-400 dark:text-stone-500 text-center">目录为空</div>
        ) : (
          <div className="py-1">
            {/* 根级右键菜单触发区：在根目录空白处新建 */}
            <ContextMenu.Root>
              <ContextMenu.Trigger asChild>
                <div>{rootEntries.filter(nameMatches).map((e) => renderEntry(e, 0))}</div>
              </ContextMenu.Trigger>
              <ContextMenu.Portal>
                <ContextMenu.Content className="min-w-[140px] rounded-lg bg-white dark:bg-stone-800 border border-neutral-200 dark:border-stone-700 shadow-lg p-1 z-50 text-xs">
                  <ContextMenu.Item className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer outline-none hover:bg-blue-500/10 text-neutral-700 dark:text-stone-200" onSelect={() => startCreate(root, false)}>
                    <FilePlus size={12} /> 新建文件
                  </ContextMenu.Item>
                  <ContextMenu.Item className="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer outline-none hover:bg-blue-500/10 text-neutral-700 dark:text-stone-200" onSelect={() => startCreate(root, true)}>
                    <FolderPlus size={12} /> 新建文件夹
                  </ContextMenu.Item>
                </ContextMenu.Content>
              </ContextMenu.Portal>
            </ContextMenu.Root>
          </div>
        )}
      </div>
    </div>
  );
}
