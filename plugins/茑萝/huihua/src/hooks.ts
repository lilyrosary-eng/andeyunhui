import { useEffect, useState, useSyncExternalStore } from './host';
import { editor } from './store';
import type { ViewInfo } from './store';
import type { CursorInfo, EditorState } from './types';

export function useEditorState(): EditorState {
  return useSyncExternalStore(editor.subscribe, editor.getState, editor.getState);
}

export function useEditorCursor(): CursorInfo {
  const [, force] = useState(0);
  useEffect(() => editor.subscribeCursor(() => force((n) => n + 1)), []);
  return editor.getCursor();
}

export function useEditorView(): ViewInfo {
  return useSyncExternalStore(editor.subscribeView, editor.getView, editor.getView);
}
