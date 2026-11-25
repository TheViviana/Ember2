/**
 * CR-20261119-14：前端路径格式校验——纯函数。
 *
 * 只做**语法/格式**层校验（绝对路径、无 \0、无控制字符、无嵌套 ...），
 * 不校验存在性/权限/编码。中文、空格、括号、#、Unicode 符号全部放行。
 * 存在性/目录/权限校验由 Rust 侧 canonicalize + is_dir 负责。
 *
 * 走黑名单而非 ASCII 白名单——macOS 路径可以合法包含几乎所有 Unicode，
 * 但不能以 / 以外字符开头（相对路径），不能有 \0、控制字符、.. 段。
 */

/** 必须以 `/` 开头——排除相对路径、`~` 前缀（前端不做 tilde 展开）。 */
const MUST_START_WITH_SLASH_RE = /^\//;

/** null byte — 任何文件系统都不合法。 */
const HAS_NULL_BYTE = /\0/;

/** `..` 段（防嵌套逃逸）。 */
const ILLEGAL_DOT_DOT = /(^|\/)\.\.($|\/)/;

/** 路径分隔符间连续斜杠（//、///）——macOS 语义等价，但前端提前拦省歧义。 */
const CONSECUTIVE_SLASHES = /\/{2,}/;

/** U+0000–U+001F + U+007F–U+009F（DEL + C1 扩展）——遍历字符码检查，避免 ESLint no-control-regex。 */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x0020 || (code >= 0x007F && code <= 0x009F)) return true;
  }
  return false;
}

export interface PathValidationResult {
  readonly ok: boolean;
  readonly message?: string;
}

/** 校验库路径是否符合「绝对路径 + 安全字符」格式。不校验存在性。 */
export function validateLibraryPath(raw: string): PathValidationResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, message: '请输入库路径' };

  if (!MUST_START_WITH_SLASH_RE.test(trimmed)) {
    if (trimmed.startsWith('~')) {
      return { ok: false, message: '不支持 ~ 展开，请输入绝对路径（以 / 开头）' };
    }
    return { ok: false, message: '请输入绝对路径（以 / 开头）' };
  }

  if (HAS_NULL_BYTE.test(trimmed)) {
    return { ok: false, message: '路径包含非法字符' };
  }

  if (hasControlChars(trimmed)) {
    return { ok: false, message: '路径包含非法字符（制表符/控制字符）' };
  }

  if (ILLEGAL_DOT_DOT.test(trimmed)) {
    return { ok: false, message: '路径包含不允许的 .. 段' };
  }

  if (CONSECUTIVE_SLASHES.test(trimmed)) {
    return { ok: false, message: '路径包含连续斜杠' };
  }

  return { ok: true };
}

/** 前端校验通过后再调 Rust；trim 前后空白。 */
export function sanitizeLibraryPath(raw: string): string {
  return raw.trim();
}
