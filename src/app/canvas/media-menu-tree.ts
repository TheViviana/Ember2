/**
 * CR-20261121-55：右键「媒体库」菜单树——与设置中的媒体库四容器口径一致。
 *
 * 纯逻辑（零 React / 零 IPC）：图像/音频/视频/文档(doc=PDF/HTML 附件)四组直接取自
 * `media/media_list` 的 MediaEntry；文档组不再挂知识库文章列表（用户裁定：
 * 文章不在媒体库菜单出现，PDF/HTML 以文件名平铺）。
 */
import { fileNameFromPath } from '../dnd/finder-paths.ts';
import type { MediaEntry } from '../../features/media/media-groups.ts';
import type { TreeNode } from '../tree/build-tree.ts';

const EMPTY_SENTINEL_SUFFIX = '__empty__';

function group(
  entries: readonly MediaEntry[],
  kind: MediaEntry['kind'],
  name: string,
  path: string,
): readonly TreeNode[] {
  const files = entries.filter((entry) => entry.kind === kind);
  return [
    {
      kind: 'dir',
      path,
      name,
      children:
        files.length === 0
          ? [{ kind: 'file' as const, name: '暂无内容', path: `${path}${EMPTY_SENTINEL_SUFFIX}` }]
          : files.map((entry) => ({
              kind: 'file' as const,
              name: fileNameFromPath(entry.path),
              path: entry.path,
            })),
    },
  ];
}

export function buildMediaMenuTree(entries: readonly MediaEntry[]): readonly TreeNode[] {
  return [
    ...group(entries, 'image', '图像', '__media_image__'),
    ...group(entries, 'audio', '音频', '__media_audio__'),
    ...group(entries, 'video', '视频', '__media_video__'),
    ...group(entries, 'doc', '文档', '__media_docs__'),
  ];
}
