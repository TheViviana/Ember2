import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { StrictMode, act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createServer, type ViteDevServer } from 'vite';
import type { ToolControllers } from '../../../src/app/shell/use-tool-controllers.ts';

class FakeNode {
  readonly childNodes: FakeNode[] = [];
  readonly ownerDocument: FakeDocument | null;
  readonly nodeType: number;
  readonly nodeName: string;
  parentNode: FakeNode | null = null;
  nodeValue: string | null = null;

  constructor(nodeType: number, nodeName: string, ownerDocument: FakeDocument | null) {
    this.nodeType = nodeType;
    this.nodeName = nodeName;
    this.ownerDocument = ownerDocument;
  }

  appendChild<T extends FakeNode>(child: T): T {
    return this.insertBefore(child, null);
  }

  insertBefore<T extends FakeNode>(child: T, before: FakeNode | null): T {
    if (child.parentNode !== null) child.parentNode.removeChild(child);
    const index = before === null ? this.childNodes.length : this.childNodes.indexOf(before);
    assert.ok(index >= 0);
    this.childNodes.splice(index, 0, child);
    child.parentNode = this;
    return child;
  }

  removeChild<T extends FakeNode>(child: T): T {
    const index = this.childNodes.indexOf(child);
    assert.ok(index >= 0);
    this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  addEventListener(): void {}
  removeEventListener(): void {}

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.nodeValue ?? '';
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    if (this.nodeType === 3) {
      this.nodeValue = value;
      return;
    }
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes.length = 0;
    if (value !== '' && this.ownerDocument !== null) {
      this.appendChild(this.ownerDocument.createTextNode(value));
    }
  }
}

class FakeElement extends FakeNode {
  readonly tagName: string;
  readonly namespaceURI = 'http://www.w3.org/1999/xhtml';
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, unknown> = {};
  className = '';

  constructor(tagName: string, ownerDocument: FakeDocument) {
    super(1, tagName.toUpperCase(), ownerDocument);
    this.tagName = tagName.toUpperCase();
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
    if (name === 'class') this.className = String(value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeDocument extends FakeNode {
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  defaultView: unknown = null;

  constructor() {
    super(9, '#document', null);
    this.documentElement = new FakeElement('html', this);
    this.body = new FakeElement('body', this);
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(tagName, this);
  }

  createTextNode(value: string): FakeNode {
    const node = new FakeNode(3, '#text', this);
    node.nodeValue = value;
    return node;
  }
}

void test('useToolControllers 在 StrictMode 双挂载后仍可用，真实卸载后才释放', async () => {
  const rootPath = fileURLToPath(new URL('../../..', import.meta.url));
  let vite: ViteDevServer | null = null;
  let root: Root | null = null;
  const document = new FakeDocument();
  const window = {
    document,
    HTMLIFrameElement: class {},
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  document.defaultView = window;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: window });
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });

  const seen: ToolControllers[] = [];
  try {
    vite = await createServer({
      root: rootPath,
      configFile: false,
      appType: 'custom',
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true },
    });
    const module = await vite.ssrLoadModule('/src/app/shell/use-tool-controllers.ts') as {
      useToolControllers: () => ToolControllers;
    };
    const Probe = () => {
      seen.push(module.useToolControllers());
      return null;
    };
    const container = document.createElement('div');
    root = createRoot(container as unknown as HTMLElement);
    await act(async () => {
      root?.render(createElement(StrictMode, null, createElement(Probe)));
      await Promise.resolve();
    });

    assert.ok(seen.length > 0);
    const controllers = seen[0];
    assert.ok(controllers !== undefined);
    assert.ok(seen.every((item) => item === controllers));

    controllers.pomodoro.start();
    assert.equal(
      controllers.pomodoro.getSnapshot().status,
      'running',
      'StrictMode 模拟卸载不得销毁仍被复用的控制器',
    );

    // 第二次 setup 应取消待执行的销毁：等待一个宏任务后控制器仍可用。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assert.equal(controllers.pomodoro.getSnapshot().status, 'running');

    act(() => {
      root?.unmount();
      root = null;
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    controllers.pomodoro.reset();
    assert.equal(
      controllers.pomodoro.getSnapshot().status,
      'running',
      '真实卸载后应已 dispose，reset 不得再改变状态',
    );
  } finally {
    if (root !== null) {
      act(() => {
        root?.unmount();
      });
    }
    await vite?.close();
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});
