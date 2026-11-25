/**
 * P6-C1-C：媒体节点渲染视图、`media://` URL 与 DOM 层缩略图（无 jsdom，用假元素）。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  extractNodeViews,
  mediaUrlForPath,
} from '../../../src/app/canvas/node-layout.ts';
import { createNodeLayer, type NodeLayerParent } from '../../../src/app/canvas/node-layer.ts';
import { createAddMediaNodeCommand } from '../../../src/app/canvas/canvas-interactions.ts';
import { createViewportTransform } from '../../../src/app/canvas/viewport.ts';

/** 最小事件对象：媒体控件只需要 stopPropagation 可观测。 */
interface FakeEvent {
  stopped: number;
  stopPropagation(): void;
}

function fakeEvent(): FakeEvent {
  return {
    stopped: 0,
    stopPropagation(): void {
      this.stopped += 1;
    },
  };
}

interface FakeElement {
  className: string;
  textContent: string;
  style: { left: string; top: string; width: string; height: string };
  dataset: Record<string, string>;
  attributes: Record<string, string>;
  parent: FakeElement | null;
  children: FakeElement[];
  listeners: Record<string, Array<(event: FakeEvent) => void>>;
  paused: boolean;
  pauseCalls: number;
  /** CR-20261121-56：音频自定义播放器事件用的媒体元数据（缺省 undefined）。 */
  duration?: number;
  currentTime?: number;
  append(child: FakeElement): void;
  remove(): void;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: (event: FakeEvent) => void): void;
  emit(type: string, event?: FakeEvent): FakeEvent;
  removeAttribute(name: string): void;
  load(): void;
  pause(): void;
}

function fakeElement(): FakeElement {
  const element: FakeElement = {
    className: '',
    textContent: '',
    style: { left: '', top: '', width: '', height: '' },
    dataset: {},
    attributes: {},
    parent: null,
    children: [],
    listeners: {},
    paused: true,
    pauseCalls: 0,
    duration: undefined,
    currentTime: undefined,
    append(child: FakeElement): void {
      child.parent = element;
      element.children.push(child);
    },
    remove(): void {
      if (element.parent === null) return;
      const index = element.parent.children.indexOf(element);
      if (index >= 0) element.parent.children.splice(index, 1);
      element.parent = null;
    },
    setAttribute(name: string, value: string): void {
      element.attributes[name] = value;
    },
    addEventListener(type: string, listener: (event: FakeEvent) => void): void {
      (element.listeners[type] ??= []).push(listener);
    },
    emit(type: string, event: FakeEvent = fakeEvent()): FakeEvent {
      for (const listener of element.listeners[type] ?? []) listener(event);
      return event;
    },
    removeAttribute(name: string): void {
      delete element.attributes[name];
    },
    load(): void {
      // 模拟 HTMLMediaElement.load；只用于释放路径，不产生副作用。
    },
    pause(): void {
      element.pauseCalls += 1;
      element.paused = true;
    },
  };
  return element;
}

void test('extractNodeViews：媒体节点带 kind/path，其它类型与旧媒体节点不带', () => {
  const views = extractNodeViews([
    { id: 'm', x: 0, y: 0, type: 'media', kind: 'image', path: 'media/image/ab/cat.png' },
    { id: 't', x: 0, y: 0, type: 'text', label: '文本' },
    { id: 'bad-kind', x: 0, y: 0, type: 'media', kind: 'file', path: 'media/x' },
    { id: 'no-path', x: 0, y: 0, type: 'media', kind: 'image' },
  ]);
  assert.deepEqual(views[0]?.media, {
    kind: 'image',
    path: 'media/image/ab/cat.png',
  });
  assert.equal(views[1]?.media, undefined);
  assert.equal(views[2]?.media, undefined);
  assert.equal(views[3]?.media, undefined);
});

void test('mediaUrlForPath：逐段编码、保留分层、归一化反斜杠与前导斜杠', () => {
  assert.equal(
    mediaUrlForPath('media/image/ab/cat.png'),
    'media://localhost/media/image/ab/cat.png',
  );
  assert.equal(
    mediaUrlForPath('\\media\\image\\旧 图.png'),
    'media://localhost/media/image/%E6%97%A7%20%E5%9B%BE.png',
  );
});

