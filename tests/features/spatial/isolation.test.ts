/**
 * 空间工作区隔离：主应用源码不得静态引用 3D 运行时，场景必须走动态 import。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const SRC = fileURLToPath(new URL('../../../src/', import.meta.url));
const SPATIAL_DIR = join(SRC, 'features', 'spatial');

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      files.push(path);
    }
  }
  return files;
}

const STATIC_3D_IMPORT = /(?:from\s*|import\s*)['"](three|@react-three\/[^'"]+)['"]/;

void test('空间模块之外没有静态引用 three / @react-three', () => {
  const offenders = sourceFiles(SRC)
    .filter((file) => !file.startsWith(`${SPATIAL_DIR}${sep}`))
    .filter((file) => STATIC_3D_IMPORT.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, []);
});

void test('入口宿主通过动态 import 加载场景', () => {
  const host = readFileSync(join(SPATIAL_DIR, 'SpatialWorkspaceHost.tsx'), 'utf8');
  assert.match(host, /import\('\.\/SpatialScene\.tsx'\)/);
  assert.equal(STATIC_3D_IMPORT.test(host), false);
});