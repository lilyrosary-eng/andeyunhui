import { useAppStore } from '@/stores/appStore';
import { NotesEditor } from '@/core/notes/NotesEditor';
import { NotesSidebar } from '@/core/notes/NotesSidebar';
import { NoteSettingsPanel } from '@/core/notes/NoteSettingsPanel';

/**
 * 笔记模块 — 超薄壳。
 * 所有状态由子组件从 store 直接订阅，无 prop drilling。
 */
export function NotesModule() {
  const showNoteSettings = useAppStore(s => s.showNoteSettings);

  return (
    <div className="flex flex-1 h-full overflow-hidden">
      <NotesSidebar />
      <div className="flex-1 h-full overflow-hidden main-panel-bg p-6">
        {showNoteSettings ? <NoteSettingsPanel /> : <NotesEditor />}
      </div>
    </div>
  );
}
