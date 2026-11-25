/**
 * 世界层挂载点解析（不依赖 CSS Modules / DOM 全局，可直接在 node 下测试）。
 *
 * Backlog ⑫：`engine.ts` 因导入 CSS Modules 无法做 node 测试，故把
 * `getWorldElement()` 的转发逻辑抽到本模块；engine 只保留一行转发，
 * 「viewport 内唯一挂载点」由 C2 浏览器测试兜底。
 */

export interface WorldElementSource {
  getWorldElement(): HTMLElement;
}

/** 返回来源的唯一挂载点；来源在 world-layer 构造时已创建。 */
export function resolveWorldElement(source: WorldElementSource): HTMLElement {
  return source.getWorldElement();
}
