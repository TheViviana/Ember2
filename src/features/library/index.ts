/**
 * CR-20261119-14：多库管理 UI（CR-A）——features/library re-export。
 */

export { libraryListReducer, LIBRARY_LIST_INITIAL } from './library-list-reducer.ts';
export type { LibraryListState, LibraryListAction } from './library-list-reducer.ts';

export { validateLibraryPath, sanitizeLibraryPath } from './library-validate.ts';

export { mapLibraryIpcError } from './library-errors.ts';
export type { IpcErrorLike } from './library-errors.ts';
