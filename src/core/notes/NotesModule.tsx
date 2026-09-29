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
      {/* immersive-safe-top 打在编辑区自己这层（它自带 main-panel-bg）：顶部 38px 带子用同一底色
          填满，不产生色差条。侧栏由 ModuleSidebarShell 自带同一个类（它自带 nav-secondary-bg）。 */}
      <div className={`flex-1 h-full overflow-hidden immersive-safe-top ${showNoteSettings ? '' : 'main-panel-bg p-6'}`}>
        {showNoteSettings ? <NoteSettingsPanel /> : <NotesEditor />}
      </div>
    </div>
  );
}
