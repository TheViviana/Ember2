/**
 * CR-R2-5：文档正文读取两语义单源。
 *
 * - `readDocSnapshot`：只读磁盘（一次性读取快照），不看编辑器 live 状态；
 * - `readDocText`：编辑器 live 正文优先，未打开的文档回退磁盘快照；
 * - 依赖全部注入，纯逻辑，无 DOM / IPC，可在 node 下测试。
 */

export interface DocTextDeps {
  readonly liveText: (path: string) => string | null;
  readonly readDisk: (path: string) => Promise<string>;
}

/** 只读磁盘：任何调用方都拿不到编辑器里尚未落盘的正文。 */
export function readDocSnapshot(path: string, deps: DocTextDeps): Promise<string> {
  return deps.readDisk(path);
}

/** live 优先、否则磁盘：未打开（或已关闭）的文档走只读快照。 */
export async function readDocText(path: string, deps: DocTextDeps): Promise<string> {
  const live = deps.liveText(path);
  if (live !== null) return live;
  return deps.readDisk(path);
}
