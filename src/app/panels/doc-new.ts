/**
 * CR-20261119-08：文档库新建入口的纯函数。
 * 零 React 依赖、零 DOM 依赖（仅依赖 core/path-segments 纯函数），可直接在 node --test 链执行。
 */
import { illegalSegment } from '../../core/path-segments.ts';

export type TargetDirKind = 'dir' | 'file' | 'blank';

/**
 * 目标目录推断：右键/点击落点 → 相对库根的路径字符串（空代表库根）。
 *
 * @param kind  落点类型：'dir'（文件夹行）→ 该目录；'file'（文档文件行）→ 其父目录；'blank'（空白/标题栏）→ 库根
 * @param clickedPath 落点的相对路径（file/dir 时必填，blank 时可省略）
 */
export function resolveNewDocDir(kind: TargetDirKind, clickedPath?: string): string {
  if (kind === 'blank') return '';
  if (!clickedPath) return '';
  if (kind === 'dir') return clickedPath;
  // kind === 'file'：取父目录
  const slash = clickedPath.lastIndexOf('/');
  return slash === -1 ? '' : clickedPath.slice(0, slash);
}

/** 路径校验的固定 reason 值（与 core.CreateDocReason 对齐，PATH_* 系列）。 */
export type ValidateNewDocReason =
  | 'PATH_ABSOLUTE'
  | 'PATH_ESCAPE'
  | 'PATH_HIDDEN'
  | 'PATH_EMPTY'
  | 'PATH_EXT';

export type ValidateNewDocResult =
  | { ok: true; rel: string; targetDir: string; baseInput: string }
  | { ok: false; reason: ValidateNewDocReason; message: string };

/**
 * 相对路径内联输入 → 完整相对库根路径。
 *
 * 规则：
 * - 只做**语法与路径段校验**（不做存在性判断——存在性由 core.vault_stat 负责）；
 * - 空路径 / 全空白 → PATH_EMPTY；
 * - 绝对路径（以 `/` 开头，或 Windows 盘符 `C:\` / `C:/`）→ PATH_ABSOLUTE；
 * - 任一段含 `..`（**逐段判断**，`a..b.md` 段名合法，不能子串匹配）→ PATH_ESCAPE；
 * - 任一段以 `.` 开头（`a/.b/c.md` 因 `.b` 段拒；`.hidden.md` 拒）→ PATH_HIDDEN；
 * - 解析后等于库根（拼接后为空或 `/`）→ PATH_EMPTY；
 * - 扩展名不是 `.md`（大小写不敏感；无扩展名**自动补** `.md`）→ PATH_EXT（仅当有扩展名但非 md 时）。
 */
export function validateNewDocPath(
  input: string,
  targetDir: string,
): ValidateNewDocResult {
  const trimmed = input.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'PATH_EMPTY', message: '请输入文件名' };
  }

  // 绝对路径 → 拒（与 Rust Path::is_absolute 对齐：含 Windows 盘符 C:\ / C:/）
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return { ok: false, reason: 'PATH_ABSOLUTE', message: '请使用库内相对路径' };
  }

  const segments = trimmed.split('/');

  // 逐段校验：空段 / `..` 段用 core/path-segments.illegalSegment 单源判定；
  // `..` → PATH_ESCAPE，空段 → PATH_EMPTY；以 `.` 开头的段（含 `.` 段本身）→ PATH_HIDDEN。
  for (const seg of segments) {
    const ill = illegalSegment(seg);
    if (ill === 'empty') {
      return { ok: false, reason: 'PATH_EMPTY', message: '请输入文件名' };
    }
    if (ill === 'dotdot') {
      return { ok: false, reason: 'PATH_ESCAPE', message: '路径不允许穿越上级目录' };
    }
    // 段以 `.` 开头 → 拒（`.` / `.hidden.md` / `a/.b/c.md` 的 `.b` 段均命中）
    if (seg.startsWith('.')) {
      return { ok: false, reason: 'PATH_HIDDEN', message: '不允许以 `.` 开头（隐藏语义）' };
    }
  }

  // 扩展名：无 → 自动补 .md；有但非 .md → 拒
  const lastSeg = segments[segments.length - 1] ?? '';
  const dotIdx = lastSeg.lastIndexOf('.');
  let finalLastSeg: string;
  if (dotIdx === -1) {
    finalLastSeg = `${lastSeg}.md`;
  } else {
    const ext = lastSeg.slice(dotIdx + 1).toLowerCase();
    if (ext !== 'md') {
      return { ok: false, reason: 'PATH_EXT', message: '请使用 `.md` 扩展名' };
    }
    finalLastSeg = lastSeg; // 保留用户原始大小写
  }
  segments[segments.length - 1] = finalLastSeg;

  // 合成完整相对路径
  const withTarget = targetDir === '' ? segments.join('/') : `${targetDir}/${segments.join('/')}`;
  // 去首尾多余斜杠
  const cleaned = withTarget.replace(/^\/+/, '').replace(/\/+$/, '');

  // 拼接后等于库根 → 拒
  if (cleaned === '' || cleaned === targetDir) {
    // 等于 targetDir 意味着用户输入空或只写了斜杠 → PATH_EMPTY
    if (trimmed === '' || trimmed.replace(/\//g, '') === '') {
      return { ok: false, reason: 'PATH_EMPTY', message: '请输入文件名' };
    }
    return { ok: false, reason: 'PATH_EMPTY', message: '请输入文件名' };
  }

  return { ok: true, rel: cleaned, targetDir, baseInput: trimmed };
}
