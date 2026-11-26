import { isWindowsPlatform } from './platform.ts';

/**
 * 库内媒体相对路径 → 只读协议 URL（逐段编码，保留分层）。
 *
 * Windows 的 WebView2 把自定义协议映射为 `http://<scheme>.localhost`，
 * macOS / Linux 仍是 `<scheme>://localhost`；两种形式由 Rust 端同一处理器响应。
 */
export function mediaUrlForPath(path: string, windows = isWindowsPlatform()): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/').map((segment) => encodeURIComponent(segment));
  const origin = windows ? 'http://media.localhost' : 'media://localhost';
  return `${origin}/${segments.join('/')}`;
}
