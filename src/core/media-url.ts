/** 库内媒体相对路径 → `media://localhost/` 只读协议 URL（逐段编码，保留分层）。 */
export function mediaUrlForPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/').map((segment) => encodeURIComponent(segment));
  return `media://localhost/${segments.join('/')}`;
}
