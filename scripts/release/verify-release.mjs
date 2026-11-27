#!/usr/bin/env node
/**
 * 双平台发布门禁（1.2.3 起）：publish 前确认 Release 资产与 `latest.json` 同时覆盖
 * Windows 与 macOS，且所有平台 url 指向本次 tag。任一条件不满足即 exit 1。
 *
 * 背景：Tauri updater 的 `latest.json` 只有一个全局 version，无法表达
 * 「Windows 1.2.3 / macOS 1.2.2」。双平台对齐只能靠发布流程保证：
 * 两平台资产齐全、清单条目齐全后，才允许把 draft 转正。
 *
 * 用法：
 *   node scripts/release/verify-release.mjs --tag v1.2.3 --repository TheViviana/Ember2
 *
 * 离线 / 测试（不访问 GitHub）：
 *   node scripts/release/verify-release.mjs --tag v1.2.3 --cwd <repo> \
 *     --assets <assets.json> --manifest <latest.json>
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

/** 1.2.3 起的发布门禁要求三份平台条目同时存在。 */
const REQUIRED_PLATFORMS = ['windows-x86_64', 'darwin-aarch64', 'darwin-x86_64'];
const ALLOWED = new Set(['tag', 'repository', 'cwd', 'assets', 'manifest']);

let tempDir = null;
process.on('exit', () => {
  if (tempDir !== null) rmSync(tempDir, { recursive: true, force: true });
});

function fail(message) {
  console.error(`verify-release: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) fail(`未知参数 ${token}`);
    const key = token.slice(2);
    if (!ALLOWED.has(key)) fail(`未知参数 ${token}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${token} 缺少值`);
    if (args[key] !== undefined) fail(`${token} 重复`);
    args[key] = value;
    index += 1;
  }
  return args;
}

function readJson(path) {
  if (!existsSync(path)) fail(`找不到文件 ${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`不是合法 JSON：${path}`);
  }
}

function readCargoVersion(path) {
  if (!existsSync(path)) fail(`找不到文件 ${path}`);
  const matched = readFileSync(path, 'utf8').match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m);
  if (matched === null) fail(`Cargo.toml 缺少 [package] version：${path}`);
  return matched[1];
}

/** tag 版本与三处版本文件必须一致，否则发布出来的资产名与最新版号会对不上。 */
function checkRepoVersions(cwd, version) {
  const config = readJson(resolve(cwd, 'src-tauri', 'tauri.conf.json'));
  const packageVersion = readJson(resolve(cwd, 'package.json'))?.version;
  const cargoVersion = readCargoVersion(resolve(cwd, 'src-tauri', 'Cargo.toml'));
  const mismatched = [];
  if (config?.version !== version) mismatched.push(`tauri.conf.json=${String(config?.version)}`);
  if (packageVersion !== version) mismatched.push(`package.json=${String(packageVersion)}`);
  if (cargoVersion !== version) mismatched.push(`Cargo.toml=${String(cargoVersion)}`);
  if (mismatched.length > 0) {
    fail(`版本号与 tag 不一致：tag=${version}（${mismatched.join('，')}）`);
  }
}

function gh(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.error) fail(`无法执行 gh：${result.error.message}`);
  return result;
}

function loadAssets(args, tag) {
  if (args.assets !== undefined) {
    const path = resolve(args.cwd ?? process.cwd(), args.assets);
    const value = readJson(path);
    if (!Array.isArray(value) || value.some((name) => typeof name !== 'string')) {
      fail(`--assets 必须是字符串数组：${path}`);
    }
    return { names: new Set(value), draft: null };
  }
  if (args.repository === undefined) fail('在线模式需要 --repository owner/repo');
  const result = gh([
    'release',
    'view',
    tag,
    '--repo',
    args.repository,
    '--json',
    'assets,isDraft',
  ]);
  if (result.status !== 0) fail(`读取 Release ${tag} 失败：${String(result.stderr).trim()}`);
  let view;
  try {
    view = JSON.parse(result.stdout);
  } catch {
    fail(`gh 输出不是合法 JSON：${tag}`);
  }
  const assets = view?.assets;
  if (!Array.isArray(assets)) fail(`Release ${tag} 缺少 assets`);
  return {
    names: new Set(assets.map((asset) => asset.name)),
    draft: view.isDraft === true,
  };
}

