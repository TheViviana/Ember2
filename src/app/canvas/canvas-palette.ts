/* CR-20261121-44：Canvas 2D 无法直接消费 CSS 变量，这里用探针元素把令牌解析成具体色值。
 * light-dark() 在探针上按其 color-scheme（继承自 :root）解析；主题切换（data-theme 变更、
 * 系统外观、增强对比）时失效缓存，下次取色重解析。监听为应用生命周期单例，无需 dispose。
 * 非浏览器环境（node 单测）返回冻结兜底值，保证纯逻辑测试可导入本模块的消费者。
 * 状态用 const 容器持有（I11/D12：模块顶层禁 let/var 绑定）。 */

export interface ThemeColors {
  readonly canvasBg: string;
  /** 点阵单色（Cinematic Ember §3.9：不再区分主/次线）。 */
  readonly gridDot: string;
  readonly edge: string;
  readonly edgeSelected: string;
  readonly edgeArrow: string;
  /** 语义连线色：跟随主题令牌，切主题自动生效。 */
  readonly edgePrimary: string;
  readonly edgeSuccess: string;
  readonly edgeWarning: string;
  readonly edgeDanger: string;
  /** 2026-11-24：连线柔光（同路径宽描边，替代逐边 filter）。 */
  readonly edgeGlow: string;
  readonly edgePulse: string;
  readonly edgePulseGlow: string;
  /** 连线标签文字与底色。 */
  readonly labelText: string;
  readonly labelBg: string;
}

/* 兜底调色板 = 深色档字面量（仅 node 测试环境使用；浏览器恒走令牌解析）。 */
const FALLBACK: ThemeColors = Object.freeze({
  canvasBg: '#1a1a1c',
  gridDot: 'rgba(255, 255, 255, 0.06)',
  edge: '#55555b',
  edgeSelected: '#e0e0e2',
  edgeArrow: '#55555b',
  edgePrimary: '#f5a623',
  edgeSuccess: '#3fb950',
  edgeWarning: '#d29922',
  edgeDanger: '#f85149',
  edgeGlow: 'rgba(255, 255, 255, 0.05)',
  edgePulse: 'rgba(255, 211, 164, 0.96)',
  edgePulseGlow: 'rgba(251, 146, 60, 0.28)',
  labelText: '#e0e0e2',
  labelBg: '#26262a',
});

const state: {
  colors: ThemeColors | null;
  listeners: boolean;
  subscribers: Set<() => void>;
} = {
  colors: null,
  listeners: false,
  subscribers: new Set(),
};

function probe(token: string): string {
  const el = document.createElement('span');
  el.style.display = 'none';
  el.style.color = `var(${token})`;
  document.documentElement.appendChild(el);
  const resolved = getComputedStyle(el).color;
  el.remove();
  return resolved;
}

function invalidate(): void {
  const hadCache = state.colors !== null;
  state.colors = null;
  // 仅当已有订阅者且缓存曾命中时通知，避免无绘制时重复派发。
  if (hadCache) {
    for (const listener of state.subscribers) listener();
  }
}

/** 主题令牌失效通知：Canvas 2D 需要据此重绘已缓存的网格背景。 */
export function onThemeColorsChange(listener: () => void): () => void {
  state.subscribers.add(listener);
  return () => {
    state.subscribers.delete(listener);
  };
}

function ensureListeners(): void {
  if (state.listeners) return;
  state.listeners = true;
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', invalidate);
  window.matchMedia('(prefers-contrast: more)').addEventListener('change', invalidate);
  new MutationObserver(invalidate).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
}

/** 画布取色入口：每次绘制调用（缓存命中为 O(1)），主题切换后自动失效。 */
export function themeColors(): ThemeColors {
  if (typeof document === 'undefined') return FALLBACK;
  ensureListeners();
  if (state.colors === null) {
    state.colors = Object.freeze({
      canvasBg: probe('--ember-canvas-bg'),
      gridDot: probe('--ember-canvas-grid'),
      edge: probe('--ember-edge'),
      edgeSelected: probe('--ember-edge-active'),
      edgeArrow: probe('--ember-edge'),
      edgePrimary: probe('--ember-primary'),
      edgeSuccess: probe('--ember-success'),
      edgeWarning: probe('--ember-warning'),
      edgeDanger: probe('--ember-danger'),
      edgeGlow: probe('--ember-edge-glow'),
      edgePulse: probe('--ember-edge-pulse'),
      edgePulseGlow: probe('--ember-edge-pulse-glow'),
      labelText: probe('--ember-text-primary'),
      labelBg: probe('--ember-bg-elevated'),
    });
  }
  return state.colors;
}
