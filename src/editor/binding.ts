/**
 * P5-C3：浮窗 ↔ 文档绑定注册表（纯逻辑，不引 React / CodeMirror）。
 *
 * 三条硬约束：
 * 1. 一窗一文档：windowId 唯一绑定一个 path，且一个 path 同时只能被一个窗绑定
 *    （windowId 本身即 path，此处做二次守卫，防止未来入口变化引入同文档双实例）。
 * 2. 实例 token：每次 claim 返回 token，release 必须携带匹配 token 才生效，
 *    防止 React StrictMode 双挂载时旧实例的清理误释放新实例的绑定。
 *    StrictMode 下旧实例清理会先等待 openDoc 落定，期间新实例可能同窗重挂载；
 *    因此清理必须在等待前同步 `retire`，新挂载的 claim 会拿到新 token，
 *    旧 release 因 token 失配而失效，绝不解除新实例的绑定。
 * 3. 关窗安全顺序：先 saveDoc，成功才 closeDoc；失败/冲突保留 dirty 文档，
 *    由调用方上报 notice（PLAN §9.4 禁止静默吞掉写盘失败）。
 * 4. 关窗协调器接管（C4）：`handoff` 后本绑定的卸载清理只注销归属，**不再
 *    save/close**——保存与 closeDoc 已由 app 层协调器完成，避免双重写盘。
 *
 * 不持有文档内容本身，只做归属记账；save/close 经端口注入，便于 Node 单测。
 */

/** 保存结果的最小结构（与 core 的 SaveOutcome 结构兼容）。 */
export interface BindingSaveOutcome {
  readonly ok: boolean;
  readonly error?: { readonly message: string } | null;
  readonly conflict?: unknown;
}

export interface BindingPorts {
  /** 文档当前是否仍在 Core 中打开（外部删除后可能已被关闭）。 */
  readonly hasDoc: (path: string) => boolean;
  readonly saveDoc: (path: string) => Promise<BindingSaveOutcome>;
  readonly closeDoc: (path: string) => void;
}

export type ClaimResult =
  | { readonly ok: true; readonly token: number; readonly path: string }
  | {
      readonly ok: false;
      readonly reason: 'doc-already-bound';
      readonly windowId: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'window-bound-to-other-doc';
      readonly path: string;
    };

export type ReleaseResult =
  | { readonly status: 'ignored' }
  | { readonly status: 'already-closed' }
  | { readonly status: 'handed-off' }
  | { readonly status: 'closed' }
  | { readonly status: 'saved' }
  | {
      readonly status: 'failed';
      readonly error: { readonly message: string } | null;
      readonly conflict: unknown;
    };

export interface BindingRegistry {
  claim(windowId: string, path: string): ClaimResult;
  release(windowId: string, token: number, ports: BindingPorts): Promise<ReleaseResult>;
  /**
   * 标记本实例已退出（卸载清理开始、尚在等待 openDoc 时调用）。
   * 此后同窗 claim 视为新所有者并分配新 token；旧实例的 release 因 token
   * 失配而失效。若没有新挂载，旧实例仍可用原 token 正常 release。
   * token 不匹配或已退休时返回 false。
   */
  retire(windowId: string, token: number): boolean;
  /**
   * 将绑定收尾职责移交关窗协调器：此后 release 只注销归属，不 save/close。
   * token 不匹配（旧挂载）时返回 false，不改变任何状态。
   */
  handoff(windowId: string, token: number): boolean;
  /**
   * 撤销移交（取消关闭、恢复编辑）：release 重新按常规 save/close。
   * token 不匹配时返回 false。
   */
  revokeHandoff(windowId: string, token: number): boolean;
  getPath(windowId: string): string | null;
  getWindowFor(path: string): string | null;
  isOwner(windowId: string, path: string): boolean;
  size(): number;
}

interface Binding {
  readonly windowId: string;
  readonly path: string;
  readonly token: number;
}