void test('createAddMediaNodeCommand：默认标签取库内路径文件名，可显式传源文件名', () => {
  const fallback = createAddMediaNodeCommand(0, 0, 'media/image/ab/hash.png', 'image');
  const named = createAddMediaNodeCommand(0, 0, 'media/image/ab/hash.png', 'image', 'cat.png');
  if (fallback.kind !== 'addNode' || named.kind !== 'addNode') assert.fail('期望 addNode');
  assert.equal(fallback.node.label, 'hash.png');
  assert.equal(named.node.label, 'cat.png');
});

function createLayer(playerClassName?: string) {
  const world = fakeElement();
  const layer = createNodeLayer(world as unknown as NodeLayerParent, {
    className: 'node-layer',
    nodeClassName: 'node',
    createElement: () => fakeElement() as unknown as HTMLElement,
    createChildElement: () => fakeElement() as unknown as HTMLElement,
    mediaClassNames: {
      image: 'media-image',
      label: 'media-label',
      placeholder: 'media-placeholder',
      ...(playerClassName === undefined ? {} : { player: playerClassName }),
    },
  });
  return { world, layer };
}

/** 取媒体节点的播放控件元素（节点 → 内表面 → visual）。 */
function playerOf(world: FakeElement, index = 0): FakeElement {
  const item = world.children[0]?.children[index];
  const player = item?.children[1]?.children[0];
  if (player === undefined) assert.fail('缺少媒体播放控件');
  return player;
}

void test('媒体节点渲染图片缩略图与底部源文件名，且同内容轮次不重建', () => {
  const { world, layer } = createLayer();
  const transform = createViewportTransform();
  const nodes = [
    {
      id: 'm',
      label: 'cat.png',
      x: 0,
      y: 0,
      media: { kind: 'image' as const, path: 'media/image/ab/dd43e088.png' },
    },
  ];

  layer.setNodes(nodes, transform);
  const item = world.children[0]?.children[0];
  assert.equal(item?.dataset.nodeType, 'media');
  const kicker = item?.children[0];
  const surface = item?.children[1];
  const footer = item?.children[2];
  const image = surface?.children[0];
  const label = footer?.children[0];
  assert.equal(kicker?.className, 'media-kicker');
  assert.equal(kicker?.children[0]?.textContent, 'EMBER / 图像');
  assert.equal(kicker?.children[1]?.textContent, '预览');
  assert.equal(surface?.className, 'media-surface');
  assert.equal(footer?.className, 'media-footer');
  assert.equal(image?.className, 'media-image');
  assert.equal(image?.attributes.src, 'media://localhost/media/image/ab/dd43e088.png');
  assert.equal(image?.attributes.alt, 'cat.png');
  assert.equal(image?.attributes.draggable, 'false');
  assert.equal(label?.className, 'media-label');
  assert.equal(label?.textContent, 'cat.png');

  layer.setNodes(nodes, transform);
  assert.equal(world.children[0]?.children[0], item, '复用节点元素');
  assert.equal(item?.children[1]?.children[0], image, '内容未变不重建缩略图');

  const first = nodes[0];
  if (first === undefined) assert.fail('缺少节点');
  layer.setNodes([{ ...first, label: 'renamed.png' }], transform);
  assert.equal(item?.children[1]?.children[0], image, '仅改标签时保留图片元素');
  assert.equal(item?.children[2]?.children[0]?.textContent, 'renamed.png');
});

void test('音频节点渲染隐藏 audio 元素 + 自定义控件条（CR-20261121-56）', () => {
  const { world, layer } = createLayer();
  layer.setNodes(
    [{ id: 'a', label: 'voice.mp3', x: 0, y: 0, media: { kind: 'audio', path: 'media/audio/ab/v.mp3' } }],
    createViewportTransform(),
  );
  const item = world.children[0]?.children[0];
  const audioEl = item?.children[1]?.children[0];
  const strip = item?.children[1]?.children[1];
  const label = item?.children[2]?.children[0];
  assert.equal(audioEl?.className, 'media-audio-el', '隐藏 audio 只承担播放');
  assert.equal(audioEl?.attributes.controls, undefined, '原生控件不再渲染');
  assert.equal(audioEl?.attributes.preload, 'metadata');
  assert.equal(audioEl?.attributes.src, 'media://localhost/media/audio/ab/v.mp3');
  assert.equal(strip?.className, 'media-audio-player');
  assert.equal(strip?.attributes['data-media-player'], 'audio', 'engine 靠此属性识别控件条');
  assert.equal(label?.textContent, 'voice.mp3');
  // 控件条结构：圆钮 + 进度条(含填充) + 时间。
  assert.equal(strip?.children.length, 3);
  const track = strip?.children[1];
  assert.equal(track?.children[0]?.className, 'media-audio-fill');
});

