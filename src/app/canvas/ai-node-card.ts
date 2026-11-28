/** AI 节点内联提示词卡片：草稿编辑、同步提交与周边运行流光。 */

export interface AiNodeCardClassNames {
  readonly root: string;
  readonly header: string;
  readonly title: string;
  readonly model: string;
  readonly prompt: string;
  readonly footer: string;
  readonly run: string;
  readonly runner: string;
  readonly runnerGlow: string;
  readonly runnerCore: string;
}

export interface AiNodeCard {
  readonly root: HTMLElement;
  setText(text: string): void;
  setModel(model: string | undefined): void;
  setRunning(running: boolean): void;
}

interface AiNodeCardOptions {
  readonly id: string;
  readonly text: string;
  readonly model?: string;
  readonly classNames: AiNodeCardClassNames;
  readonly createElement: (tag: 'div' | 'span' | 'textarea' | 'button') => HTMLElement;
  readonly createSvgElement?: (tag: 'svg' | 'path') => SVGElement;
  readonly onCommit: (id: string, text: string) => boolean;
  readonly onRun: (id: string) => void;
  /** 运行中再次点击圆钮 → 取消当前执行。 */
  readonly onCancel: () => void;
  /** 2026-11-24：单击右上角模型直接打开模型选择，不再要求双击节点。 */
  readonly onOpenModel?: (id: string) => void;
}

const RUNNER_PATH =
  'M1 95V177Q1 189 13 189H407Q419 189 419 177V13Q419 1 407 1H13Q1 1 1 13V95Z';

export function createAiNodeCard(options: AiNodeCardOptions): AiNodeCard {
  const { classNames: classes, createElement } = options;
  const createSvg = options.createSvgElement ?? ((tag: 'svg' | 'path'): SVGElement => {
    if (typeof document === 'undefined') throw new Error('SVG unavailable');
    return document.createElementNS('http://www.w3.org/2000/svg', tag);
  });
  const root = createElement('div');
  root.className = classes.root;
  const header = createElement('div');
  header.className = classes.header;
  const title = createElement('span');
  title.className = classes.title;
  title.textContent = 'AI 步骤';
  const model = createElement('span');
  model.className = classes.model;
  model.dataset.aiModel = 'true';
  // engine.onPointerDown 见到此标记即把按压让给控件，否则拖拽手势吞掉 click。
  model.setAttribute('data-node-control', 'true');
  model.setAttribute('role', 'button');
  const run = createElement('button') as HTMLButtonElement;
  run.className = classes.run;
  run.setAttribute('type', 'button');
  run.setAttribute('data-node-control', 'true');
  run.setAttribute('aria-label', '运行 AI 节点');
  run.title = '运行';
  header.append(title, model, run);

  const textarea = createElement('textarea') as HTMLTextAreaElement;
  textarea.className = classes.prompt;
  textarea.value = options.text;
  textarea.placeholder = '输入提示词…';
  textarea.setAttribute('aria-label', 'AI 提示词');
  textarea.setAttribute('data-node-control', 'true');
  textarea.setAttribute('data-node-scroll', 'true');
  textarea.spellcheck = false;

  const footer = createElement('div');
  footer.className = classes.footer;

  let runner: SVGElement | null = null;
  try {
    runner = createSvg('svg');
    runner.setAttribute('viewBox', '0 0 420 190');
    runner.setAttribute('preserveAspectRatio', 'none');
    runner.setAttribute('aria-hidden', 'true');
    runner.classList.add(classes.runner);
    for (const className of [classes.runnerGlow, classes.runnerCore]) {
      const path = createSvg('path');
      path.setAttribute('d', RUNNER_PATH);
      path.setAttribute('pathLength', '100');
      path.classList.add(className);
      runner.append(path);
    }
  } catch {
    // 无 SVG 的测试替身仍保留完整编辑与执行功能。
  }
  root.append(header, textarea, footer);
  if (runner !== null) root.append(runner);

  let committed = options.text;
  let dirty = false;
  let focused = false;
  let running = false;
  const commit = (): boolean => {
    if (!dirty) return true;
    const next = textarea.value.replace(/\r\n?/g, '\n');
    if (next === committed) {
      dirty = false;
      return true;
    }
    if (!options.onCommit(options.id, next)) return false;
    committed = next;
    dirty = false;
    return true;
  };
  if (typeof textarea.addEventListener === 'function') {
    textarea.addEventListener('focus', () => { focused = true; });
    textarea.addEventListener('blur', () => {
      focused = false;
      commit();
    });
    textarea.addEventListener('input', () => { dirty = true; });
    textarea.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        textarea.value = committed;
        dirty = false;
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        commit();
      }
    });
    textarea.addEventListener('dblclick', (event) => event.stopPropagation());
    model.addEventListener('click', (event) => {
      event.stopPropagation();
      options.onOpenModel?.(options.id);
    });
    model.addEventListener('dblclick', (event) => event.stopPropagation());
    model.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      options.onOpenModel?.(options.id);
    });
    run.addEventListener('click', (event) => {
      event.stopPropagation();
      if (running) {
        options.onCancel();
        return;
      }
      if (commit()) options.onRun(options.id);
    });
    run.addEventListener('dblclick', (event) => event.stopPropagation());
  }
  const card: AiNodeCard = {
    root,
    setText(text): void {
      if (focused) return;
      committed = text;
      dirty = false;
      if (textarea.value !== text) textarea.value = text;
    },
    setModel(value): void {
      const display = value ?? '未选择模型';
      if (model.textContent !== display) model.textContent = display;
      model.title = value === undefined ? '单击选择模型' : `模型：${value}（单击切换）`;
    },
    setRunning(value): void {
      running = value;
      run.dataset.running = value ? 'true' : 'false';
      const label = value ? '停止 AI 运行' : '运行 AI 节点';
      run.setAttribute('aria-label', label);
      run.title = value ? '停止' : '运行';
    },
  };
  card.setModel(options.model);
  return card;
}
