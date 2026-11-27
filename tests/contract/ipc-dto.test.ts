/**
 * IPC DTO 契约双侧校验（ADR 0003 决策一）。
 *
 * Rust 侧 `src-tauri/tests/ipc_dto_snapshot.rs` 用完整结构体字面量生成快照；
 * 这里用 `satisfies` 做编译期校验（新鲜对象字面量 ⇒ 缺字段、多字段、类型不符都会报错），
 * 再用深度比较把样本与 Rust 快照绑定。任一侧单独改动都会红。
 *
 * 快照更新：`UPDATE_IPC_SNAPSHOTS=1 cargo test --test ipc_dto_snapshot`。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type {
  DirEntryDto,
  FileChangedDto,
  ReadDocDto,
  ScanDocDto,
  StatDto,
  TrashResultDto,
  VaultConstantsDto,
  VaultIdentityDto,
  WatchErrorPayload,
  WriteDocDto,
} from '../../src/types/ipc.ts';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'ipc');

/** 第一批覆盖 VaultPort 用到的 10 个载荷（ADR 0003 决策一）。 */
const samples = {
  VaultIdentityDto: {
    vaultId: '01J8Z9K3Q7V5N2M4X6C8B0D1F2',
    root: '/Users/zero/EmberVault',
    schemaVersion: 2,
    readonly: false,
    readonlyReason: 'filesystemReadonly',
  } satisfies VaultIdentityDto,
  VaultConstantsDto: {
    maxDocBytes: 16_777_216,
    maxImageBytes: 33_554_432,
    maxMediaBytes: 209_715_200,
    historyKeep: 50,
    historyBudgetBytes: 52_428_800,
    trashRetentionDays: 7,
    watcherDebounceMs: 200,
    maxScanDepth: 32,
  } satisfies VaultConstantsDto,
  ReadDocDto: {
    path: 'documents/note.md',
    text: '# 标题\n正文\n',
    bytes: 24,
    sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    modifiedMs: 1_763_000_000_000,
  } satisfies ReadDocDto,
  WriteDocDto: {
    path: 'documents/note.md',
    bytes: 24,
    sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  } satisfies WriteDocDto,
  StatDto: {
    path: 'documents/note.md',
    bytes: 24,
    sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    modifiedMs: 1_763_000_000_000,
  } satisfies StatDto,
  DirEntryDto: {
    name: 'note.md',
    path: 'documents/note.md',
    kind: 'file',
    bytes: 24,
    modifiedMs: 1_763_000_000_000,
  } satisfies DirEntryDto,
  ScanDocDto: {
    path: 'documents/note.md',
    bytes: 24,
    sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    modifiedMs: 1_763_000_000_000,
  } satisfies ScanDocDto,
  TrashResultDto: {
    via: 'workbench',
    trashId: '01J8Z9K3Q7V5N2M4X6C8B0D1F2',
  } satisfies TrashResultDto,
  FileChangedDto: {
    changes: [
      {
        kind: 'renamed',
        path: 'documents/b.md',
        from: 'documents/a.md',
        bytes: 24,
        sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        modifiedMs: 1_763_000_000_000,
      },
      {
        kind: 'removed',
        path: 'documents/c.md',
      },
    ],
  } satisfies FileChangedDto,
  WatchErrorPayload: {
    code: 'E_IO',
    message: 'I/O 失败：permission denied',
  } satisfies WatchErrorPayload,
};

void test('Rust 快照与 TS 类型样本逐字段一致', () => {
  for (const [name, sample] of Object.entries(samples)) {
    const actual: unknown = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
    assert.deepEqual(actual, sample, `${name}：Rust 快照与 TS 样本不一致`);
  }
});

const COVERED = new Set(Object.keys(samples));

/** 当前未覆盖的 `*Dto` struct 数量（40 个 struct - 已覆盖 9 个 struct）；只允许下调。 */
const UNCOVERED_BASELINE = 31;

function rustFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...rustFiles(path));
    else if (name.endsWith('.rs')) files.push(path);
  }
  return files;
}

void test('覆盖棘轮：未覆盖的 *Dto struct 数量只减不增', () => {
  const structs = new Set<string>();
  for (const file of rustFiles(join(ROOT, 'src-tauri', 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/pub struct ([A-Za-z0-9_]+Dto)\b/g)) {
      const name = match[1];
      if (name !== undefined) structs.add(name);
    }
  }
  const uncovered = [...structs].filter((name) => !COVERED.has(name)).sort();
  assert.ok(
    uncovered.length <= UNCOVERED_BASELINE,
    `未覆盖 DTO ${uncovered.length} 个，超过基线 ${UNCOVERED_BASELINE}——新增 DTO 请补快照与 TS 样本：\n${uncovered.join(', ')}`,
  );
});