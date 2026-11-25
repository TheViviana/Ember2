import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CANVAS_VIEW = 'src/app/canvas/CanvasView.tsx';

export interface FileLimit {
  target: number;
  frozenMax: number;
}

export type SourceLimits = Record<string, FileLimit>;

export interface KnownViolations {
  canvas_view_vault_write: number;
  editor_features_imports: number;
}

function readJson<T>(root: string, path: string): T {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as T;
}

function countLines(source: string): number {
  if (source.length === 0) return 0;
  return source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
}

function countMatches(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

/** 递归列出某目录下的 .ts/.tsx（相对 root 的路径），目录不存在返回空。 */
function walkSourceFiles(root: string, dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(join(root, dir));
  } catch {
    return out;
  }
  for (const name of entries) {
    const rel = join(dir, name);
    if (statSync(join(root, rel)).isDirectory()) {
      out.push(...walkSourceFiles(root, rel));
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(rel);
    }
  }
  return out;
}

export function assertSourceShape(
  root: string,
  limits: SourceLimits = readJson<SourceLimits>(root, 'tests/architecture/limits.json'),
  knownViolations: KnownViolations = readJson<KnownViolations>(
    root,
    'tests/architecture/known-violations.json',
  ),
): void {
  for (const [path, limit] of Object.entries(limits)) {
    assert.ok(
      limit.target <= limit.frozenMax,
      `${path}: target ${limit.target} 不能大于 frozenMax ${limit.frozenMax}`,
    );
    const actual = countLines(readFileSync(join(root, path), 'utf8'));
    assert.ok(
      actual <= limit.target,
      `${path}: 实际 ${actual} 行，超过 target ${limit.target} 行`,
    );
  }

  const canvasView = readFileSync(join(root, CANVAS_VIEW), 'utf8');
  const vaultWrites = countMatches(
    canvasView,
    /\bipcClient\.invoke\(\s*(['"])vault_write\1/g,
  );
  assert.equal(
    vaultWrites,
    knownViolations.canvas_view_vault_write,
    `CanvasView vault_write 实际 ${vaultWrites} 次，声明 ${knownViolations.canvas_view_vault_write} 次`,
  );

  // 扫描整个 editor 层：任何 editor 文件都不得反向 import features（只减不增，当前预算 0）。
  let featureImports = 0;
  for (const file of walkSourceFiles(root, 'src/editor')) {
    featureImports += countMatches(
      readFileSync(join(root, file), 'utf8'),
      /\bfrom\s+(['"])(?:\.\.\/)+features\//g,
    );
  }
  assert.equal(
    featureImports,
    knownViolations.editor_features_imports,
    `editor features imports 实际 ${featureImports} 次，声明 ${knownViolations.editor_features_imports} 次`,
  );
}
