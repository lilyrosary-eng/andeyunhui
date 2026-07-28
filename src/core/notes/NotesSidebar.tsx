import { PenTool } from 'lucide-react';
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

  return (
    <ModuleSidebarShell
      moduleId="notes"
      icon={<PenTool size={22} />}
      title={t('notes.moduleTitle')}
      onOpenModuleSettings={onModuleSetting}
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
