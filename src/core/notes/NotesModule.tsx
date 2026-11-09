import { useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useNotesStore } from '@/stores/notesStore';
import { registerNavigator } from '@/core/navigation/navigation';
import { api } from '@/lib/api';
import { NotesEditor } from '@/core/notes/NotesEditor';
import { NotesSidebar } from '@/core/notes/NotesSidebar';
import { NotesNetworkPage } from '@/core/notes/NotesNetworkPage';
import { NoteSettingsPanel } from '@/core/notes/NoteSettingsPanel';
import { NOTE_SOURCES } from '@/core/notes/noteSources';
import { CloudDrawer } from '@shared/CloudDrawer';
import { Globe, PenTool } from 'lucide-react';

/**
 * 笔记模块 — 超薄壳。
 * 所有状态由子组件从 store 直接订阅，无 prop drilling。
 */
export function NotesModule() {
  const showNoteSettings = useAppStore(s => s.showNoteSettings);
  const networkOpen = useNotesStore(s => s.networkOpen);
  const drawerOpen = useNotesStore(s => s.networkDrawerOpen);
  const networkSource = useNotesStore(s => s.networkSource);
  const setNetworkOpen = useNotesStore(s => s.setNetworkOpen);
  const setNetworkDrawerOpen = useNotesStore(s => s.setNetworkDrawerOpen);
  const setNetworkSource = useNotesStore(s => s.setNetworkSource);

  // 命令面板「笔记 › 某篇」直达：统一走导航契约，不再依赖面板硬编码打开逻辑。
  useEffect(() => registerNavigator('notes', (target) => {
    const noteId = (target.props?.noteId as string | undefined) || target.entity;
    if (!noteId) return false;
    // setActiveModule 已在导航前执行，它会顺带把笔记设置页关掉
    void useNotesStore.getState().loadNoteContent(noteId);
    return true;
  }), []);

  // 外部模块（如阅读「导出读书笔记」）保存笔记后的列表刷新广播：
  // 事件契约 'andy:notes-refresh'，插件侧只 dispatch，不直接 import 本 store。
  useEffect(() => {
    const onRefresh = () => {
      api.getAllNotes()
        .then((notes) => useNotesStore.getState().refreshNotes(notes))
        .catch(() => { /* 刷新失败不影响主流程 */ });
    };
    window.addEventListener('andy:notes-refresh', onRefresh);
    return () => window.removeEventListener('andy:notes-refresh', onRefresh);
  }, []);

  return (
    <div className="relative flex flex-1 h-full overflow-hidden">
      <NotesSidebar />
      {/* immersive-safe-top 打在编辑区自己这层（它自带 main-panel-bg）：顶部 38px 带子用同一底色
          填满，不产生色差条。侧栏由 ModuleSidebarShell 自带同一个类（它自带 nav-secondary-bg）。 */}
      <div className={`flex-1 h-full overflow-hidden immersive-safe-top ${showNoteSettings ? '' : 'main-panel-bg p-6'}`}>
        {showNoteSettings ? (
          <NoteSettingsPanel />
        ) : networkOpen ? (
          // 「网络」是独立结果页：侧栏入口进入，主区整块让给它，不挤在编辑器里
          <NotesNetworkPage />
        ) : (
          <NotesEditor />
        )}
      </div>
      {/* 源选择抽屉：与视频「云视频」/音乐「云音乐」同一套组件与交互 */}
      <CloudDrawer
        open={drawerOpen}
        onClose={() => setNetworkDrawerOpen(false)}
        title="网络检索"
        sectionLabel="检索源"
        groups={[
          {
            key: 'local',
            title: '本地笔记',
            desc: '本机 Markdown 笔记',
            icon: <PenTool size={18} />,
            active: !networkOpen,
            onSelect: () => {
              setNetworkOpen(false);
              setNetworkDrawerOpen(false);
            },
          },
          {
            key: 'network',
            title: '网络检索',
            desc: 'arXiv / HuggingFace / GitHub / Semantic Scholar',
            icon: <Globe size={18} />,
            active: networkOpen,
            defaultExpanded: true,
            items: NOTE_SOURCES.map((s) => ({
              id: s.id,
              name: s.name,
              desc: s.desc,
              accent: s.accent,
              badge: s.id === 'arxiv' ? '限速 3s' : undefined,
            })),
            onPick: (id) => {
              setNetworkSource(id as (typeof NOTE_SOURCES)[number]['id']);
              setNetworkOpen(true);
              setNetworkDrawerOpen(false);
            },
          },
        ]}
        footer={`只看官方开放接口（当前：${NOTE_SOURCES.find((s) => s.id === networkSource)?.name ?? '—'}）。
          结果可一键收藏为笔记：保存标题、摘要与原文链接（引用），不复制全文。`}
      />
    </div>
  );
}