void test('音频控件条：click/dblclick 拦截、pointerdown 放行；播放钮切换状态（CR-20261121-56）', () => {
  const { world, layer } = createLayer();
  layer.setNodes(
    [{ id: 'a', label: 'a.mp3', x: 0, y: 0, media: { kind: 'audio', path: 'media/audio/ab/a.mp3' } }],
    createViewportTransform(),
  );
  const item = world.children[0]?.children[0];
  const audioEl = item?.children[1]?.children[0] ?? assert.fail('缺少 audio 元素');
  const strip = item?.children[1]?.children[1] ?? assert.fail('缺少控件条');
  assert.equal(strip.emit('pointerdown').stopped, 0, 'pointerdown 放行（engine 前置分区接管）');
  assert.equal(strip.emit('click').stopped, 1, 'click 拦截');
  assert.equal(strip.emit('dblclick').stopped, 1, 'dblclick 拦截');

  const play = strip.children[0];
  assert.equal(play?.textContent, '\u25B6\uFE0E', '初始为播放钮');

  // 播放中点击=暂停（假元素有 pause 能力）。
  audioEl.paused = false;
  play?.emit('click');
  assert.equal(audioEl.paused, true, '播放中点击触发 pause');
  assert.equal(audioEl.pauseCalls, 1);

  // 暂停中点击=请求播放（假元素无 play 能力，toggle 安全无操作）。
  play?.emit('click');
  assert.equal(audioEl.paused, true, '无 play 能力时保持暂停、不崩溃');

  // 播放/暂停事件驱动按钮字形；timeupdate 驱动进度填充与时间文本。
  audioEl.duration = 90;
  audioEl.currentTime = 45;
  audioEl.emit('timeupdate');
  const track = strip.children[1];
  assert.equal(track?.children[0]?.style.width, '50.0%');
  assert.equal(strip.children[2]?.textContent, '0:45 / 1:30');
  audioEl.emit('play');
  assert.equal(play?.textContent, '\u23F8\uFE0E');
  audioEl.emit('pause');
  assert.equal(play?.textContent, '\u25B6\uFE0E');
});

void test('视频节点渲染 video 控件（controls/preload/样式类不变）', () => {
  const { world, layer } = createLayer();
  layer.setNodes(
    [{ id: 'v', label: 'clip.mp4', x: 0, y: 0, media: { kind: 'video', path: 'media/video/ef/c.mp4' } }],
    createViewportTransform(),
  );
  const player = world.children[0]?.children[0]?.children[1]?.children[0];
  assert.equal(player?.className, 'media-player', '节点层样式类不变');
  assert.equal(player?.attributes.controls, '');
  assert.equal(player?.attributes.preload, 'metadata');
  assert.equal(player?.attributes.draggable, 'false');
  assert.equal(player?.attributes.src, 'media://localhost/media/video/ef/c.mp4');
});

// CR-20261120-29：媒体节点「只是个样子」根因回归——CSS Modules 哈希类名必须由 engine 注入，
// 否则 `.media-player` 的 pointer-events:auto 不生效（nodeLayer 是 none），点击永远落不到控件。

void test('播放控件使用注入的 CSS Modules 类名（视频原生控件；音频控件条，CR-20261121-56）', () => {
  const hashed = '_media-player_5v3l5_259';
  const { world, layer } = createLayer(hashed);
  layer.setNodes(
    [
      { id: 'a', label: 'v.mp3', x: 0, y: 0, media: { kind: 'audio', path: 'media/audio/ab/v.mp3' } },
      { id: 'v', label: 'c.mp4', x: 0, y: 0, media: { kind: 'video', path: 'media/video/ef/c.mp4' } },
    ],
    createViewportTransform(),
  );
  // 音频：隐藏元素走 audioEl 档（该用例未注入 audio 类名 → 默认字符串），控件条同。
  assert.equal(playerOf(world, 0).className, 'media-audio-el');
  const audioStrip = world.children[0]?.children[0]?.children[1]?.children[1];
  assert.equal(audioStrip?.className, 'media-audio-player');
  // 视频：原生控件仍用注入的哈希类。
  assert.equal(playerOf(world, 1).className, hashed);
});

