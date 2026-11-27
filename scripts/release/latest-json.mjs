#!/usr/bin/env node
/**
 * 生成/合并 Tauri v2 updater 清单 `latest.json`（P0-3）。
 *
 * 失败即 exit 1（不静默）：缺 `url`/`signature`、版本号三处不一致、既有清单损坏、
 * 试图用更低版本覆盖既有清单，都按发布事故处理。
 *
 * 跨平台发布：`latest.json` 的平台条目会与既有文件合并，本次只覆盖自己负责的平台键，
 * 避免 Windows 发布把 macOS 条目冲掉。
 *
 * 用法（CI 见 `.github/workflows/release-windows.yml`）：
 *   node scripts/release/latest-json.mjs \
 *     --dir src-tauri/target/release/bundle/nsis \
 *     --platform windows-x86_64 \
 *     --repository owner/repo --tag v1.2.2 \
 *     --out latest.json [--existing 既有/latest.json] [--prune-stale-platforms]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ALLOWED = new Set([
  'cwd',
  'config',
  'dir',
  'asset-ext',
  'platform',
  'repository',
  'tag',
  'existing',
  'out',
  'notes',
  'pub-date',
  'allow-tag-mismatch',
  'prune-stale-platforms',
]);

const BOOLEAN = new Set(['allow-tag-mismatch', 'prune-stale-platforms']);

function fail(message) {
  console.error(`latest-json: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) fail(`未知参数 ${token}`);
    const key = token.slice(2);
    if (!ALLOWED.has(key)) fail(`未知参数 ${token}`);
    if (BOOLEAN.has(key)) {
      if (args[key] !== undefined) fail(`${token} 重复`);
      args[key] = 'true';
      continue;
    }
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

/** 版本号三处必须一致：安装包名取 tauri.conf，运行时版本取 package/Cargo，漂移会导致更新循环。 */
function resolveVersion(cwd, configRel) {
  const configPath = resolve(cwd, configRel);
  const config = readJson(configPath);
  const version = config?.version;
  if (typeof version !== 'string' || version.trim() === '') fail(`配置缺少 version：${configPath}`);

  const packageVersion = readJson(resolve(cwd, 'package.json'))?.version;
  const cargoVersion = readCargoVersion(resolve(cwd, 'src-tauri', 'Cargo.toml'));
  const versions = { 'tauri.conf.json': version, 'package.json': packageVersion, 'Cargo.toml': cargoVersion };
  for (const [name, value] of Object.entries(versions)) {
    if (typeof value !== 'string' || value !== version) {
      fail(
        `版本号三处不一致：tauri.conf.json=${version} package.json=${String(packageVersion)} Cargo.toml=${String(cargoVersion)}（${name} 不匹配）`,
      );
    }
  }
  return version;
}

function versionFromTag(tag) {
  const matched = tag.match(/^v(\d+\.\d+\.\d+)(?:[-+].*)?$/);
  return matched === null ? null : matched[1];
}

function compareVersions(left, right) {
  const parse = (value) => value.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function validateEntry(name, entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    fail(`平台条目 ${name} 不是对象`);
  }
  const { url, signature } = entry;
  if (typeof url !== 'string' || !url.startsWith('https://')) {
    fail(`平台条目 ${name} 的 url 缺失或不是 https：${String(url)}`);
  }
  if (typeof signature !== 'string' || signature.trim() === '') {
    fail(`平台条目 ${name} 的 signature 为空`);
  }
}

const args = parseArgs(process.argv.slice(2));
for (const key of ['dir', 'platform', 'repository', 'tag', 'out']) {
  if (args[key] === undefined || args[key].trim() === '') fail(`缺少 --${key}`);
}

const cwd = resolve(args.cwd ?? process.cwd());
const tag = args.tag.trim();
if (/\s/.test(tag)) fail(`--tag 不能包含空白：${tag}`);
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repository)) {
  fail(`--repository 必须形如 owner/repo：${args.repository}`);
}

const version = resolveVersion(cwd, args.config ?? 'src-tauri/tauri.conf.json');

