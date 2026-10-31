import { useEffect } from 'react';
import { useAppStore } from '@/stores/appStore';
import { useNotesStore } from '@/stores/notesStore';
import { registerNavigator } from '@/core/navigation/navigation';
import { NotesEditor } from '@/core/notes/NotesEditor';
import { NotesSidebar } from '@/core/notes/NotesSidebar';
import { NoteSettingsPanel } from '@/core/notes/NoteSettingsPanel';

/**
 * 笔记模块 — 超薄壳。
 * 所有状态由子组件从 store 直接订阅，无 prop drilling。
 */
export function NotesModule() {
  const showNoteSettings = useAppStore(s => s.showNoteSettings);

  // 命令面板「笔记 › 某篇」直达：统一走导航契约，不再依赖面板硬编码打开逻辑。
  useEffect(() => registerNavigator('notes', (target) => {
    const noteId = (target.props?.noteId as string | undefined) || target.entity;
    if (!noteId) return false;
    // setActiveModule 已在导航前执行，它会顺带把笔记设置页关掉
    void useNotesStore.getState().loadNoteContent(noteId);
    return true;
  }), []);

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
