import { PenTool, Globe } from 'lucide-react';
import { ModuleSidebarShell } from "@/components/ModuleSidebarShell"
import { SecondaryNavShell } from "@/components/SecondaryNavShell"
import { NotesList } from "@/core/notes/NotesList"
import { logger } from "@/lib/logger"
import { useNotesStore } from '@/stores/notesStore';
import { useAppStore } from '@/stores/appStore';
import { useI18n } from '@/lib/i18n';

/** 笔记侧边栏 — 从 store 订阅，无 props */
export function NotesSidebar() {
  const { t } = useI18n();
  const searchQuery = useNotesStore(s => s.searchQuery);
  const onSearchChange = useNotesStore(s => s.setSearchQuery);
  const onCreateNote = useNotesStore(s => s.createNote);
  const onModuleSetting = useAppStore(s => s.toggleNoteSettings);
  const networkOpen = useNotesStore(s => s.networkOpen);
  const setNetworkOpen = useNotesStore(s => s.setNetworkOpen);

  // 「网络」入口：与统计按钮同一套外观（icon-only、footerExtra 槽位、激活高亮）。
  // 点击进入独立的检索结果页，主区不再是编辑器；再点一次回到笔记。
  const networkButton = (
    <button
      onClick={() => setNetworkOpen(!networkOpen)}
      title={networkOpen ? '关闭网络检索' : '网络检索'}
      aria-label="网络检索"
      className={`btn-press w-9 h-9 flex items-center justify-center rounded-xl transition-colors ${
        networkOpen
          ? 'text-[var(--element-color-raw)] bg-[var(--element-muted)]'
          : 'text-neutral-400 dark:text-stone-500 hover:text-[var(--element-color-raw)] hover:bg-[var(--element-muted)]'
      }`}
    >
      <Globe size={18} />
    </button>
  );

  return (
    <ModuleSidebarShell
      moduleId="notes"
      icon={<PenTool size={22} />}
      title={t('notes.moduleTitle')}
      onOpenModuleSettings={onModuleSetting}
      footerExtra={networkButton}
      primaryAction={{ label: t('notes.newNote'), onClick: onCreateNote }}
      searchQuery={searchQuery}
      onSearchChange={(val) => {
        logger.sidebar.search(val);
        onSearchChange(val);
      }}
      searchPlaceholder={t('notes.searchPlaceholder')}
    >
      <SecondaryNavShell>
        <NotesList />
      </SecondaryNavShell>
    </ModuleSidebarShell>
  )
}

export default NotesSidebar;