void test('CR-20261121-46：播放控件标记 data-media-player；pointerdown/mousedown 放行，click/dblclick 仍拦', () => {
  const { world, layer } = createLayer();
  layer.setNodes(
    [{ id: 'v', label: 'c.mp4', x: 0, y: 0, media: { kind: 'video', path: 'media/video/ef/c.mp4' } }],
    createViewportTransform(),
  );
  const player = playerOf(world);
  assert.equal(player.attributes['data-media-player'], 'video', 'engine 靠此属性识别控件区');
  for (const type of ['pointerdown', 'mousedown']) {
    const event = player.emit(type);
    assert.equal(event.stopped, 0, `${type} 必须放行给画布（旧实现整块拦截导致视频节点无法拖动）`);
  }
  for (const type of ['click', 'dblclick']) {
    const event = player.emit(type);
    assert.equal(event.stopped, 1, `${type} 仍须 stopPropagation（控件上的双击不透传成节点双击）`);
  }
});

void test('单播放策略：一个控件开始播放时暂停其它媒体控件', () => {
  const { world, layer } = createLayer();
  layer.setNodes(
    [
      { id: 'a', label: 'a.mp3', x: 0, y: 0, media: { kind: 'audio', path: 'media/audio/ab/a.mp3' } },
      { id: 'b', label: 'b.mp3', x: 0, y: 0, media: { kind: 'audio', path: 'media/audio/cd/b.mp3' } },
    ],
    createViewportTransform(),
  );
  const first = playerOf(world, 0);
  const second = playerOf(world, 1);
  first.paused = false;
  second.paused = false;

  second.emit('play');

  assert.equal(first.paused, true, '其它正在播放的控件被暂停');
  assert.equal(first.pauseCalls, 1);
  assert.equal(second.pauseCalls, 0, '自身不受 pauseOthers 影响');
});

void test('engine 注入媒体类名，且 CSS 规则显式放开 pointer-events', () => {
  const engine = readFileSync(
    new URL('../../../src/app/canvas/engine.ts', import.meta.url),
    'utf8',
  );
  const css = readFileSync(
    new URL('../../../src/app/canvas/canvas.module.css', import.meta.url),
    'utf8',
  );
  assert.match(engine, /player:\s*classOf\('media-player'\)/, 'engine 必须注入哈希后的播放控件类');
  assert.match(engine, /audioPlayer:\s*classOf\('mediaAudioPlayer'\)/, 'engine 必须注入音频控件条哈希类');
  assert.match(css, /\.nodeLayer\s*\{[\s\S]*?pointer-events:\s*none/, 'nodeLayer 仍是 none');
  const rule = /\.media-player\s*\{[\s\S]*?\}/.exec(css)?.[0] ?? '';
  assert.match(rule, /pointer-events:\s*auto/, '.media-player 必须恢复自动命中');
  assert.match(rule, /width:\s*100%/, '控件撑满节点宽度，便于拖动进度');
  const audioRule = /\.mediaAudioPlayer\s*\{[\s\S]*?\}/.exec(css)?.[0] ?? '';
  assert.match(audioRule, /pointer-events:\s*auto/, '.mediaAudioPlayer 必须恢复自动命中（CR-20261121-56）');
});

void test('内容寻址文件名保留在固定页脚，不再覆盖缩略图', () => {
  const { world, layer } = createLayer();
  layer.setNodes(
    [
      {
        id: 'm',
        label: 'dd43e088.png',
        x: 0,
        y: 0,
        media: { kind: 'image', path: 'media/image/ab/dd43e088.png' },
      },
    ],
    createViewportTransform(),
  );
  assert.equal(
    world.children[0]?.children[0]?.children[2]?.children[0]?.textContent,
    'dd43e088.png',
  );
});

void test('媒体库文档节点复用文章式顶部、内表面与固定页脚', () => {
  const { world, layer } = createLayer();
  layer.setNodes(
    [
      {
        id: 'd',
        label: '参考.pdf',
        x: 0,
        y: 0,
        media: { kind: 'doc', path: 'media/doc/ab/reference.pdf' },
      },
    ],
    createViewportTransform(),
  );
  const item = world.children[0]?.children[0];
  assert.equal(item?.dataset.mediaKind, 'doc');
  assert.equal(item?.children[0]?.children[0]?.textContent, 'EMBER / 文档');
  assert.equal(item?.children[0]?.children[1]?.textContent, '只读');
  assert.equal(item?.children[1]?.className, 'media-surface');
  assert.equal(item?.children[1]?.children[0]?.className, 'media-document');
  assert.equal(item?.children[1]?.children[0]?.textContent, '双击预览文档');
  assert.equal(item?.children[2]?.children[0]?.textContent, '参考.pdf');
});
