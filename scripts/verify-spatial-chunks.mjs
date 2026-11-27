#!/usr/bin/env node
/* 校验空间工作区分包与隔离（依赖 pnpm build 生成的 dist/.vite/manifest.json）。
 *
 * M1 规则（未安装 three，因此不校验 spatial-vendor）：
 * 1) 入口 chunk 的静态 imports 不含 spatial 模块与任何 3D 依赖；
 * 2) 入口 dynamicImports 含空间工作区模块；
 * 3) dist 中存在空间工作区异步 chunk，且文件已落盘。
 *
 * 用法：pnpm build && node scripts/verify-spatial-chunks.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const manifestPath = join(root, 'dist', '.vite', 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('未找到 dist/.vite/manifest.json：请先运行 pnpm build');
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entries = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry === true);
if (entries.length === 0) {
  console.error('manifest 中没有入口 chunk');
  process.exit(1);
}

const failures = [];
const bannedStatic = /spatial|three|react-three/i;

for (const [key, entry] of entries) {
  for (const imported of entry.imports ?? []) {
    if (bannedStatic.test(imported)) {
      failures.push(`${key} 静态依赖了 3D/空间模块：${imported}`);
    }
  }
}

const dynamicKeys = new Set(entries.flatMap(([, entry]) => entry.dynamicImports ?? []));
const hasDynamicSpatial = [...dynamicKeys].some((key) => /spatial/i.test(key));
if (!hasDynamicSpatial) {
  failures.push('入口 dynamicImports 未包含空间工作区模块');
}

const spatialEntries = Object.entries(manifest).filter(
  ([key, chunk]) => chunk.isDynamicEntry === true && /spatial/i.test(key),
);
if (spatialEntries.length === 0) {
  failures.push('dist 中没有空间工作区异步 chunk（应存在 SpatialScene 动态入口）');
}
for (const [key, chunk] of spatialEntries) {
  if (!dynamicKeys.has(key)) {
    failures.push(`空间 chunk 未被入口动态引用：${key}（${chunk.file}）`);
  }
  if (!existsSync(join(root, 'dist', chunk.file))) {
    failures.push(`空间 chunk 文件缺失：${chunk.file}`);
  }
}

const entryChunk = manifest['index.html'];
if (entryChunk !== undefined && /spatial-vendor/i.test(entryChunk.file)) {
  failures.push('入口 chunk 被误命名为 spatial-vendor');
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`);
  process.exit(1);
}
console.log('spatial 分包校验通过');