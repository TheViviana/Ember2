/**
 * CR-20261119-05：文档节点卡片三件套、高度阈值切换、内容滚动区与视口裁剪。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractNodeViews,
  type CanvasNodeView,
} from '../../../src/app/canvas/node-layout.ts';
import { createNodeLayer, type NodeLayerParent } from '../../../src/app/canvas/node-layer.ts';
import { createViewportTransform } from '../../../src/app/canvas/viewport.ts';

interface FakeElement {
  className: string;
  textContent: string;
  style: { left: string; top: string; width: string; height: string };
  dataset: Record<string, string>;
  tabIndex: number;
  parent: FakeElement | null;
  children: FakeElement[];
  append(...children: FakeElement[]): void;
  remove(): void;
  setAttribute(name: string, value: string): void;
}

function fakeElement(): FakeElement {
  const element: FakeElement = {
    className: '',
    textContent: '',
    style: { left: '', top: '', width: '', height: '' },
    dataset: {},
    tabIndex: -1,
    parent: null,
    children: [],
    append(...children: FakeElement[]): void {
      for (const child of children) {
        child.parent = element;
        element.children.push(child);
      }
    },
    remove(): void {
      if (element.parent === null) return;
      const index = element.parent.children.indexOf(element);
      if (index >= 0) element.parent.children.splice(index, 1);
      element.parent = null;
    },
    setAttribute(): void {
      // 假元素不需要属性存储：文档节点未使用 setAttribute。
    },
  };
  return element;
}

function fakeRoot(): { element: FakeElement } {
  return { element: fakeElement() };
}

function createLayer(
  root: { element: FakeElement },
  options: {
    readonly meta?: (path: string) => { summary: string | null; tags: readonly string[] } | null;
    readonly text?: (
      path: string,
    ) => { text: string; truncated: boolean; fromLive: boolean; failed: boolean } | null;
  } = {},
) {
  return createNodeLayer(root.element as unknown as NodeLayerParent, {
    className: 'node-layer',
    nodeClassName: 'node',
    createElement: () => fakeElement() as unknown as HTMLElement,
    createChildElement: () => fakeElement() as unknown as HTMLElement,
    docClassNames: {
      body: 'doc-body',
      summary: 'doc-summary',
      kicker: 'doc-kicker',
      kickerBadge: 'doc-kicker-badge',
      footer: 'doc-footer',
      tags: 'doc-tags',
      tag: 'doc-tag',
      meta: 'doc-meta',
      links: 'doc-links',
      linkOut: 'doc-link-out',
      linkBack: 'doc-link-back',
      content: 'doc-content',
      text: 'doc-text',
      hint: 'doc-hint',
      expand: 'doc-expand',
    },
    readDocMeta: options.meta,
    readDocText: options.text,
  });
}

const viewport = { width: 800, height: 600 };
const transform = createViewportTransform();

function itemOf(root: { element: FakeElement }): FakeElement {
  const nodeLayer = root.element.children[0];
  const item = nodeLayer?.children[0];
  assert.notEqual(item, undefined);
  return item as FakeElement;
}

function childByClass(element: FakeElement, className: string): FakeElement | undefined {
  const direct = element.children.find((child) => child.className === className);
  if (direct !== undefined) return direct;
  for (const child of element.children) {
    const nested = childByClass(child, className);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

const DOC_PATH = 'notes/doc.md';

void test('extractNodeViews：document 节点透出 docPath，缺失或非文档不带', () => {
  const views = extractNodeViews([
    { id: 'd', x: 0, y: 0, type: 'document', docPath: DOC_PATH, label: 'doc.md' },
    { id: 'no-path', x: 0, y: 0, type: 'document' },
    { id: 'text', x: 0, y: 0, type: 'text', label: '文本' },
  ]);
  assert.equal(views[0]?.docPath, DOC_PATH);
  assert.equal(views[1]?.docPath, undefined);
  assert.equal(views[2]?.docPath, undefined);
});

void test('卡片模式：外标题 + 简介 + 标签 chips ≤3（CR-20261121-56），多余显示 +n', () => {
  const root = fakeRoot();
  const layer = createLayer(root, {
    meta: () => ({ summary: '卡片简介', tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }),
  });
  const node: CanvasNodeView = { type: 'document', id: 'd', label: 'doc.md', x: 0, y: 0, docPath: DOC_PATH };
  layer.setNodes([node], transform, viewport);

  const item = itemOf(root);
  assert.equal(item.dataset.nodeType, 'document');
  assert.equal(childByClass(item, 'doc-title'), undefined, '标题已外移，卡内无标题条');
  assert.equal(childByClass(root.element, 'node-label')?.textContent, 'doc.md');
  assert.equal(childByClass(item, 'doc-body')?.className, 'doc-body');
  assert.equal(childByClass(item, 'doc-summary')?.textContent, '卡片简介');
  const tags = childByClass(item, 'doc-tags');
  assert.deepEqual(
    tags?.children.map((chip) => chip.textContent),
    ['a', 'b', 'c', '+4'],
  );
  assert.equal(childByClass(item, 'doc-content'), undefined, '卡片模式不挂载滚动区');
});

void test('卡片模式降级：无 summary 显示「暂无简介」muted 占位（CR-20261121-45），无 tags 不占行', () => {
  const root = fakeRoot();
  const layer = createLayer(root, { meta: () => ({ summary: null, tags: [] }) });
  layer.setNodes(
    [{ type: 'document', id: 'd', label: 'doc.md', x: 0, y: 0, docPath: DOC_PATH }],
    transform,
    viewport,
  );

  const item = itemOf(root);
  // CR-20261121-45：无摘要且无正文回退 → 「暂无简介」文案 + data-no-summary（muted 灰）
  assert.equal(childByClass(item, 'doc-summary')?.textContent, '暂无简介');
  assert.equal(item.dataset.noSummary, 'true');
  assert.equal(childByClass(item, 'doc-tags')?.children.length, 0);
});

void test('高度阈值：h = 96 保持卡片，h = 97 进入内容模式', () => {
  const root = fakeRoot();
  const layer = createLayer(root, {
    meta: () => ({ summary: '简介', tags: [] }),
    text: () => ({ text: '正文', truncated: false, fromLive: true, failed: false }),
  });
  const card: CanvasNodeView = { type: 'document', id: 'd', label: 'd', x: 0, y: 0, h: 96, docPath: DOC_PATH };
  layer.setNodes([card], transform, viewport);
  let item = itemOf(root);
  assert.equal(childByClass(item, 'doc-content'), undefined, '96px 仍是卡片');
  assert.notEqual(childByClass(item, 'doc-body'), undefined);

  layer.setNodes([{ ...card, h: 97 }], transform, viewport);
  item = itemOf(root);
  assert.equal(childByClass(item, 'doc-body'), undefined, '内容模式移除卡片正文');
  assert.equal(childByClass(item, 'doc-content')?.dataset.nodeScroll, 'true');
  assert.equal(childByClass(item, 'doc-text')?.textContent, '正文');
  // live text 无「预览快照」提示。
  assert.equal(childByClass(item, 'doc-hint')?.textContent, '');
});

void test('内容模式提示：快照来源与截断提示', () => {
  const root = fakeRoot();
  const layer = createLayer(root, {
    text: () => ({ text: '正文', truncated: true, fromLive: false, failed: false }),
  });
  layer.setNodes(
    [{ type: 'document', id: 'd', label: 'd', x: 0, y: 0, h: 300, docPath: DOC_PATH }],
    transform,
    viewport,
  );
  const item = itemOf(root);
  assert.equal(childByClass(item, 'doc-hint')?.textContent, '内容过长已截断，双击节点打开编辑查看全文');
  assert.equal(childByClass(item, 'doc-text')?.textContent, '正文');
});

void test('视口裁剪：离开视口卸载内容滚动 DOM，回到视口重新挂载', () => {
  const root = fakeRoot();
  const layer = createLayer(root, {
    text: () => ({ text: '正文', truncated: false, fromLive: true, failed: false }),
  });
  const node: CanvasNodeView = { type: 'document', id: 'd', label: 'd', x: 0, y: 0, h: 300, docPath: DOC_PATH };
  layer.setNodes([node], transform, viewport);
  assert.notEqual(childByClass(itemOf(root), 'doc-content'), undefined);

  layer.setNodes([{ ...node, x: 5000 }], transform, viewport);
  assert.equal(childByClass(itemOf(root), 'doc-content'), undefined, '视口外不挂载滚动区');
  assert.notEqual(childByClass(root.element, 'node-label'), undefined, '外标题仍保留（离视口只卸内容区）');

  layer.setNodes([node], transform, viewport);
  assert.notEqual(childByClass(itemOf(root), 'doc-content'), undefined, '回到视口重新挂载');
});
