import { useCallback, useEffect, useReducer } from 'react';

export type EditorMode = 'edit' | 'read';

export interface EditorModeState {
  readonly mode: EditorMode;
  readonly focus: boolean;
}

export type EditorModeAction =
  | { readonly type: 'content'; readonly mode: EditorMode }
  | { readonly type: 'request'; readonly mode: EditorMode }
  | { readonly type: 'toggle-focus' }
  | { readonly type: 'exit-focus' };

export const INITIAL_EDITOR_MODE: EditorModeState = Object.freeze({ mode: 'edit', focus: false });

export function editorModeReducer(
  state: EditorModeState,
  action: EditorModeAction,
): EditorModeState {
  switch (action.type) {
    case 'content':
      return state.mode === action.mode ? state : { ...state, mode: action.mode };
    case 'request':
      return { mode: action.mode, focus: false };
    case 'toggle-focus':
      return { ...state, focus: !state.focus };
    case 'exit-focus':
      return state.focus ? { ...state, focus: false } : state;
  }
}

export function editorIsReadOnly(state: EditorModeState, closeLocked: boolean): boolean {
  return closeLocked || state.mode === 'read';
}

export function useEditorMode() {
  const [state, dispatch] = useReducer(editorModeReducer, INITIAL_EDITOR_MODE);
  const changeMode = useCallback((mode: EditorMode): void => {
    dispatch({ type: 'content', mode });
  }, []);
  const toggleFocus = useCallback((): void => dispatch({ type: 'toggle-focus' }), []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key === '1') {
        event.preventDefault();
        dispatch({ type: 'content', mode: 'edit' });
      } else if (event.key === '2') {
        event.preventDefault();
        dispatch({ type: 'toggle-focus' });
      } else if (event.key === '3') {
        event.preventDefault();
        dispatch({ type: 'content', mode: 'read' });
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  return { state, dispatch, changeMode, toggleFocus };
}
