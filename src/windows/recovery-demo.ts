/**
 * P5-C5：异常退出恢复检测演示（进程内，纯逻辑）。
 *
 * 边界（CR-20261117-08 §3 C5）：
 * - 只演示 W3 的「合取」判定与逐条决定交互：崩溃标志 ∧ 末版 token ≠ 磁盘 hash；
 * - 数据全部由调用方注入，不读真实文档、不写盘、不接 machine IPC、不持久化；
 * - 崩溃标志仅存于内存，刷新页面即消失；真实触发递延 P6 前置 machine IPC CR。
 *
 * 复用 `crash-detector.ts` 的比较半式，不复制比较逻辑；在其结果上再做恢复语义过滤：
 * - 两侧都有且不同 → 恢复候选；
 * - 仅末版存在（磁盘缺失）→ 排除，归入冲突处理，不提供恢复按钮；
 * - 仅磁盘存在（无会话末版）→ 排除，没有可恢复的内存版本。
 *
 * 输入契约：`seed` 是一次性注入完整场景，`latest` / `onDisk` 各自内部不得含重复
 * docId；重复即拒绝，模型不替调用方去重（跨两侧同名是正常配对，允许）。
 */
import {
  detectUnflushedChanges,
  type DiskMarker,
  type VersionToken,
} from './crash-detector.ts';

/** 演示场景输入：崩溃标志 + 模拟末版 + 模拟磁盘 hash。 */
export interface DemoSeed {
  readonly crashFlag: boolean;
  readonly latest: ReadonlyArray<VersionToken>;
  readonly onDisk: ReadonlyArray<DiskMarker>;
}

export type RecoveryDemoPhase = 'idle' | 'seeded' | 'scanned' | 'resolved';

export type RecoveryChoice = 'restore' | 'discard';

export type DemoScanReason = 'crashed' | 'no-crash' | 'no-diff';

export type DemoMessageTone = 'info' | 'warning';

export type DemoErrorCode =
  | 'invalid-doc-id'
  | 'duplicate-doc-id'
  | 'invalid-token'
  | 'unresolved-candidates'
  | 'not-seeded'
  | 'already-scanned'
  | 'not-scanned'
  | 'unknown-doc-id'
  | 'already-decided';

/** 单条恢复候选：决定只记在内存，绝不落盘。 */
export interface RecoveryCandidate {
  readonly docId: string;
  readonly latestToken: string;
  readonly diskHash: string;
  readonly decision: RecoveryChoice | null;
}

/** 被排除的差异项：让用户看到「为什么它不在候选里」。 */
export interface ExcludedCandidate {
  readonly docId: string;
  readonly reason: 'missing-on-disk' | 'no-latest-version';
}

export interface RecoveryDemoSnapshot {
  readonly phase: RecoveryDemoPhase;
  readonly crashFlag: boolean;
  readonly scanReason: DemoScanReason | null;
  readonly candidates: ReadonlyArray<RecoveryCandidate>;
  readonly excluded: ReadonlyArray<ExcludedCandidate>;
  readonly message: string | null;
  readonly messageTone: DemoMessageTone;
}

export type DemoResult =
  | { readonly ok: true; readonly snapshot: RecoveryDemoSnapshot }
  | {
      readonly ok: false;
      readonly code: DemoErrorCode;
      readonly message: string;
      readonly snapshot: RecoveryDemoSnapshot;
    };

export interface RecoveryDemo {
  snapshot(): RecoveryDemoSnapshot;
  subscribe(listener: () => void): () => void;
  seed(input: DemoSeed): DemoResult;
  scan(): DemoResult;
  decide(docId: string, choice: RecoveryChoice): DemoResult;
  reset(): DemoResult;
}

interface ValidationFailure {
  readonly code: DemoErrorCode;
  readonly message: string;
}

