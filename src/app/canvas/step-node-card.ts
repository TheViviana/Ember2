/** 分块 / 汇总节点卡片：模型、说明、模式与块大小内联切换、运行钮。 */
import { splitPreviewLabel, type SplitPreview } from './split-preview.ts';
import type { StepProgressView } from './canvas-transient-store.ts';

export type { StepProgressView };

export interface StepNodeCardClassNames {
  readonly root: string;
  readonly header: string;
  readonly title: string;
  readonly model: string;
  readonly body: string;
  readonly meta: string;
  readonly chip: string;
  readonly preview: string;
  readonly footer: string;
  readonly status: string;
  readonly run: string;
}

/** 分块运行态进度类型由瞬态存储统一持有并在此透出。 */
export interface StepNodeCardView {
  readonly id: string;
  readonly splitMode?: 'split' | 'refine';
  readonly chunkChars?: number;
  readonly aiModel?: string;
  /** merge 节点：上游输入数量（按连线顺序）。 */
  readonly mergeInputCount?: number;
  /** merge 节点：输出目标是否为 document（决定常驻撤销提示）。 */
  readonly mergeOutputIsDocument?: boolean;
  /** split 节点：运行前块数预览（count/pending/too-long）；null 隐藏。 */
  readonly splitPreview?: SplitPreview | null;
  /** split 节点：运行中 k/N 进度；非运行态忽略。 */
  readonly splitProgress?: StepProgressView | null;
}

export interface StepNodeCard {
  readonly root: HTMLElement;
  readonly kind: 'split' | 'merge';
  update(node: StepNodeCardView, running: boolean): void;
  setRunning(running: boolean): void;
}

export interface StepConfigPatch {
  readonly mode?: 'split' | 'refine';
  readonly chunkChars?: number | null;
}

interface StepNodeCardOptions {
  readonly id: string;
  readonly kind: 'split' | 'merge';
  readonly classNames: StepNodeCardClassNames;
  readonly createElement: (tag: 'div' | 'span' | 'button') => HTMLElement;
  readonly onRun: (id: string) => void;
  /** 运行中再次点击圆钮 → 取消当前执行。 */
  readonly onCancel: () => void;
  readonly onUpdateConfig: (id: string, patch: StepConfigPatch) => void;
  readonly onOpenModel: (id: string) => void;
  /** 块大小循环的下一档；缺省按自动。 */
  readonly nextChunkChars: (current: number | undefined) => number | undefined;
}

