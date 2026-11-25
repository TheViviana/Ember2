import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView, type DecorationSet } from '@codemirror/view';
import {
  mediaPreviewExtension,
  selectionIntersectsReference,
  visibleMediaReferences,
  type MediaPreviewReference,
} from '../../src/editor/media-preview.ts';
import { MediaPreviewWidget } from '../../src/editor/media-widgets.ts';

const image: MediaPreviewReference = {
  from: 0,
  to: 30,
  kind: 'image',
  path: 'media/image/a b.png',
  label: 'a b.png',
};

void test('光标进入/离开与多选区交集决定源码或控件', () => {
  assert.equal(selectionIntersectsReference({ from: 5, to: 5 }, image), true);
  assert.equal(selectionIntersectsReference({ from: 31, to: 31 }, image), false);
  assert.equal(selectionIntersectsReference({ from: 25, to: 35 }, image), true);
  assert.equal(selectionIntersectsReference({ from: 30, to: 35 }, image), false);
  assert.equal(
    visibleMediaReferences('x'.repeat(40), [{ from: 0, to: 0 }, { from: 3, to: 4 }], () => [image])
      .length,
    0,
  );
});

void test('decoration 随正文和选区更新，不产生文档事务', () => {
  const text = 'x'.repeat(40);
  const extract = (): MediaPreviewReference[] => [image];
  const extension = mediaPreviewExtension(extract);
  let state = EditorState.create({ doc: text, selection: EditorSelection.cursor(35), extensions: [extension] });
  const decorations = (): DecorationSet[] =>
    state.facet(EditorView.decorations).filter(
      (value): value is DecorationSet => typeof value === 'object' && 'between' in value,
    );
  const count = (): number => {
    let result = 0;
    for (const set of decorations()) set.between(0, state.doc.length, () => { result += 1; });
    return result;
  };
  assert.equal(count(), 1);
  state = state.update({ selection: EditorSelection.cursor(4) }).state;
  assert.equal(count(), 0);
  state = state.update({ selection: EditorSelection.cursor(35) }).state;
  assert.equal(count(), 1);
  assert.equal(state.doc.toString(), text);
});

void test('非法 range 被忽略且输出有序', () => {
  const refs = visibleMediaReferences('x'.repeat(20), [], () => [
    { ...image, from: 8, to: 12 },
    { ...image, from: -1, to: 4 },
    { ...image, from: 2, to: 2 },
    { ...image, from: 2, to: 6 },
    { ...image, from: 4, to: 30 },
  ]);
  assert.deepEqual(refs.map(({ from, to }) => [from, to]), [[2, 6], [8, 12]]);
});

void test('widget 以 kind/path/label 判断复用', () => {
  const first = new MediaPreviewWidget(image);
  assert.equal(first.eq(new MediaPreviewWidget(image)), true);
  assert.equal(first.eq(new MediaPreviewWidget({ ...image, label: 'other' })), false);
  assert.equal(first.eq(new MediaPreviewWidget({ ...image, kind: 'video' })), false);
});

interface FakeListener { (): void }
class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, FakeListener[]>();
  readonly attributes = new Map<string, string>();
  textContent = '';
  hidden = false;
  contentEditable = '';
  className = '';
  alt = '';
  loading = '';
  controls = false;
  preload = '';
  playsInline = false;
  pauseCalls = 0;
  loadCalls = 0;

  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  append(...children: FakeElement[]): void { this.children.push(...children); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  addEventListener(name: string, listener: FakeListener): void {
    const current = this.listeners.get(name) ?? [];
    current.push(listener);
    this.listeners.set(name, current);
  }
  emit(name: string): void { for (const listener of this.listeners.get(name) ?? []) listener(); }
  pause(): void { this.pauseCalls += 1; }
  load(): void { this.loadCalls += 1; }
}

function withFakeDom(run: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const imageConstructor = class extends FakeElement {};
  const videoConstructor = class extends FakeElement {};
  Object.defineProperties(globalThis, {
    document: {
      configurable: true,
      value: {
        createElement: (tag: string): FakeElement => {
          if (tag === 'img') return new imageConstructor(tag);
          if (tag === 'video') return new videoConstructor(tag);
          return new FakeElement(tag);
        },
      },
    },
    HTMLImageElement: { configurable: true, value: imageConstructor },
    HTMLVideoElement: { configurable: true, value: videoConstructor },
  });
  try {
    run();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'HTMLImageElement');
    Reflect.deleteProperty(globalThis, 'HTMLVideoElement');
  }
}

void test('widget 使用库内 URL，加载错误可见，destroy 停止并释放资源', () => {
  withFakeDom(() => {
    const widget = new MediaPreviewWidget({
      kind: 'audio',
      path: 'media/audio/a b.mp3',
      label: 'a b.mp3',
    });
    const root = widget.toDOM() as unknown as FakeElement;
    const media = root.children[0]!;
    const error = root.children[2]!;
    assert.equal(media.tagName, 'audio');
    assert.equal(media.attributes.get('src'), 'media://localhost/media/audio/a%20b.mp3');
    assert.equal(media.controls, true);
    assert.equal(error.hidden, true);
    media.emit('error');
    assert.equal(error.hidden, false);
    assert.equal(root.dataset.mediaError, 'true');
    media.emit('loadedmetadata');
    assert.equal(error.hidden, true);
    widget.destroy(root as unknown as HTMLElement);
    assert.equal(media.pauseCalls, 1);
    assert.equal(media.loadCalls, 1);
    assert.equal(media.attributes.has('src'), false);
  });
});

void test('图片 destroy 仅清理 src，不调用媒体播放方法', () => {
  withFakeDom(() => {
    const widget = new MediaPreviewWidget(image);
    const root = widget.toDOM() as unknown as FakeElement;
    const media = root.children[0]!;
    assert.equal(media.tagName, 'img');
    widget.destroy(root as unknown as HTMLElement);
    assert.equal(media.attributes.has('src'), false);
    assert.equal(media.pauseCalls, 0);
    assert.equal(media.loadCalls, 0);
  });
});
