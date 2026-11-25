import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAiNodeCard } from '../../../src/app/canvas/ai-node-card.ts';

interface FakeEventInit {
  readonly key?: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly isComposing?: boolean;
}

interface FakeElement {
  readonly tag: string;
  className: string;
  textContent: string;
  value: string;
  placeholder: string;
  title: string;
  disabled: boolean;
  spellcheck: boolean;
  readonly dataset: Record<string, string>;
  readonly attributes: Record<string, string>;
  readonly children: FakeElement[];
  readonly listeners: Map<string, ((event: Event) => void)[]>;
  readonly classList: { add(name: string): void };
  append(...children: FakeElement[]): void;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
}

function fakeElement(tag: string): FakeElement {
  const listeners = new Map<string, ((event: Event) => void)[]>();
  return {
    tag,
    className: '',
    textContent: '',
    value: '',
    placeholder: '',
    title: '',
    disabled: false,
    spellcheck: true,
    dataset: {},
    attributes: {},
    children: [],
    listeners,
    classList: { add: () => undefined },
    append(...children): void { this.children.push(...children); },
    setAttribute(name, value): void {
      this.attributes[name] = value;
      if (name === 'disabled') this.disabled = true;
    },
    addEventListener(type, listener): void {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
  };
}

function descendants(root: FakeElement): FakeElement[] {
  return root.children.flatMap((child) => [child, ...descendants(child)]);
}

function fire(element: FakeElement, type: string, init: FakeEventInit = {}): void {
  const event = {
    ...init,
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  } as unknown as Event;
  for (const listener of element.listeners.get(type) ?? []) listener(event);
}

const classNames = {
  root: 'root', header: 'header', title: 'title', model: 'model', prompt: 'prompt',
  footer: 'footer', actions: 'actions', chip: 'chip', run: 'run', runner: 'runner',
  runnerGlow: 'runner-glow', runnerCore: 'runner-core',
} as const;

function fixture(overrides: {
  readonly text?: string;
  readonly onCommit?: (id: string, text: string) => boolean;
  readonly onRun?: (id: string) => void;
  readonly onOpenModel?: (id: string) => void;
} = {}) {
  const rootElements: FakeElement[] = [];
  const card = createAiNodeCard({
    id: 'ai1',
    text: overrides.text ?? '已保存',
    model: 'qwen3:8b',
    classNames,
    createElement: (tag) => {
      const element = fakeElement(tag);
      rootElements.push(element);
      return element as unknown as HTMLElement;
    },
    createSvgElement: (tag) => fakeElement(tag) as unknown as SVGElement,
    onCommit: overrides.onCommit ?? (() => true),
    onRun: overrides.onRun ?? (() => undefined),
    onOpenModel: overrides.onOpenModel,
  });
  const root = card.root as unknown as FakeElement;
  const all = descendants(root);
  const textarea = all.find((element) => element.tag === 'textarea');
  const run = all.find((element) => element.tag === 'button' && element.textContent === 'Generate');
  assert.ok(textarea !== undefined && run !== undefined);
  return { card, root, all, textarea, run, rootElements };
}

void test('2026-11-24：单击右上角模型字段直接打开模型选择（无需双击节点）', () => {
  const calls: string[] = [];
  const { all } = fixture({ onOpenModel: (id) => { calls.push(id); } });
  const model = all.find((element) => element.className === 'model');
  assert.ok(model !== undefined);
  assert.equal(model.attributes['data-node-control'], 'true', '派发到 engine 前必须让出按压，否则 click 被拖拽手势吞掉');
  assert.equal(model.attributes.role, 'button');
  fire(model, 'click');
  fire(model, 'keydown', { key: 'Enter' });
  assert.deepEqual(calls, ['ai1', 'ai1'], '单击与回车都应打开模型选择');
});

void test('AI 卡片保留四个禁用预留位、执行钮和左中点向下的逆时针路径', () => {
  const { all } = fixture();
  const chips = all.filter((element) => element.tag === 'button' && element.attributes.title?.includes('待上线'));
  assert.deepEqual(chips.map((chip) => chip.textContent), ['简化', '分割', '要点', '总结']);
  assert.ok(chips.every((chip) => chip.disabled));
  const svg = all.find((element) => element.tag === 'svg');
  assert.ok(svg !== undefined);
  assert.equal(svg.attributes['aria-hidden'], 'true');
  const paths = svg.children;
  assert.equal(paths.length, 2);
  assert.match(paths[0]?.attributes.d ?? '', /^M1 95V177.*H13Q1 1 1 13V95Z$/);
  assert.equal(paths[0]?.attributes.pathLength, '100');
});

void test('input 只改草稿，blur 规范化换行并提交一次；外部更新刷新非聚焦值', () => {
  const commits: [string, string][] = [];
  const { card, textarea } = fixture({ onCommit: (id, text) => { commits.push([id, text]); return true; } });
  fire(textarea, 'focus');
  textarea.value = '第一行\r\n第二行';
  fire(textarea, 'input');
  assert.deepEqual(commits, []);
  card.setText('外部撤销值');
  assert.equal(textarea.value, '第一行\r\n第二行', '聚焦时不覆盖草稿');
  fire(textarea, 'blur');
  assert.deepEqual(commits, [['ai1', '第一行\n第二行']]);
  card.setText('外部撤销值');
  assert.equal(textarea.value, '外部撤销值');
});

void test('Generate 先提交最新草稿再执行，运行中防止重复启动', () => {
  const calls: string[] = [];
  const { card, textarea, run } = fixture({
    onCommit: (_id, text) => { calls.push(`commit:${text}`); return true; },
    onRun: (id) => { calls.push(`run:${id}`); },
  });
  textarea.value = '最新提示词';
  fire(textarea, 'input');
  fire(run, 'click');
  assert.deepEqual(calls, ['commit:最新提示词', 'run:ai1']);
  card.setRunning(true);
  assert.equal(run.disabled, true);
  assert.equal(run.textContent, 'Running…');
  fire(run, 'click');
  assert.equal(calls.length, 2);
  card.setRunning(false);
  assert.equal(run.textContent, 'Generate');
});

void test('Escape 恢复已保存值，Cmd/Ctrl+Enter 提交，IME 快捷键不抢先提交', () => {
  const commits: string[] = [];
  const { textarea } = fixture({ onCommit: (_id, text) => { commits.push(text); return true; } });
  textarea.value = '未完成草稿';
  fire(textarea, 'input');
  fire(textarea, 'keydown', { key: 'Escape' });
  assert.equal(textarea.value, '已保存');
  assert.deepEqual(commits, []);

  textarea.value = '快捷键提交';
  fire(textarea, 'input');
  fire(textarea, 'keydown', { key: 'Enter', ctrlKey: true });
  assert.deepEqual(commits, ['快捷键提交']);
  textarea.value = '输入法草稿';
  fire(textarea, 'input');
  fire(textarea, 'keydown', { key: 'Enter', metaKey: true, isComposing: true });
  assert.deepEqual(commits, ['快捷键提交']);
  fire(textarea, 'blur');
  assert.deepEqual(commits, ['快捷键提交', '输入法草稿']);
});

void test('只读提交失败时不执行 AI', () => {
  let runs = 0;
  const { textarea, run } = fixture({ onCommit: () => false, onRun: () => { runs += 1; } });
  textarea.value = '不能保存';
  fire(textarea, 'input');
  fire(run, 'click');
  assert.equal(runs, 0);
});