function validateSeed(input: DemoSeed): ValidationFailure | null {
  const latestIds = new Set<string>();
  for (const version of input.latest) {
    if (version.docId.trim() === '') {
      return { code: 'invalid-doc-id', message: 'seed 输入含空 docId。' };
    }
    if (version.token.trim() === '') {
      return { code: 'invalid-token', message: 'seed 输入的末版 token 不得为空。' };
    }
    if (latestIds.has(version.docId)) {
      return {
        code: 'duplicate-doc-id',
        message: `seed 输入的 latest 含重复 docId：${version.docId}`,
      };
    }
    latestIds.add(version.docId);
  }

  const diskIds = new Set<string>();
  for (const marker of input.onDisk) {
    if (marker.docId.trim() === '') {
      return { code: 'invalid-doc-id', message: 'seed 输入含空 docId。' };
    }
    if (marker.hash.trim() === '') {
      return { code: 'invalid-token', message: 'seed 输入的磁盘 hash 不得为空。' };
    }
    if (diskIds.has(marker.docId)) {
      return {
        code: 'duplicate-doc-id',
        message: `seed 输入的 onDisk 含重复 docId：${marker.docId}`,
      };
    }
    diskIds.add(marker.docId);
  }

  return null;
}

/** 创建独立的演示状态机；生产用下方单例，测试各建各的。 */
export function createRecoveryDemo(): RecoveryDemo {
  const listeners = new Set<() => void>();

  let phase: RecoveryDemoPhase = 'idle';
  let crashFlag = false;
  let latest: VersionToken[] = [];
  let onDisk: DiskMarker[] = [];
  let candidates: RecoveryCandidate[] = [];
  let excluded: ExcludedCandidate[] = [];
  let scanReason: DemoScanReason | null = null;
  let message: string | null = null;
  let messageTone: DemoMessageTone = 'info';
  let cached: RecoveryDemoSnapshot | null = null;

  function buildSnapshot(): RecoveryDemoSnapshot {
    return Object.freeze({
      phase,
      crashFlag,
      scanReason,
      candidates: Object.freeze(
        candidates.map((candidate) => Object.freeze({ ...candidate })),
      ),
      excluded: Object.freeze(excluded.map((item) => Object.freeze({ ...item }))),
      message,
      messageTone,
    });
  }

  function current(): RecoveryDemoSnapshot {
    if (cached === null) cached = buildSnapshot();
    return cached;
  }

  function publish(): void {
    cached = null;
    for (const listener of [...listeners]) listener();
  }

  function setMessage(next: string | null, tone: DemoMessageTone = 'info'): void {
    message = next;
    messageTone = tone;
  }

  function resultOk(): DemoResult {
    publish();
    return { ok: true, snapshot: current() };
  }

  function resultError(code: DemoErrorCode, text: string): DemoResult {
    setMessage(text, 'warning');
    publish();
    return { ok: false, code, message: text, snapshot: current() };
  }

  /**
   * seed 输入校验失败必须无状态变更：不改 message / 不通知订阅者，
   * 直接返回失败前的快照。其余非法操作仍走 resultError 展示提示。
   */
  function validationError(code: DemoErrorCode, text: string): DemoResult {
    return { ok: false, code, message: text, snapshot: current() };
  }

  function seed(input: DemoSeed): DemoResult {
    // 先校验输入，再检查未决候选：非法输入不触碰任何状态（含提示消息）。
    const failure = validateSeed(input);
    if (failure !== null) return validationError(failure.code, failure.message);

    const hasUnresolved =
      phase === 'seeded' ||
      (phase === 'scanned' && candidates.some((candidate) => candidate.decision === null));
    if (hasUnresolved) {
      return resultError('unresolved-candidates', '已有未完成的演示候选，请先处理或重置。');
    }

    crashFlag = input.crashFlag;
    latest = input.latest.map((version) => ({ docId: version.docId, token: version.token }));
    onDisk = input.onDisk.map((marker) => ({ docId: marker.docId, hash: marker.hash }));
    candidates = [];
    excluded = [];
    scanReason = null;
    phase = 'seeded';
    setMessage('演示场景已注入；点击「模拟下次启动」执行扫描。', 'info');
    return resultOk();
  }

  function scan(): DemoResult {
    if (phase === 'idle') return resultError('not-seeded', '请先注入演示场景。');
    if (phase !== 'seeded') {
      return resultError('already-scanned', '当前场景已扫描，请重置后重新注入。');
    }

    if (!crashFlag) {
      candidates = [];
      excluded = [];
      scanReason = 'no-crash';
      phase = 'scanned';
      setMessage('演示场景未设置崩溃标志：即使末版与磁盘不同，也不触发恢复。', 'info');
      return resultOk();
    }

    const latestByDoc = new Map<string, string>();
    for (const version of latest) latestByDoc.set(version.docId, version.token);
    const diskByDoc = new Map<string, string>();
    for (const marker of onDisk) diskByDoc.set(marker.docId, marker.hash);

    const nextCandidates: RecoveryCandidate[] = [];
    const nextExcluded: ExcludedCandidate[] = [];
    for (const docId of detectUnflushedChanges(latest, onDisk)) {
      const latestToken = latestByDoc.get(docId);
      const diskHash = diskByDoc.get(docId);
      if (latestToken === undefined) {
        nextExcluded.push({ docId, reason: 'no-latest-version' });
        continue;
      }
      if (diskHash === undefined) {
        nextExcluded.push({ docId, reason: 'missing-on-disk' });
        continue;
      }
      nextCandidates.push({ docId, latestToken, diskHash, decision: null });
    }

    candidates = nextCandidates;
    excluded = nextExcluded;
    phase = 'scanned';

    if (nextCandidates.length > 0) {
      scanReason = 'crashed';
      setMessage('检测到可恢复候选（演示数据，未写盘）。', 'info');
    } else if (nextExcluded.length > 0) {
      scanReason = 'no-diff';
      setMessage(
        `未发现可恢复变更；${nextExcluded.length} 个单边差异已排除（不属恢复范围）。`,
        'info',
      );
    } else {
      scanReason = 'no-diff';
      setMessage('崩溃标志存在，但末版与磁盘一致：无未落盘变更。', 'info');
    }
    return resultOk();
  }

  function decide(docId: string, choice: RecoveryChoice): DemoResult {
    if (phase !== 'scanned') return resultError('not-scanned', '请先执行扫描。');

    const index = candidates.findIndex((candidate) => candidate.docId === docId);
    if (index === -1) {
      return resultError('unknown-doc-id', `候选列表中不存在该文档：${docId}`);
    }
    const target = candidates[index];
    if (target === undefined) {
      return resultError('unknown-doc-id', `候选列表中不存在该文档：${docId}`);
    }
    if (target.decision !== null) {
      return resultError('already-decided', '该文档的演示决定已记录。');
    }

    candidates = candidates.map((candidate, position) =>
      position === index ? { ...candidate, decision: choice } : candidate,
    );
    const unresolved = candidates.some((candidate) => candidate.decision === null);
    if (unresolved) {
      setMessage(`已记录 ${docId} 的演示决定（未写盘）。`, 'info');
    } else {
      phase = 'resolved';
      setMessage(
        '演示决定已全部记录（未写盘）。真实恢复需 machine IPC 与 history 末版 hash。',
        'info',
      );
    }
    return resultOk();
  }

  function reset(): DemoResult {
    phase = 'idle';
    crashFlag = false;
    latest = [];
    onDisk = [];
    candidates = [];
    excluded = [];
    scanReason = null;
    setMessage(null, 'info');
    return resultOk();
  }

  return Object.freeze({
    snapshot: current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    seed,
    scan,
    decide,
    reset,
  });
}

/**
 * 演示单例。gate:mutable-exports 禁模块级可变绑定：内部状态封装在工厂闭包内，
 * 对外只暴露冻结的命令对象。
 */
export const recoveryDemo: RecoveryDemo = createRecoveryDemo();
