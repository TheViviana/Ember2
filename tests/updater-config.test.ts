import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

/**
 * P7：自动更新的配置漂移守卫。
 *
 * 本机没有签名身份，base 配置必须保持 createUpdaterArtifacts=false，
 * 否则普通 `pnpm tauri build` 会因缺少 TAURI_SIGNING_PRIVATE_KEY 直接失败；
 * 发布流水线通过 scripts/release/build-macos.sh 的 --config 覆盖打开。
 */
function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

void test('tauri.conf.json 注册 updater 插件与占位 endpoint/pubkey', () => {
  const conf = readJson('src-tauri/tauri.conf.json');
  const plugins = conf.plugins as { updater?: { endpoints?: unknown; pubkey?: unknown } } | undefined;
  const updater = plugins?.updater;
  assert.ok(updater, '必须配置 plugins.updater');
  assert.ok(Array.isArray(updater.endpoints), 'endpoints 必须是数组');
  assert.equal(updater.endpoints.length, 1);
  assert.equal(typeof updater.endpoints[0], 'string');
  assert.equal(typeof updater.pubkey, 'string');
  assert.ok((updater.pubkey as string).length > 0, 'pubkey 不能为空');
  const bundle = conf.bundle as { createUpdaterArtifacts?: unknown };
  assert.equal(bundle.createUpdaterArtifacts, false, 'base 配置不得打开产物签名，避免本地构建失败');
});

void test('default capability 授予 updater:default', () => {
  const capability = readJson('src-tauri/capabilities/default.json');
  assert.ok(
    Array.isArray(capability.permissions) && (capability.permissions as unknown[]).includes('updater:default'),
  );
});

void test('Rust 入口注册 updater 插件', () => {
  const source = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.ok(source.includes('tauri_plugin_updater::Builder::new().build()'));
});
