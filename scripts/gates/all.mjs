// gate 入口：顺序跑全部架构门禁（PLAN.md §1.1）。
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
for (const gate of [
  'bans.mjs',
  'layers.mjs',
  'mutable-exports.mjs',
  'cycles.mjs',
  'ipc-chokepoint.mjs',
  'command-registry.mjs',
]) {
  const r = spawnSync('node', [join(here, gate)], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
console.log('gate: 全部通过');
