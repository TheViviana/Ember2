import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT = fileURLToPath(new URL('../../scripts/release/verify-release.mjs', import.meta.url));
const REPOSITORY = 'TheViviana/Ember2';
const SIGNATURE =
  'untrusted comment: signature from tauri secret key\nRWT1c2lnbmF0dXJlZm9yPXRlc3Rz\n';
const WINDOWS_ASSET = 'Ember_1.2.3_x64-setup.exe';
const MACOS_ASSET = 'Ember_1.2.3_universal.app.tar.gz';

function createRepo(version = '1.2.3'): string {
  const root = mkdtempSync(join(tmpdir(), 'ember-verify-release-'));
  mkdirSync(join(root, 'src-tauri'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'ember', version }));
  writeFileSync(join(root, 'src-tauri', 'tauri.conf.json'), JSON.stringify({ version }));
  writeFileSync(
    join(root, 'src-tauri', 'Cargo.toml'),
    `[package]\nname = "ember"\nversion = "${version}"\n`,
  );
  return root;
}

function assetUrl(version: string, asset: string): string {
  return `https://github.com/${REPOSITORY}/releases/download/v${version}/${asset}`;
}

function defaultAssets(): string[] {
  return [
    WINDOWS_ASSET,
    `${WINDOWS_ASSET}.sig`,
    MACOS_ASSET,
    `${MACOS_ASSET}.sig`,
    'latest.json',
  ];
}

function defaultManifest(): {
  version: string;
  notes: string;
  pub_date: string;
  platforms: Record<string, { signature: string; url: string }>;
} {
  return {
    version: '1.2.3',
    notes: '',
    pub_date: '2026-12-01T00:00:00Z',
    platforms: {
      'windows-x86_64': { signature: SIGNATURE, url: assetUrl('1.2.3', WINDOWS_ASSET) },
      'darwin-aarch64': { signature: SIGNATURE, url: assetUrl('1.2.3', MACOS_ASSET) },
      'darwin-x86_64': { signature: SIGNATURE, url: assetUrl('1.2.3', MACOS_ASSET) },
    },
  };
}

function writeInputs(root: string, manifest: unknown, assets: string[]): void {
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(root, 'assets.json'), JSON.stringify(assets));
}

function run(root: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--cwd',
      root,
      '--tag',
      'v1.2.3',
      '--assets',
      'assets.json',
      '--manifest',
      'manifest.json',
    ],
    { cwd: root, encoding: 'utf8' },
  );
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

void test('双平台资产与清单齐备时通过', () => {
  const root = createRepo();
  try {
    writeInputs(root, defaultManifest(), defaultAssets());
    const result = run(root);
    assert.equal(result.status, 0, String(result.stderr));
    assert.match(String(result.stdout), /verify-release: OK v1\.2\.3/);
    for (const platform of ['windows-x86_64', 'darwin-aarch64', 'darwin-x86_64']) {
      assert.match(String(result.stdout), new RegExp(platform));
    }
  } finally {
    cleanup(root);
  }
});

void test('缺少 macOS 资产时失败', () => {
  const root = createRepo();
  try {
    const assets = defaultAssets().filter((name) => !name.startsWith('Ember_1.2.3_universal'));
    writeInputs(root, defaultManifest(), assets);
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /缺少平台 darwin-aarch64 引用的资产/);
  } finally {
    cleanup(root);
  }
});

void test('macOS url 指向旧 tag 时失败', () => {
  const root = createRepo();
  try {
    const manifest = defaultManifest();
    manifest.platforms['darwin-aarch64'] = {
      signature: SIGNATURE,
      url: assetUrl('1.2.2', 'Ember_1.2.2_universal.app.tar.gz'),
    };
    writeInputs(root, manifest, defaultAssets());
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /未指向 v1\.2\.3/);
  } finally {
    cleanup(root);
  }
});

void test('清单缺少 darwin-x86_64 条目时失败', () => {
  const root = createRepo();
  try {
    const manifest = defaultManifest();
    delete manifest.platforms['darwin-x86_64'];
    writeInputs(root, manifest, defaultAssets());
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /缺少平台条目.*darwin-x86_64/);
  } finally {
    cleanup(root);
  }
});

void test('清单 version 与 tag 不一致时失败', () => {
  const root = createRepo();
  try {
    const manifest = defaultManifest();
    manifest.version = '1.2.2';
    writeInputs(root, manifest, defaultAssets());
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /latest\.json 的 version/);
  } finally {
    cleanup(root);
  }
});

void test('仓库三处版本与 tag 不一致时失败', () => {
  const root = createRepo();
  try {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'ember', version: '1.2.2' }),
    );
    writeInputs(root, defaultManifest(), defaultAssets());
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /版本号与 tag 不一致/);
  } finally {
    cleanup(root);
  }
});

void test('Release 缺少 latest.json 资产时失败', () => {
  const root = createRepo();
  try {
    writeInputs(
      root,
      defaultManifest(),
      defaultAssets().filter((name) => name !== 'latest.json'),
    );
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /缺少 latest\.json 资产/);
  } finally {
    cleanup(root);
  }
});

void test('平台签名为空或过短时失败', () => {
  const root = createRepo();
  try {
    const manifest = defaultManifest();
    manifest.platforms['darwin-x86_64'] = {
      signature: 'short',
      url: assetUrl('1.2.3', MACOS_ASSET),
    };
    writeInputs(root, manifest, defaultAssets());
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(String(result.stderr), /signature 为空或过短/);
  } finally {
    cleanup(root);
  }
});