/** 创建独立的绑定注册表；生产端用下方单例，测试端可各建各的。 */
export function createBindingRegistry(): BindingRegistry {
  const byWindow = new Map<string, Binding>();
  const byPath = new Map<string, string>();
  /** 已移交给关窗协调器的 windowId；其卸载清理不再 save/close。 */
  const handedOff = new Set<string>();
  /** 已退休的实例 token（旧挂载清理中）；同窗重挂载会换新 token。 */
  const retiredTokens = new Set<number>();
  let nextToken = 1;

  function allocate(windowId: string, path: string): number {
    const token = nextToken;
    nextToken += 1;
    byWindow.set(windowId, { windowId, path, token });
    byPath.set(path, windowId);
    // 同一窗重新挂载（新实例）视为新的收尾职责，清除上次移交代记。
    handedOff.delete(windowId);
    return token;
  }

  function claim(windowId: string, path: string): ClaimResult {
    const existing = byWindow.get(windowId);
    if (existing) {
      if (existing.path === path) {
        if (!retiredTokens.has(existing.token)) {
          // 同一实例的幂等 claim：返回原 token（StrictMode 双调用安全）。
          handedOff.delete(windowId);
          return { ok: true, token: existing.token, path };
        }
        // 旧实例已退休（卸载清理仍在等待 open）：新实例必须是新的所有者。
        retiredTokens.delete(existing.token);
        return { ok: true, token: allocate(windowId, path), path };
      }
      return { ok: false, reason: 'window-bound-to-other-doc', path: existing.path };
    }

    const owner = byPath.get(path);
    if (owner !== undefined && owner !== windowId) {
      return { ok: false, reason: 'doc-already-bound', windowId: owner };
    }

    return { ok: true, token: allocate(windowId, path), path };
  }

  function retire(windowId: string, token: number): boolean {
    const existing = byWindow.get(windowId);
    if (!existing || existing.token !== token) return false;
    if (retiredTokens.has(token)) return false;
    retiredTokens.add(token);
    return true;
  }

  function handoff(windowId: string, token: number): boolean {
    const existing = byWindow.get(windowId);
    if (!existing || existing.token !== token) return false;
    handedOff.add(windowId);
    return true;
  }

  function revokeHandoff(windowId: string, token: number): boolean {
    const existing = byWindow.get(windowId);
    if (!existing || existing.token !== token) return false;
    handedOff.delete(windowId);
    return true;
  }

  async function release(
    windowId: string,
    token: number,
    ports: BindingPorts,
  ): Promise<ReleaseResult> {
    const existing = byWindow.get(windowId);
    if (!existing || existing.token !== token) {
      // 过期 token（旧挂载）或未认领：不触碰文档。
      return { status: 'ignored' };
    }

    const path = existing.path;
    byWindow.delete(windowId);
    if (byPath.get(path) === windowId) byPath.delete(path);
    retiredTokens.delete(token);

    // 协调器已接管保存与 closeDoc：卸载清理只注销归属，避免双重写盘。
    if (handedOff.delete(windowId)) return { status: 'handed-off' };

    // 文档已被外部删除并经 core 关闭：无需保存，直接完成释放。
    if (!ports.hasDoc(path)) return { status: 'already-closed' };

    const outcome = await ports.saveDoc(path);
    if (!outcome.ok) {
      return {
        status: 'failed',
        error: outcome.error ?? null,
        conflict: outcome.conflict ?? null,
      };
    }

    // 保存期间可能发生 StrictMode 重挂载（同一 path 被新实例重新 claim）：
    // 此时不得 closeDoc，否则会拆掉新实例正在使用的文档。
    if (byPath.get(path) !== undefined) return { status: 'saved' };

    ports.closeDoc(path);
    return { status: 'closed' };
  }

  return Object.freeze({
    claim,
    release,
    retire,
    handoff,
    revokeHandoff,
    getPath: (windowId: string) => byWindow.get(windowId)?.path ?? null,
    getWindowFor: (path: string) => byPath.get(path) ?? null,
    isOwner: (windowId: string, path: string) => {
      const binding = byWindow.get(windowId);
      return binding !== undefined && binding.path === path;
    },
    size: () => byWindow.size,
  });
}

/**
 * 生产单例。gate:mutable-exports 禁模块级可变绑定：注册表对外是冻结对象，
 * 可变 Map 封装在工厂闭包内，不导出。
 */
export const editorBindings: BindingRegistry = createBindingRegistry();
