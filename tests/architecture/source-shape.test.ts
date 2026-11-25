import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSourceShape,
  type KnownViolations,
  type SourceLimits,
} from './shape-lib.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const APP_SHELL = 'src/app/shell/AppShell.tsx';
const CANVAS_VIEW = 'src/app/canvas/CanvasView.tsx';
const EDITOR_VIEW = 'src/editor/EditorView.tsx';
const SOURCE_PATHS = [
  APP_SHELL,
  CANVAS_VIEW,
  'src/app/canvas/engine.ts',
  'src/app/panels/DocumentList.tsx',
  'src/app/panels/EditorWindow.tsx',
  EDITOR_VIEW,
];
const FIXTURE_LIMITS: SourceLimits = Object.fromEntries(
  SOURCE_PATHS.map((path) => [path, { target: 1, frozenMax: 1 }]),
);
const NO_VIOLATIONS: KnownViolations = {
  canvas_view_vault_write: 0,
  editor_features_imports: 0,
};

function withFixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'ember-source-shape-'));
  try {
    for (const path of SOURCE_PATHS) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), 'export const value = 1;\n');
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

void test('装配文件不超过 target，target 不超过 frozenMax，已知违规与声明一致', () => {
  assertSourceShape(ROOT);
});

void test('fixture：文件超出 target 一行即失败', () => {
  withFixture((root) => {
    writeFileSync(join(root, APP_SHELL), 'export const a = 1;\nexport const b = 2;\n');
    assert.throws(
      () => assertSourceShape(root, FIXTURE_LIMITS, NO_VIOLATIONS),
      /AppShell\.tsx: 实际 2 行，超过 target 1 行/,
    );
  });
});

void test('fixture：CanvasView vault_write 比声明多一次即失败', () => {
  withFixture((root) => {
    writeFileSync(join(root, CANVAS_VIEW), "ipcClient.invoke('vault_write', {});\n");
    assert.throws(
      () => assertSourceShape(root, FIXTURE_LIMITS, NO_VIOLATIONS),
      /CanvasView vault_write 实际 1 次，声明 0 次/,
    );
  });
});

void test('fixture：editor 层任一文件 features import 比声明多一条即失败', () => {
  withFixture((root) => {
    writeFileSync(join(root, EDITOR_VIEW), "import { x } from '../features/x.ts';\n");
    assert.throws(
      () => assertSourceShape(root, FIXTURE_LIMITS, NO_VIOLATIONS),
      /editor features imports 实际 1 次，声明 0 次/,
    );
  });
});
