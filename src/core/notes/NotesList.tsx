import { useMemo, useEffect, useRef, useCallback, useState } from 'react';
import { Copy, Pin, Trash2 } from 'lucide-react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger, ContextMenuSeparator } from "@/components/ui/context-menu"
import { api, NoteInfo } from "@/lib/api"
import { logger } from "@/lib/logger"
import { useNotesStore } from '@/stores/notesStore';
import { useFloatingNoteStore } from '@/stores/floatingNoteStore';

/** 高亮搜索匹配文字 */
function highlightText(text: string, query: string) {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return parts.map((part) =>
    part.toLowerCase() === query.toLowerCase()
      ? `<mark class="bg-yellow-200/60 dark:bg-yellow-600/30 text-inherit rounded-sm px-0.5">${part}</mark>`
      : part
  ).join('');
}

/** 根据日期时间生成分组标签
 * 分类规则：
 * - 一天内：半小时为一个区分点（30 分钟粒度）
 * - 三天内：两小时为一个区分点（2 小时粒度）
 * - 三天后：按天区分
 */
function getTimeGroup(note: NoteInfo): string {
  const now = new Date();
  const d = new Date(note.date);
  if (isNaN(d.getTime())) return '更早';
  const diffMs = now.getTime() - d.getTime();
  const diffH = diffMs / 3600000;
  const diffD = diffH / 24;
  if (diffH < 0) return '刚刚'; // 时间在未来（时钟误差）归为刚刚
  if (diffD < 1) {
    // 一天内：半小时区分
    const bucket = Math.floor(diffH * 2);
    if (bucket <= 0) return '刚刚';
    const minutes = bucket * 30;
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = minutes / 60;
    return hours % 1 === 0 ? `${hours} 小时前` : `${hours.toFixed(1)} 小时前`;
  }
  if (diffD < 3) {
    // 三天内：两小时区分
    const bucket = Math.floor(diffH / 2);
    const hours = bucket * 2;
    return `${hours} 小时前`;
  }
  // 三天后：天区分
  return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

export function NotesList() {
  // ====== store 订阅（同名变量，保持 JSX 不变） ======
  const rawNotes = useNotesStore(s => s.notes);
  const currentNoteId = useNotesStore(s => s.currentNoteId);
  const searchQuery = useNotesStore(s => s.searchQuery);
  const noteTagsMap = useNotesStore(s => s.noteTagsMap);
  const contentSearchResults = useNotesStore(s => s.contentSearchResults);
  const onNoteSelect = useNotesStore(s => s.loadNoteContent);
  const onClearCurrent = useNotesStore(s => s.clearCurrent);
  const onRefreshNotes = useNotesStore(s => s.refreshNotes);
  const setContentSearchResults = useNotesStore(s => s.setContentSearchResults);
  const floatingNoteIds = useFloatingNoteStore(s => s.floatingNoteIds);

  // ====== 内联编辑标题 ======
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');

  const startEditTitle = useCallback((id: string, title: string) => {
    setEditingId(id);
    setEditTitle(title);
  }, []);
  const commitEditTitle = useCallback((id: string) => {
    const newTitle = editTitle.trim();
    if (newTitle) {
      api.saveNote(id, newTitle, '').then(() => api.getAllNotes().then(onRefreshNotes));
      // 如果编辑的是当前笔记，同步更新编辑器标题
      if (id === currentNoteId) useNotesStore.getState().setTitle(newTitle);
    }
    setEditingId(null);
  }, [editTitle, currentNoteId, onRefreshNotes]);

  // ====== 内容搜索（防抖） ======
  const searchTimerRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    const q = searchQuery.trim().toLowerCase();
    if (!q) { setContentSearchResults(new Set()); return; }
    const titleMatched = new Set(rawNotes.filter(n => n.title.toLowerCase().includes(q)).map(n => n.id));
    const needsContentSearch = rawNotes.filter(n => !titleMatched.has(n.id));
    if (needsContentSearch.length === 0) { setContentSearchResults(new Set()); return; }
    searchTimerRef.current = setTimeout(async () => {
      try {
        const matchedIds = await api.searchNotesContent(q);
        setContentSearchResults(new Set(matchedIds));
      } catch {
        const matched = new Set<string>();
        for (const note of needsContentSearch) {
          try {
            const data = await api.getNoteContent(note.id);
            if (data.content && data.content.toLowerCase().includes(q)) matched.add(note.id);
          } catch { /* 读取失败跳过 */ }
        }
        setContentSearchResults(matched);
      }
    }, 500);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [searchQuery, rawNotes, setContentSearchResults]);

  // ====== 过滤笔记（排除浮窗 + 搜索匹配） ======
  const notes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const isTagSearch = q.startsWith('#');
    const tagName = isTagSearch ? q.slice(1) : '';
    return rawNotes.filter(n =>
      !floatingNoteIds.has(n.id) && (
        !q ||
        (isTagSearch
          ? (noteTagsMap[n.id] || []).some(t => t.toLowerCase().includes(tagName))
          : n.title.toLowerCase().includes(q) ||
            contentSearchResults.has(n.id) ||
            (noteTagsMap[n.id] || []).some(t => t.toLowerCase().includes(q))
        )
      )
    );
  }, [rawNotes, searchQuery, contentSearchResults, noteTagsMap, floatingNoteIds]);

  // ====== 拖拽成浮窗 ======
  const pendingDragRef = useRef<{ noteId: string; startX: number; startY: number; created: boolean } | null>(null);
  const onNoteDragStart = useCallback((noteId: string, clientX: number, clientY: number) => {
    pendingDragRef.current = { noteId, startX: clientX, startY: clientY, created: false };
  }, []);
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      const pending = pendingDragRef.current;
      if (!pending) return;
      const dist = Math.hypot(e.clientX - pending.startX, e.clientY - pending.startY);
      if (dist < 6) return;
      if (!pending.created) {
        pending.created = true;
        logger.notes.floatingDragged(pending.noteId);
        const note = rawNotes.find(n => n.id === pending.noteId);
        if (!note) { pendingDragRef.current = null; return; }
        const dragTitle = note.title || '浮窗笔记';
        api.createFloatingNoteWindow(pending.noteId, dragTitle, e.clientX - 40, e.clientY - 20)
          .catch(err => logger.notes.loadError('创建浮窗窗口', err));
        logger.notes.floatingCreated(pending.noteId);
      }
    };
    const onMouseUp = () => { pendingDragRef.current = null; };
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [rawNotes]);

  const { pinnedNotes, dailyGrouped } = useMemo(() => {
    const pinned: NoteInfo[] = [];
    const groups: Map<string, NoteInfo[]> = new Map();

    (notes || []).forEach(note => {
      if (note.pinned) {
        pinned.push(note);
      } else {
        const label = getTimeGroup(note);
        if (!groups.has(label)) groups.set(label, []);
        groups.get(label)!.push(note);
      }
    });

    return { pinnedNotes: pinned, dailyGrouped: groups };
  }, [notes]);

  return (
    <div className="flex-1 overflow-y-auto pr-1 space-y-3 scrollbar-hide">
      {/* 置顶笔记区 */}
      {pinnedNotes.length > 0 && (
        <div>
          <div className="text-xs font-medium text-yellow-500 dark:text-yellow-400 px-1 mb-1 tracking-wider flex items-center gap-1">
            <Pin size={12} fill="currentColor" />
            置顶笔记
            {pinnedNotes.length > 4 && <span className="text-yellow-400">({pinnedNotes.length})</span>}
          </div>
          {/* 容器限制高度：一次最多容纳 4 条，超过 4 条靠滚轮查看其余置顶 */}
          <div className="space-y-0.5 max-h-[150px] overflow-y-auto pr-1">
            {pinnedNotes.map((note) => (
              <ContextMenu key={note.id}>
                <ContextMenuTrigger asChild>
                  <div
                    onMouseDown={(e) => {
                      // 鼠标左键且非点击右键菜单
                      if (e.button === 0 && !(e.target as HTMLElement).closest('[role="menu"]')) {
                        onNoteDragStart?.(note.id, e.clientX, e.clientY);
                      }
                    }}
                    className={`px-3 py-2 rounded-xl cursor-pointer transition-colors text-sm ${currentNoteId === note.id ? 'bg-white/70 dark:bg-stone-700/50 shadow-sm text-neutral-800 dark:text-stone-100' : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400 hover:text-neutral-900 dark:hover:text-stone-200'}`}
                    onClick={() => {
                    logger.sidebar.selectNote(note.id, note.title);
                    onNoteSelect(note.id);
                  }}
                  >
                    <div className="font-medium truncate flex items-center gap-1" dangerouslySetInnerHTML={{ __html: highlightText(note.title, searchQuery || '') }} />
                    {(noteTagsMap?.[note.id]?.length ?? 0) > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {noteTagsMap![note.id].map(tag => (
                          <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-500 dark:text-blue-400">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem key="duplicate" onClick={() => {
                    logger.sidebar.duplicate(note.id);
                    api.duplicateNote(note.id).then(() => {
                      logger.sidebar.duplicateDone();
                      api.getAllNotes().then(onRefreshNotes);
                    });
                  }}>
                    <Copy size={14} />复制笔记
                  </ContextMenuItem>
                  <ContextMenuItem key="pin" onClick={() => {
                    logger.sidebar.togglePin(note.id);
                    api.togglePinNote(note.id).then(() => api.getAllNotes().then(onRefreshNotes));
                  }}>
                    <Pin size={14} />{note.pinned ? '取消置顶' : '置顶笔记'}
                  </ContextMenuItem>
                  <ContextMenuItem key="float" onClick={() => {
                    // 为了简化，使用默认坐标
                    api.createFloatingNoteWindow(note.id, note.title, 100, 100)
                      .catch((err) => console.error('[NotesList] createFloatingNoteWindow 调用失败:', err));
                  }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                      <line x1="9" y1="3" x2="9" y2="21"/>
                    </svg>
                    分离浮窗
                  </ContextMenuItem>
                  <ContextMenuSeparator key="sep" />
                  <ContextMenuItem key="delete" variant="destructive" onClick={() => {
                    logger.sidebar.deleteConfirm(note.id);
                    if (window.confirm('确定要把这篇笔记移到回收站吗？')) {
                      logger.sidebar.deleteConfirmed(note.id);
                      api.deleteNote(note.id).then(() => {
                        if (currentNoteId === note.id) {
                          logger.sidebar.deleteCurrent();
                          onClearCurrent();
                        }
                        api.getAllNotes().then(onRefreshNotes);
                      });
                    }
                  }}>
                    <Trash2 size={14} />删除笔记
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        </div>
      )}

      {/* 日常笔记区 — 按时间分组 */}
      {Array.from(dailyGrouped.entries()).map(([label, groupNotes]) => (
        <div key={label}>
          <div className="text-xs font-medium text-neutral-400 dark:text-stone-500 px-1 mb-1 tracking-wider">
            {label}
          </div>
          <div className="space-y-0.5">
            {groupNotes.map((note) => (
              <ContextMenu key={note.id}>
                <ContextMenuTrigger asChild>
                  <div
                    onMouseDown={(e) => {
                      if (e.button === 0 && !(e.target as HTMLElement).closest('[role="menu"]')) {
                        onNoteDragStart?.(note.id, e.clientX, e.clientY);
                      }
                    }}
                    className={`px-3 py-2 rounded-xl cursor-pointer transition-colors text-sm ${currentNoteId === note.id ? 'bg-white/70 dark:bg-stone-700/50 shadow-sm text-neutral-800 dark:text-stone-100' : 'hover:bg-black/5 dark:hover:bg-white/5 text-neutral-600 dark:text-stone-400 hover:text-neutral-900 dark:hover:text-stone-200'}`}
                    onClick={() => {
                      if (editingId) return;
                      logger.sidebar.selectNote(note.id, note.title);
                      onNoteSelect(note.id);
                    }}
                    onDoubleClick={(e) => {
                      e.preventDefault();
                      startEditTitle(note.id, note.title);
                    }}
                  >
                    {editingId === note.id ? (
                      <input
                        autoFocus
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onBlur={() => commitEditTitle(note.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitEditTitle(note.id);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        className="w-full bg-transparent border-b border-neutral-300 dark:border-stone-500 outline-none text-sm"
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <div className="font-medium truncate" dangerouslySetInnerHTML={{ __html: highlightText(note.title, searchQuery || '') }} />
                    )}
                    {((noteTagsMap as any)?.[note.id]?.length ?? 0) > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {(noteTagsMap as any)![note.id].map((tag: string) => (
                          <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-900/20 text-blue-500 dark:text-blue-400">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem onClick={() => {
                    logger.sidebar.duplicate(note.id);
                    api.duplicateNote(note.id).then(() => {
                      logger.sidebar.duplicateDone();
                      api.getAllNotes().then(onRefreshNotes);
                    });
                  }}>
                    <Copy size={14} />复制笔记
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => {
                    logger.sidebar.togglePin(note.id);
                    api.togglePinNote(note.id).then(() => api.getAllNotes().then(onRefreshNotes));
                  }}>
                    <Pin size={14} />{note.pinned ? '取消置顶' : '置顶笔记'}
                  </ContextMenuItem>
                  <ContextMenuItem onClick={() => {
                    api.createFloatingNoteWindow(note.id, note.title, 100, 100)
                      .catch((err) => console.error('[NotesList] createFloatingNoteWindow 调用失败:', err));
                  }}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                      <line x1="9" y1="3" x2="9" y2="21"/>
                    </svg>
                    分离浮窗
                  </ContextMenuItem>
                  <ContextMenuSeparator />
                  <ContextMenuItem variant="destructive" onClick={() => {
                    logger.sidebar.deleteConfirm(note.id);
                    if (window.confirm('确定要把这篇笔记移到回收站吗？')) {
                      logger.sidebar.deleteConfirmed(note.id);
                      api.deleteNote(note.id).then(() => {
                        if (currentNoteId === note.id) {
                          logger.sidebar.deleteCurrent();
                          onClearCurrent();
                        }
                        api.getAllNotes().then(onRefreshNotes);
                      });
                    }
                  }}>
                    <Trash2 size={14} />删除笔记
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export default NotesList;