function loadManifest(args, tag, cwd) {
  if (args.manifest !== undefined) return resolve(cwd, args.manifest);
  if (args.repository === undefined) fail('在线模式需要 --repository owner/repo');
  tempDir = mkdtempSync(join(tmpdir(), 'ember-verify-release-'));
  const result = gh([
    'release',
    'download',
    tag,
    '--repo',
    args.repository,
    '--pattern',
    'latest.json',
    '--dir',
    tempDir,
  ]);
  if (result.status !== 0) fail(`下载 latest.json 失败：${String(result.stderr).trim()}`);
  return join(tempDir, 'latest.json');
}

/** 从清单 url 还原资产名（URL 由 latest-json.mjs 生成，末段就是文件名）。 */
function assetNameFromUrl(url) {
  const pathPart = url.split('?')[0].split('#')[0];
  const name = pathPart.slice(pathPart.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.tag === undefined || args.tag.trim() === '') fail('缺少 --tag');
const tag = args.tag.trim();
if (/\s/.test(tag)) fail(`--tag 不能包含空白：${tag}`);
const matched = tag.match(/^v(\d+\.\d+\.\d+)$/);
if (matched === null) fail(`发布门禁只接受正式 tag（vX.Y.Z）：${tag}`);
const version = matched[1];

const cwd = resolve(args.cwd ?? process.cwd());
checkRepoVersions(cwd, version);

const assets = loadAssets(args, tag);
const manifestPath = loadManifest(args, tag, cwd);
const manifest = readJson(manifestPath);

if (manifest?.version !== version) {
  fail(`latest.json 的 version 是 ${String(manifest?.version)}，与 tag ${tag} 不一致`);
}
const platforms = manifest?.platforms;
if (platforms === null || typeof platforms !== 'object' || Array.isArray(platforms)) {
  fail('latest.json 缺少 platforms 对象');
}
if (!assets.names.has('latest.json')) fail('Release 缺少 latest.json 资产');

const missing = REQUIRED_PLATFORMS.filter((name) => !Object.hasOwn(platforms, name));
if (missing.length > 0) {
  fail(
    `latest.json 缺少平台条目：${missing.join(', ')}。` +
      `1.2.3 起必须双平台同时发布；macOS 未就绪时不要 publish。`,
  );
}

const tagSegment = `/download/${encodeURIComponent(tag)}/`;
for (const name of REQUIRED_PLATFORMS) {
  const entry = platforms[name];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(`平台条目 ${name} 不是对象`);
  }
  const { url, signature } = entry;
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    fail(`平台条目 ${name} 的 url 缺失或不是 https：${String(url)}`);
  }
  if (!url.includes(tagSegment)) {
    fail(`平台条目 ${name} 的 url 未指向 ${tag}：${url}`);
  }
  if (typeof signature !== 'string' || signature.trim().length < 20) {
    fail(`平台条目 ${name} 的 signature 为空或过短`);
  }
  const asset = assetNameFromUrl(url);
  if (name === 'windows-x86_64' && !asset.endsWith('.exe')) {
    fail(`windows-x86_64 指向的资产不是 .exe：${asset}`);
  }
  if (name.startsWith('darwin') && !asset.endsWith('.app.tar.gz')) {
    fail(`${name} 指向的资产不是 .app.tar.gz：${asset}`);
  }
  if (!assets.names.has(asset)) fail(`Release 缺少平台 ${name} 引用的资产：${asset}`);
  if (!assets.names.has(`${asset}.sig`)) fail(`Release 缺少签名资产：${asset}.sig`);
}

console.log(`verify-release: OK ${tag}`);
for (const name of REQUIRED_PLATFORMS) console.log(`  ${name} -> ${platforms[name].url}`);
if (assets.draft === false) {
  console.warn('verify-release: Release 已发布；本次只做一致性校验，不改变状态');
}