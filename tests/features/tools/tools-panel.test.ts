import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { act, createElement, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createServer, type ViteDevServer } from 'vite';
import {
  createAudioEngine,
  type AudioEngineController,
} from '../../../src/features/tools/audio-engine.ts';
import {
  createPomodoroController,
  type PomodoroClock,
  type PomodoroController,
  type PomodoroScheduler,
} from '../../../src/features/tools/pomodoro.ts';

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
  value = '';
  defaultValue = '';
  checked = false;
  defaultChecked = false;
  type = '';
  name = '';

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

class PanelClock implements PomodoroClock {
  private timeMs = 0;
  now(): number { return this.timeMs; }
  advance(ms: number): void { this.timeMs += ms; }
}

class PanelScheduler implements PomodoroScheduler {
  private callback: (() => void) | null = null;
  setInterval(callback: () => void): unknown {
    this.callback = callback;
    return 1;
  }
  clearInterval(): void { this.callback = null; }
  tick(): void { this.callback?.(); }
}

class PanelAudioContext {
  state: AudioContextState = 'suspended';
  readonly sampleRate = 10;
  readonly destination = {};
  closeCalls = 0;

  createBuffer(_channels: number, length: number): { getChannelData(): Float32Array } {
    const samples = new Float32Array(length);
    return { getChannelData: () => samples };
  }

  createBufferSource(): unknown {
    return {
      buffer: null,
      loop: false,
      connect: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      disconnect: () => undefined,
    };
  }

  createGain(): unknown {
    return {
      gain: { value: 1 },
      connect: () => undefined,
      disconnect: () => undefined,
    };
  }

  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    this.state = 'closed';
    return Promise.resolve();
  }

  asNative(): AudioContext { return this as unknown as AudioContext; }
}

type PanelComponent = ComponentType<{
  readonly pomodoro: PomodoroController;
  readonly audio: AudioEngineController;
}>;

void test('ToolsPanel 卸载仅退订，不停止、不重置、不 dispose 外置控制器', async () => {
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

  const clock = new PanelClock();
  const scheduler = new PanelScheduler();
  const pomodoro = createPomodoroController({ clock, scheduler });
  const audioContext = new PanelAudioContext();
  const audio = createAudioEngine({ contextFactory: () => audioContext.asNative() });
  let pomodoroDisposeCalls = 0;
  let audioStopCalls = 0;
  let audioDisposeCalls = 0;
  let pomodoroSubscriptions = 0;
  let audioSubscriptions = 0;
  const observedPomodoro: PomodoroController = {
    ...pomodoro,
    subscribe: (subscriber) => {
      pomodoroSubscriptions += 1;
      const unsubscribe = pomodoro.subscribe(subscriber);
      return () => {
        pomodoroSubscriptions -= 1;
        unsubscribe();
      };
    },
    dispose: () => {
      pomodoroDisposeCalls += 1;
      pomodoro.dispose();
    },
  };
  const observedAudio: AudioEngineController = {
    ...audio,
    subscribe: (subscriber) => {
      audioSubscriptions += 1;
      const unsubscribe = audio.subscribe(subscriber);
      return () => {
        audioSubscriptions -= 1;
        unsubscribe();
      };
    },
    stop: () => {
      audioStopCalls += 1;
      return audio.stop();
    },
    dispose: () => {
      audioDisposeCalls += 1;
      return audio.dispose();
    },
  };

  try {
    pomodoro.start();
    await audio.start();
    vite = await createServer({
      root: rootPath,
      configFile: false,
      appType: 'custom',
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true },
    });
    const module = await vite.ssrLoadModule('/src/features/tools/ToolsPanel.tsx') as {
      ToolsPanel: PanelComponent;
    };
    const container = document.createElement('div');
    root = createRoot(container as unknown as HTMLElement);
    await act(async () => {
      root?.render(createElement(module.ToolsPanel, {
        pomodoro: observedPomodoro,
        audio: observedAudio,
      }));
      await Promise.resolve();
    });
    assert.match(container.textContent, /25:00/);
    assert.match(container.textContent, /播放中/);
    assert.equal(pomodoroSubscriptions, 1);
    assert.equal(audioSubscriptions, 1);

    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    root = null;
    assert.equal(pomodoroSubscriptions, 0);
    assert.equal(audioSubscriptions, 0);
    assert.equal(pomodoroDisposeCalls, 0);
    assert.equal(audioStopCalls, 0);
    assert.equal(audioDisposeCalls, 0);
    assert.equal(audioContext.closeCalls, 0);
    assert.equal(audio.getSnapshot().status, 'running');

    clock.advance(60_000);
    scheduler.tick();
    assert.equal(pomodoro.getSnapshot().remainingMs, 24 * 60_000);
    assert.equal(pomodoro.getSnapshot().status, 'running');
  } finally {
    if (root !== null) {
      await act(async () => {
        root?.unmount();
        await Promise.resolve();
      });
    }
    pomodoro.dispose();
    await audio.dispose();
    await vite?.close();
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
  }
});
