/**
 * 空间工作区能力检测（注入式，node 下可测）。
 *
 * M1 只读 WebGL2 是否可用与 UNMASKED_RENDERER 字符串，不引入 three，
 * 也不在检测阶段持有任何渲染资源。软件渲染只降级提示，不直接判死。
 */

export interface SpatialCapability {
  readonly webgl2: boolean;
  readonly renderer: string | null;
  readonly software: boolean;
}

/** 检测只需要这两个方法，便于测试注入，也避免把 DOM 类型带进纯逻辑。 */
export interface SpatialGlContext {
  getExtension(name: string): unknown;
  getParameter(parameter: number): unknown;
}

interface DebugRendererInfo {
  readonly UNMASKED_RENDERER_WEBGL: number;
}

export type Webgl2ContextFactory = () => SpatialGlContext | null;

const SOFTWARE_MARKERS = Object.freeze([
  'swiftshader',
  'llvmpipe',
  'softpipe',
  'software',
  'basic render',
  'microsoft basic',
  'apple software',
] as const);

const DEBUG_RENDERER_INFO = 'WEBGL_debug_renderer_info';

export function isSoftwareRenderer(renderer: string | null): boolean {
  if (renderer === null) return false;
  const normalized = renderer.toLowerCase();
  return SOFTWARE_MARKERS.some((marker) => normalized.includes(marker));
}

function isDebugRendererInfo(value: unknown): value is DebugRendererInfo {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly UNMASKED_RENDERER_WEBGL?: unknown };
  return typeof candidate.UNMASKED_RENDERER_WEBGL === 'number';
}

function readRenderer(context: SpatialGlContext): string | null {
  const extension = context.getExtension(DEBUG_RENDERER_INFO);
  if (!isDebugRendererInfo(extension)) return null;
  const renderer = context.getParameter(extension.UNMASKED_RENDERER_WEBGL);
  return typeof renderer === 'string' ? renderer : null;
}

/** 浏览器内默认探针；无 document（node 测试/非 DOM 环境）直接判不可用。 */
function createBrowserWebgl2Context(): SpatialGlContext | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  return canvas.getContext('webgl2');
}

export function detectSpatialCapability(
  createContext: Webgl2ContextFactory = createBrowserWebgl2Context,
): SpatialCapability {
  try {
    const context = createContext();
    if (context === null) {
      return { webgl2: false, renderer: null, software: false };
    }
    const renderer = readRenderer(context);
    return { webgl2: true, renderer, software: isSoftwareRenderer(renderer) };
  } catch {
    // 扩展或上下文读取在部分 WebView 会直接抛错，按不可用降级。
    return { webgl2: false, renderer: null, software: false };
  }
}