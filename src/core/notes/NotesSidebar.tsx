import { PenTool } from 'lucide-react';
import { ModuleSidebarShell } from "@/components/ModuleSidebarShell"
import { SecondaryNavShell } from "@/components/SecondaryNavShell"
import { NotesList } from "@/core/notes/NotesList"
import { NOTE_SOURCES, NOTE_AGGREGATE } from "@/core/notes/noteSources"
// 云图标与抽屉一起从插件共享目录取（相对路径，宿主没有 @shared 别名），
// 保证笔记 / 图片 / 视频三处的「云」按钮是同一个 SVG。
import { CloudIcon } from '../../../plugins/_shared/CloudDrawer'
import { logger } from "@/lib/logger"
import { useNotesStore } from '@/stores/notesStore';
import { useAppStore } from '@/stores/appStore';
import { useI18n } from '@/lib/i18n';

/** 网络视图的源列表：与「网络视频」的平台列表同一形态（选中态 + 名称/描述两行）。 */
function NetworkSourceList() {
  const source = useNotesStore(s => s.networkSource);
  const setSource = useNotesStore(s => s.setNetworkSource);
  // 聚合搜索排在最前：它是「一次问四个源」，不是第五个源，故与四个源分开成组。
  const scopes = [
    { ...NOTE_AGGREGATE, glyph: '聚' },
    ...NOTE_SOURCES.map((s) => ({ id: s.id, name: s.name, desc: s.desc, accent: s.accent, glyph: s.name.slice(0, 2) })),
  ];
  return (
    <div className="space-y-1">
      <p className="px-1 text-[11px] text-neutral-400 dark:text-stone-500">
        共 {NOTE_SOURCES.length} 个源 + 聚合搜索 · 官方开放接口
      </p>
      {scopes.map((s) => {
        const active = s.id === source;
        return (
          <button
            key={s.id}
            onClick={() => {
              setSource(s.id);
              useNotesStore.getState().setNetworkOpen(true);
            }}
            className={`w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
              active ? 'bg-black/5 dark:bg-white/10' : 'hover:bg-black/[0.03] dark:hover:bg-white/5'
            }`}
          >
            <span
              className="flex h-9 w-9 items-center justify-center rounded-lg shrink-0 text-white text-xs font-bold"
              style={{ background: s.accent }}
            >
              {s.glyph}
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-medium text-neutral-800 dark:text-stone-100 truncate">
                {s.name}
              </span>
              <span className="block text-xs text-neutral-400 dark:text-stone-500 truncate">
                {s.desc}
              </span>
            </span>
          </button>
        );
      })}
      <p className="px-2 pt-3 text-[11px] leading-relaxed text-neutral-400 dark:text-stone-500">
        只调用站点公开文档化的接口；结果可一键收藏为笔记（保存标题、摘要与原文链接）。
      </p>
    </div>
  );
}

/** 笔记侧边栏 — 从 store 订阅，无 props */
export function NotesSidebar() {
  const { t } = useI18n();
  const searchQuery = useNotesStore(s => s.searchQuery);
  const onSearchChange = useNotesStore(s => s.setSearchQuery);
  const onCreateNote = useNotesStore(s => s.createNote);
  const onModuleSetting = useAppStore(s => s.toggleNoteSettings);
  const networkOpen = useNotesStore(s => s.networkOpen);
  const setNetworkDrawerOpen = useNotesStore(s => s.setNetworkDrawerOpen);
  const drawerOpen = useNotesStore(s => s.networkDrawerOpen);

  // 入口与视频/音乐/图片模块**逐字一致**：侧栏标题栏的「☁ 云」按钮 + 右侧抽屉。
  const cloudButton = (
    <button
      onClick={() => setNetworkDrawerOpen(!drawerOpen)}
      title="云"
      className={`btn-press flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs transition-colors ${
        networkOpen || drawerOpen
          ? 'text-[var(--element-color-raw)] bg-[var(--element-muted)]'
          : 'text-neutral-500 dark:text-stone-400 hover:text-[var(--element-bg)] hover:bg-[var(--element-muted)]'
      }`}
    >
      <CloudIcon size={15} />
      <span>云</span>
    </button>
  );

  return (
    <ModuleSidebarShell
      moduleId="notes"
      icon={<PenTool size={22} />}
      title={t('notes.moduleTitle')}
      onOpenModuleSettings={onModuleSetting}
      titleActions={cloudButton}
      primaryAction={{ label: t('notes.newNote'), onClick: onCreateNote }}
      searchQuery={searchQuery}
      onSearchChange={(val) => {
        logger.sidebar.search(val);
        onSearchChange(val);
      }}
      searchPlaceholder={t('notes.searchPlaceholder')}
    >
      <SecondaryNavShell>
        {networkOpen ? <NetworkSourceList /> : <NotesList />}
      </SecondaryNavShell>
    </ModuleSidebarShell>
  )
}

export default NotesSidebar;
