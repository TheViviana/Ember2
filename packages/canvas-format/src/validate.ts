import { inspect } from './document.ts';
import type { CanvasDocument, CanvasValidation } from './types.ts';

/** 布尔门禁只是 inspection 的包装，不维护第二套 schema 规则。 */
export function validate(document: CanvasDocument): CanvasValidation {
  const { issues } = inspect(document);
  return { valid: issues.length === 0, issues };
}