export function createStepNodeCard(options: StepNodeCardOptions): StepNodeCard {
  const { classNames: classes, createElement, kind } = options;
  const root = createElement('div');
  root.className = classes.root;

  const header = createElement('div');
  header.className = classes.header;
  const title = createElement('div');
  title.className = classes.title;
  title.textContent = kind === 'split' ? '分块' : '汇总';
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
  run.title = '运行';
  header.append(title, model, run);

  const body = createElement('div');
  body.className = classes.body;
  const meta = createElement('div');
  meta.className = classes.meta;
  body.append(meta);

  let modeChip: HTMLElement | null = null;
  let chunkChip: HTMLElement | null = null;
  let preview: HTMLElement | null = null;
  let hint: HTMLElement | null = null;
  let currentMode: 'split' | 'refine' = 'split';
  let currentChunk: number | undefined;
  let currentPreview: SplitPreview | null = null;
  let currentProgress: StepProgressView | null = null;
  let isRunning = false;

  if (kind === 'merge') {
    hint = createElement('div');
    hint.dataset.mergeHint = 'true';
    body.append(hint);
  }

  if (kind === 'split') {
    modeChip = createElement('button');
    modeChip.className = classes.chip;
    modeChip.setAttribute('type', 'button');
    modeChip.setAttribute('data-node-control', 'true');
    if (typeof modeChip.addEventListener === 'function') {
      modeChip.addEventListener('click', (event) => {
        event.stopPropagation();
        options.onUpdateConfig(options.id, {
          mode: currentMode === 'refine' ? 'split' : 'refine',
        });
      });
      modeChip.addEventListener('dblclick', (event) => event.stopPropagation());
    }
    chunkChip = createElement('button');
    chunkChip.className = classes.chip;
    chunkChip.setAttribute('type', 'button');
    chunkChip.setAttribute('data-node-control', 'true');
    if (typeof chunkChip.addEventListener === 'function') {
      chunkChip.addEventListener('click', (event) => {
        event.stopPropagation();
        options.onUpdateConfig(options.id, {
          chunkChars: options.nextChunkChars(currentChunk) ?? null,
        });
      });
      chunkChip.addEventListener('dblclick', (event) => event.stopPropagation());
    }
    body.append(modeChip, chunkChip);
    preview = createElement('div');
    preview.className = classes.preview;
    preview.dataset.empty = 'true';
    body.append(preview);
  }

  const footer = createElement('div');
  footer.className = classes.footer;
  const status = createElement('span');
  status.className = classes.status;
  status.dataset.empty = 'true';
  footer.append(status);

  if (typeof run.addEventListener === 'function') {
    run.addEventListener('click', (event) => {
      event.stopPropagation();
      if (isRunning) {
        options.onCancel();
        return;
      }
      options.onRun(options.id);
    });
    run.addEventListener('dblclick', (event) => event.stopPropagation());
  }

  if (typeof model.addEventListener === 'function') {
    model.addEventListener('click', (event) => {
      event.stopPropagation();
      options.onOpenModel(options.id);
    });
    model.addEventListener('dblclick', (event) => event.stopPropagation());
    model.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      options.onOpenModel(options.id);
    });
  }

  root.append(header, body, footer);

  const applyRunning = (value: boolean): void => {
    isRunning = value;
    run.dataset.running = value ? 'true' : 'false';
    const label = `${value ? '停止' : '运行'}${kind === 'split' ? '分块' : '汇总'}`;
    run.setAttribute('aria-label', label);
    run.title = value ? '停止' : '运行';
  };

  /** 运行中 k/N 落在 footer 状态区；非运行态清空。 */
  const renderStatus = (running: boolean): void => {
    const text =
      running && currentProgress !== null && currentProgress.total > 0
        ? `${currentProgress.done}/${currentProgress.total}`
        : '';
    if (status.textContent !== text) status.textContent = text;
    status.dataset.empty = text === '' ? 'true' : 'false';
  };

  /** body 始终显示块数预览；运行中 k/N 另落 footer 状态区。 */
  const renderPreview = (): void => {
    if (preview === null) return;
    const text = splitPreviewLabel(currentPreview);
    if (preview.textContent !== text) preview.textContent = text;
    preview.dataset.kind = currentPreview?.kind ?? '';
    preview.dataset.empty = text === '' ? 'true' : 'false';
  };

  return {
    root,
    kind,
    update(node: StepNodeCardView, running: boolean): void {
      const mode = node.splitMode === 'refine' ? 'refine' : 'split';
      currentMode = mode;
      currentChunk = node.chunkChars;
      const modelText = node.aiModel ?? '未选择模型';
      if (model.textContent !== modelText) model.textContent = modelText;
      model.title =
        node.aiModel === undefined ? '单击选择模型' : `模型：${node.aiModel}（单击切换）`;
      const metaText =
        kind === 'split'
          ? mode === 'refine'
            ? '逐块提炼后写回'
            : '把文章切成可处理的小块'
          : (node.mergeInputCount ?? 0) > 0
            ? `上游 ${node.mergeInputCount} 段 · 按连线顺序 1…${node.mergeInputCount}`
            : '尚无上游文本';
      if (meta.textContent !== metaText) meta.textContent = metaText;
      if (modeChip !== null) {
        const label = mode === 'refine' ? '提炼' : '切分';
        if (modeChip.textContent !== label) modeChip.textContent = label;
        if (mode === 'refine') modeChip.dataset.active = 'true';
        else delete modeChip.dataset.active;
      }
      if (chunkChip !== null) {
        const chunkText =
          node.chunkChars === undefined ? '自动块大小' : `${node.chunkChars} 字/块`;
        if (chunkChip.textContent !== chunkText) chunkChip.textContent = chunkText;
      }
      if (preview !== null) {
        currentPreview = node.splitPreview ?? null;
        currentProgress = node.splitProgress ?? null;
        renderPreview();
        renderStatus(running);
      }
      if (hint !== null) {
        const hintText = node.mergeOutputIsDocument === true ? '文档写入不进入画布撤销' : '';
        if (hint.textContent !== hintText) hint.textContent = hintText;
      }
      applyRunning(running);
    },
    setRunning(running: boolean): void {
      applyRunning(running);
      renderPreview();
      renderStatus(running);
    },
  };
}