// tag 是发版动作本身，最容易出现「改了 tag 忘了改版本号」。不一致时 updater 会认为
// 已是最新而静默跳过本次更新，因此默认硬失败；预演可用 --allow-tag-mismatch 显式放行。
const tagVersion = versionFromTag(tag);
if (tagVersion !== null && tagVersion !== version && args['allow-tag-mismatch'] !== 'true') {
  fail(
    `tag ${tag} 与版本号不一致：tag 对应 ${tagVersion}，tauri.conf/package/Cargo 为 ${version}。` +
      `这会让用户端 updater 判定「已是最新」而静默跳过本次更新；如为预演请显式传 --allow-tag-mismatch`,
  );
}

const bundleDir = resolve(cwd, args.dir);
if (!existsSync(bundleDir)) fail(`找不到产物目录 ${bundleDir}`);
const extension = args['asset-ext'] ?? 'exe';
const assets = readdirSync(bundleDir).filter(
  (name) => name.endsWith(`.${extension}`) && !name.endsWith('.sig'),
);
if (assets.length !== 1) {
  fail(`期望恰好一个 .${extension} 资产，实际 ${assets.length} 个：${assets.join(', ') || '无'}`);
}
const assetName = assets[0];
const signaturePath = join(bundleDir, `${assetName}.sig`);
if (!existsSync(signaturePath)) fail(`缺少签名文件 ${signaturePath}`);
const signature = readFileSync(signaturePath, 'utf8').trim();
if (signature.length < 20) fail(`签名内容疑似为空或占位：${signaturePath}`);
const url = `https://github.com/${args.repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`;

let existing = null;
if (args.existing !== undefined) {
  const existingPath = resolve(cwd, args.existing);
  if (existsSync(existingPath)) {
    existing = readJson(existingPath);
    if (existing === null || typeof existing !== 'object' || Array.isArray(existing)) {
      fail(`既有清单不是对象：${existingPath}`);
    }
    const existingPlatforms = existing.platforms;
    if (existingPlatforms === null || typeof existingPlatforms !== 'object' || Array.isArray(existingPlatforms)) {
      fail(`既有清单缺少 platforms 对象：${existingPath}`);
    }
    for (const [name, entry] of Object.entries(existingPlatforms)) validateEntry(name, entry);
    if (typeof existing.version === 'string' && compareVersions(existing.version, version) > 0) {
      fail(`既有清单版本 ${existing.version} 高于本次 ${version}，拒绝降级覆盖`);
    }
  }
}

// 单平台发布时可用 --prune-stale-platforms 丢掉仍指向旧 tag 的其它平台条目，
// 避免全局 version 升到新版后，旧平台的 url 让用户「检测到新版本却下载旧包」。
const pruneStale = args['prune-stale-platforms'] === 'true';
const pointsToTag = (entry) =>
  entry !== null &&
  typeof entry === 'object' &&
  typeof entry.url === 'string' &&
  entry.url.includes(`/download/${encodeURIComponent(tag)}/`);
const existingPlatforms = existing?.platforms ?? {};
const mergedPlatforms = pruneStale
  ? Object.fromEntries(
      Object.entries(existingPlatforms).filter(
        ([name, entry]) => name === args.platform || pointsToTag(entry),
      ),
    )
  : existingPlatforms;
const platforms = { ...mergedPlatforms, [args.platform]: { signature, url } };
for (const [name, entry] of Object.entries(platforms)) validateEntry(name, entry);

// 合并默认保留其它平台条目：若它们仍指向旧版本，对应平台用户会「检测到新版本却下载旧包」。
// 不直接失败（macOS 可能尚未发布），但必须在 CI 里留下醒目告警；需要清理时传 --prune-stale-platforms。
const stalePlatforms = Object.keys(platforms).filter(
  (name) => name !== args.platform && !pointsToTag(platforms[name]),
);
if (stalePlatforms.length > 0) {
  const staleLabel = typeof existing?.version === 'string' ? ` ${existing.version}` : '旧版本';
  console.warn(
    `::warning::latest.json 中 ${stalePlatforms.join(', ')} 仍指向${staleLabel}；` +
      `本次发布 ${version} 后这些平台会检测到新版本却下载旧包。若该平台已发布，请同步更新其条目，` +
      `或传 --prune-stale-platforms 移除。`,
  );
}

const output = {
  version,
  notes: args.notes ?? (typeof existing?.notes === 'string' ? existing.notes : ''),
  pub_date: args['pub-date'] ?? new Date().toISOString(),
  platforms,
};

const outPath = resolve(cwd, args.out);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(`latest-json: ${Object.keys(platforms).join(', ')} -> ${outPath}`);