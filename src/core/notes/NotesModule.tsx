import { useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useNotesStore } from '@/stores/notesStore';
import { registerNavigator } from '@/core/navigation/navigation';
import { api } from '@/lib/api';
import { NotesEditor } from '@/core/notes/NotesEditor';
import { NotesSidebar } from '@/core/notes/NotesSidebar';
import { NotesNetworkPage } from '@/core/notes/NotesNetworkPage';
import { NoteSettingsPanel } from '@/core/notes/NoteSettingsPanel';
import { NOTE_SOURCES, NOTE_AGGREGATE, resolveSourceScope, type NoteSourceKey } from '@/core/notes/noteSources';
// ⚠ 必须用相对路径，不能写 `@shared/CloudDrawer`：
//   `@shared` 是**插件构建**的别名（plugins/_shared/vite.shared.config.ts），
//   宿主（src/）的 vite/tsconfig 没有这个 alias —— 写成别名会让运行时 import 失败，
//   表现就是「点开网络按钮整个模块白屏」。
import { CloudDrawer } from '../../../plugins/_shared/CloudDrawer';
import { useNetworkSites } from '../../../plugins/_shared/useNetworkSites';
import { NotesSiteView } from '@/core/notes/NotesSiteView';
import { Cloud, PenTool, Globe } from 'lucide-react';

/**
 * 笔记模块 — 超薄壳。
 * 所有状态由子组件从 store 直接订阅，无 prop drilling。
 */
export function NotesModule() {
  const showNoteSettings = useAppStore(s => s.showNoteSettings);
  const networkOpen = useNotesStore(s => s.networkOpen);
  const drawerOpen = useNotesStore(s => s.networkDrawerOpen);
  const networkSource = useNotesStore(s => s.networkSource);
  const networkSiteId = useNotesStore(s => s.networkSiteId);
  const setNetworkOpen = useNotesStore(s => s.setNetworkOpen);
  const setNetworkDrawerOpen = useNotesStore(s => s.setNetworkDrawerOpen);
  const setNetworkSource = useNotesStore(s => s.setNetworkSource);
  const setNetworkSiteId = useNotesStore(s => s.setNetworkSiteId);
  // 抽屉第三组「自定义网站」：只有用户添加的网址（API 源不在这里，也不可编辑）
  const customSites = useNetworkSites('note');
  const activeSite = networkSiteId ? customSites.find((s) => s.id === networkSiteId) ?? null : null;

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
      {/* 自定义网站是独立浏览器视图，吃满内容区（不留编辑器的 p-6 内边距） */}
      <div className={`flex-1 h-full overflow-hidden immersive-safe-top ${showNoteSettings ? '' : networkSiteId ? 'main-panel-bg' : 'main-panel-bg p-6'}`}>
        {showNoteSettings ? (
          <NoteSettingsPanel />
        ) : networkSiteId ? (
          // 抽屉第三组「自定义网站」：用户添加的外部网址，主区整块让给它
          <NotesSiteView site={activeSite} />
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
        title="网络与网站"
        sectionLabel="来源"
        groups={[
          {
            key: 'local',
            title: '本地笔记',
            desc: '本机 Markdown 笔记',
            icon: <PenTool size={18} />,
            active: !networkOpen && !networkSiteId,
            onSelect: () => {
              setNetworkOpen(false);
              setNetworkSiteId(null);
              setNetworkDrawerOpen(false);
            },
          },
          {
            key: 'network',
            title: '网络检索',
            desc: 'arXiv / HuggingFace / GitHub / Semantic Scholar',
            icon: <Cloud size={18} />,
            active: networkOpen,
            defaultExpanded: true,
            items: [
              // 聚合搜索：前端并发打四个源再合并（后端仍是四个固定适配器）
              {
                id: NOTE_AGGREGATE.id,
                name: NOTE_AGGREGATE.name,
                desc: NOTE_AGGREGATE.desc,
                accent: NOTE_AGGREGATE.accent,
                badge: '并发',
              },
              ...NOTE_SOURCES.map((s) => ({
                id: s.id,
                name: s.name,
                desc: s.desc,
                accent: s.accent,
                badge: s.id === 'arxiv' ? '限速 3s' : undefined,
              })),
            ],
            onPick: (id) => {
              setNetworkSource(id as NoteSourceKey);
              setNetworkOpen(true);
              setNetworkDrawerOpen(false);
            },
          },
          {
            // 第三组：只放用户自定义的外部网站。
            // 与上面的检索 API 源互不影响 —— 顺序、增删都只在「设置 → 茑萝 → 网络拓展 → 笔记」里调整。
            key: 'custom',
            title: '自定义网站',
            desc: customSites.length
              ? `${customSites.length} 个站点 · 在设置里管理`
              : '在设置 → 茑萝 → 网络拓展 → 笔记 里添加',
            icon: <Globe size={18} />,
            active: !!networkSiteId,
            defaultExpanded: true,
            items: customSites.map((s) => ({
              id: s.id,
              name: s.name,
              desc: s.desc,
              accent: s.accent,
            })),
            onPick: (id) => {
              setNetworkSiteId(id);
              setNetworkDrawerOpen(false);
            },
          },
        ]}
        footer={`检索：只看官方开放接口（当前：${resolveSourceScope(networkSource).name}），结果可一键收藏为笔记（标题 / 摘要 / 原文链接，不复制全文）。
          自定义网站：用户添加的网址，用独立浏览器窗口打开；增删与顺序在「设置 → 茑萝 → 网络拓展 → 笔记」里管理。`}
      />
    </div>
  );
}
