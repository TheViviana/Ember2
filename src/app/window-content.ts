/** CR-R6-3：内置浮窗内容统一显式注册，组件模块不再承担自注册副作用。 */
import {
  EDITOR_WINDOW_CONTENT,
  MEDIA_LIBRARY_WINDOW_CONTENT,
} from '../windows/content-types.ts';
import { registerWindowContent } from '../windows/use-window-manager.ts';
import { EditorWindow } from './panels/EditorWindow.tsx';
import { MediaLibraryWindow } from './panels/MediaLibraryWindow.tsx';

export function registerBuiltInWindowContent(): void {
  registerWindowContent(EDITOR_WINDOW_CONTENT, EditorWindow);
  registerWindowContent(MEDIA_LIBRARY_WINDOW_CONTENT, MediaLibraryWindow);
}
