import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT = fileURLToPath(new URL('../../scripts/release/latest-json.mjs', import.meta.url));

function createRepo(version = '1.2.1'): string {
  const root = mkdtempSync(join(tmpdir(), 'ember-latest-json-'));
  mkdirSync(join(root, 'src-tauri'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ember', version }));
  writeFileSync(join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version }));
  writeFileSync(join(root, 'src-tauri', 'Cargo.toml'), `[package]\nname = "ember"\nversion = "${version}"\n`);
  return root;
}

function createBundle(root: string, options: { signature?: string | null; asset?: string } = {}): string {
  const bundle = join(root, 'bundle');
  mkdirSync(bundle, { recursive: true });
  const asset = options.asset ?? 'Ember_1.2.1_x64-setup.exe';
  writeFileSync(join(bundle, asset), 'binary');
  if (options.signature !== null) {
    writeFileSync(
      join(bundle, `${asset}.sig`),
      options.signature ?? 'untrusted comment: signature from tauri secret key\nRWT1c2lnbmF0dXJlZm9yPXRlc3Rz\n',
    );
  }
  return bundle;
}

function run(cwd: string, extra: string[], tag = 'v1.2.1'): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--cwd',
      cwd,
      '--dir',
      'bundle',
      '--platform',
      'windows-x86_64',
      '--repository',
      'TheViviana/Ember2',
      '--tag',
      tag,
      '--out',
      'out/latest.json',
      ...extra,
    ],
    { cwd, encoding: 'utf8' },
  );
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

void test('生成清单：url 指向本次资产，signature 原样写入', () => {
  const root = createRepo();
  try {
    createBundle(root);
    const result = run(root, []);
    assert.equal(result.status, 0, String(result.stderr));
    const manifest = JSON.parse(readFileSync(join(root, 'out', 'latest.json'), 'utf8')) as {
      version: string;
      pub_date: string;
      platforms: Record<string, { url: string; signature: string }>;
    };
    assert.equal(manifest.version, '1.2.1');
    assert.ok(Number.isFinite(Date.parse(manifest.pub_date)));
    const entry = manifest.platforms['windows-x86_64'];
    assert.ok(entry);
    assert.equal(
      entry.url,
      'https://github.com/TheViviana/Ember2/releases/download/v1.2.1/Ember_1.2.1_x64-setup.exe',
    );
    assert.match(entry.signature, /^untrusted comment:/);
  } finally {
    cleanup(root);
  }
});

void test('合并既有清单：保留其它平台条目，不互相覆盖', () => {
  const root = createRepo();
  try {
    createBundle(root);
    writeFileSync(
      join(root, 'existing.json'),
      JSON.stringify({
        version: '1.2.0',
        notes: 'old',
        pub_date: '2026-01-01T00:00:00Z',
        platforms: {
          'darwin-aarch64': {
            url: 'https://example.com/Ember_1.2.0_aarch64.app.tar.gz',
            signature: 'existing-signature-content',
          },
        },
      }),
    );
    const result = run(root, ['--existing', 'existing.json']);
    assert.equal(result.status, 0, String(result.stderr));
    const manifest = JSON.parse(readFileSync(join(root, 'out', 'latest.json'), 'utf8')) as {
      version: string;
      platforms: Record<string, { url: string; signature: string }>;
    };
    assert.equal(manifest.version, '1.2.1');
    assert.deepEqual(Object.keys(manifest.platforms).sort(), ['darwin-aarch64', 'windows-x86_64']);
    assert.equal(manifest.platforms['darwin-aarch64']?.signature, 'existing-signature-content');
    assert.match(String(result.stderr), /::warning::.*darwin-aarch64 仍指向 1\.2\.0/);
  } finally {
    cleanup(root);
  }
});

void test('缺少签名文件时失败', () => {
  const root = createRepo();
  try {
    createBundle(root, { signature: null });
    const result = run(root, []);
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /签名/);
  } finally {
    cleanup(root);
  }
});

void test('版本号三处不一致时失败', () => {
  const root = createRepo();
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ember', version: '1.2.0' }));
    createBundle(root);
    const result = run(root, []);
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /版本号三处不一致/);
  } finally {
    cleanup(root);
  }
});

void test('拒绝用低版本覆盖既有清单', () => {
  const root = createRepo();
  try {
    createBundle(root);
    writeFileSync(
      join(root, 'existing.json'),
      JSON.stringify({
        version: '1.3.0',
        platforms: {
          'windows-x86_64': { url: 'https://example.com/Ember_1.3.0_x64-setup.exe', signature: 'sig' },
        },
      }),
    );
    const result = run(root, ['--existing', 'existing.json']);
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /拒绝降级覆盖/);
  } finally {
    cleanup(root);
  }
});

void test('既有条目缺 signature 时失败，不静默丢弃', () => {
  const root = createRepo();
  try {
    createBundle(root);
    writeFileSync(
      join(root, 'existing.json'),
      JSON.stringify({
        version: '1.2.0',
        platforms: { 'darwin-aarch64': { url: 'https://example.com/x.app.tar.gz', signature: '' } },
      }),
    );
    const result = run(root, ['--existing', 'existing.json']);
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /signature 为空/);
  } finally {
    cleanup(root);
  }
});

void test('既有清单文件不存在时走首次生成，不报错', () => {
  const root = createRepo();
  try {
    createBundle(root);
    const result = run(root, ['--existing', 'missing.json']);
    assert.equal(result.status, 0, String(result.stderr));
    const manifest = JSON.parse(readFileSync(join(root, 'out', 'latest.json'), 'utf8')) as {
      platforms: Record<string, { url: string }>;
    };
    assert.deepEqual(Object.keys(manifest.platforms), ['windows-x86_64']);
  } finally {
    cleanup(root);
  }
});

void test('tag 与版本号不一致时失败（改了 tag 忘了改版本号）', () => {
  const root = createRepo();
  try {
    createBundle(root);
    const result = run(root, [], 'v1.2.2');
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /不一致.*1\.2\.2/);
  } finally {
    cleanup(root);
  }
});

void test('预演可通过 --allow-tag-mismatch 显式放行 tag 不一致', () => {
  const root = createRepo();
  try {
    createBundle(root);
    const result = run(root, ['--allow-tag-mismatch'], 'v1.2.2');
    assert.equal(result.status, 0, String(result.stderr));
  } finally {
    cleanup(root);
  }
});

void test('非 v 语义化 tag 不做版本比对（如 nightly）', () => {
  const root = createRepo();
  try {
    createBundle(root);
    const result = run(root, [], 'nightly');
    assert.equal(result.status, 0, String(result.stderr));
  } finally {
    cleanup(root);
  }
});