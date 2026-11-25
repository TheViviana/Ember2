/**
 * CR-20261121-55：右键「媒体库」菜单树——四容器与设置中的媒体库一致。
 * 文档组=PDF/HTML 附件（kind 'doc'），不再挂知识库文章列表。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMediaMenuTree } from '../../../src/app/canvas/media-menu-tree.ts';
import type { MediaEntry } from '../../../src/features/media/media-groups.ts';
import type { TreeDirNode, TreeNode } from '../../../src/app/tree/build-tree.ts';

function entry(path: string, kind: MediaEntry['kind']): MediaEntry {
  return { path, kind, bytes: 1, modifiedMs: 0 };
}

/** 取第 index 组并断言是名为 name 的目录组（同时完成 TreeNode 联合收窄）。 */
function dirGroup(tree: readonly TreeNode[], index: number, name: string): TreeDirNode {
  const node = tree[index];
  assert.ok(node !== undefined, `第 ${index} 组存在`);
  assert.equal(node.kind, 'dir');
  assert.equal(node.name, name);
  return node;
}

void test('四组直接取自媒体条目；文档组列出 PDF/HTML 附件而非文章', () => {
  const tree = buildMediaMenuTree([
    entry('media/image/ab/i.png', 'image'),
    entry('media/audio/cd/a.mp3', 'audio'),
    entry('media/video/ef/v.mp4', 'video'),
    entry('media/doc/ab/report.pdf', 'doc'),
    entry('media/doc/cd/page.html', 'doc'),
  ]);

  assert.deepEqual(
    tree.map((node) => node.name),
    ['图像', '音频', '视频', '文档'],
  );
  const docGroup = dirGroup(tree, 3, '文档');
  assert.deepEqual(
    docGroup.children.map((file) => file.name),
    ['report.pdf', 'page.html'],
  );
  assert.deepEqual(
    docGroup.children.map((file) => file.path),
    ['media/doc/ab/report.pdf', 'media/doc/cd/page.html'],
  );
});

void test('空库各组显示「暂无内容」哨兵；未命中的组不透出条目', () => {
  const tree = buildMediaMenuTree([]);
  const imageGroup = dirGroup(tree, 0, '图像');
  const docGroup = dirGroup(tree, 3, '文档');
  for (const group of [imageGroup, docGroup]) {
    assert.equal(group.children.length, 1);
    assert.equal(group.children[0]?.name, '暂无内容');
    assert.ok(group.children[0]?.path.endsWith('__empty__'));
  }

  const docOnly = buildMediaMenuTree([entry('media/doc/x/guide.pdf', 'doc')]);
  const emptyImage = dirGroup(docOnly, 0, '图像');
  assert.equal(emptyImage.children[0]?.name, '暂无内容');
  const filledDoc = dirGroup(docOnly, 3, '文档');
  assert.deepEqual(
    filledDoc.children.map((file) => file.name),
    ['guide.pdf'],
  );
});
