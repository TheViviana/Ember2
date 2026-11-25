/**
 * C0-B B4：app 侧 I9 适配层。
 *
 * - `format.ts` 只做 v2 信封解析/序列化，不复制完整 schema；
 * - 本模块把原始文档交给 `#canvas-format` 的唯一规则源（inspect / validate / mutate）；
 * - inspection 产出 issues 与只读投影；任一 issue 按 R8=A 整幅只读；
 * - mutate 只接受已通过 inspection 的文档，原子失败与 inverse 由 package 保证。
 *
 * 本模块无 IO、无 React/DOM，可在 node 下直接测试。
 */
import {
  inspect,
  mutate,
  validate,
  type CanvasCommand,
  type CanvasInspection,
  type CanvasMutateResult,
  type CanvasSchemaIssue,
  type CanvasValidation,
} from '#canvas-format';
import type { CanvasDocument } from './format.ts';

export interface CanvasSchemaState {
  readonly issues: readonly CanvasSchemaIssue[];
  readonly projection: CanvasInspection['projection'];
  /** R8=A：任一 schema issue 即整幅禁止 mutate/save。 */
  readonly readOnly: boolean;
}

/** 唯一规则入口：issues、渲染投影与写锁状态同源。 */
export function inspectCanvasDocument(document: CanvasDocument): CanvasSchemaState {
  const inspection = inspect(document);
  return {
    issues: inspection.issues,
    projection: inspection.projection,
    readOnly: inspection.issues.length > 0,
  };
}

/** 薄包装同一 inspection；不另写规则。 */
export function validateCanvasDocument(document: CanvasDocument): CanvasValidation {
  return validate(document);
}

/** 统一命令入口；调用方必须已确认文档无非致命 issues。 */
export function applyCanvasCommands(
  document: CanvasDocument,
  commands: readonly CanvasCommand[],
): CanvasMutateResult {
  return mutate(document, commands);
}
