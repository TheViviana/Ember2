/**
 * 运行平台判定：只用于 URL 形式与界面文案的跨平台分支，不做能力探测。
 * Node 测试环境没有 navigator，按 macOS 处理以保持既有断言语义。
 */

function readUserAgent(): string {
  if (typeof navigator === 'undefined') return '';
  const value = navigator.userAgent;
  // Node 21+ 暴露 navigator.userAgent = "Node.js/xx"，不是真实浏览器平台。
  return /^Node\.js\//.test(value) ? '' : value;
}

export function isWindowsPlatform(userAgent: string | null = readUserAgent()): boolean {
  return userAgent !== null && /Windows/i.test(userAgent);
}

export function isMacPlatform(userAgent: string | null = readUserAgent()): boolean {
  if (userAgent === null || userAgent === '') return true;
  return /Mac|iPhone|iPad/i.test(userAgent);
}
