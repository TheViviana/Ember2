/**
 * P5-C1：崩溃恢复判定纯函数（总方案 §5.3 / N1 / W3=C）。
 *
 * W3=C 完整触发条件 = (history 末版 ≠ 磁盘 hash) ∧ (崩溃标志)。
 * 本函数只实现「比较半式」：给定文档末版标识集合与磁盘标识集合，
 * 返回存在未落盘变更的 docId 列表。「崩溃标志」是需持久化的布尔量，
 * 依赖 machine IPC，按裁决 A+B 递延到 P6 前置 CR，不在 C1 范围。
 *
 * 接口按语义抽象（不绑定 HistoryVersion[] 等具体类型）：调用方只依赖
 * `docId / token / hash` 三个字段。当前 token = 文档内容 hash；
 * P6 升级为 history 末版 hash 时，仅取数方变化，本函数签名与调用点不变。
 */

/** 文档末版标识：当前为内容 hash，P6 升级为 history 末版 hash。 */
export interface VersionToken {
  readonly docId: string;
  readonly token: string;
}

/** 磁盘标识：DocState.baseSha（磁盘当前字节 hash）。 */
export interface DiskMarker {
  readonly docId: string;
  readonly hash: string;
}

/**
 * 检测未落盘变更：同 docId 下 token ≠ hash 即不一致；docId 只在一边
 * 出现也算不一致。结果按 docId 字典序排序，保证确定性。
 */
export function detectUnflushedChanges(
  latest: ReadonlyArray<VersionToken>,
  onDisk: ReadonlyArray<DiskMarker>,
): string[] {
  const diskByDoc = new Map<string, string>();
  for (const marker of onDisk) {
    diskByDoc.set(marker.docId, marker.hash);
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const version of latest) {
    if (seen.has(version.docId)) continue;
    seen.add(version.docId);
    const diskHash = diskByDoc.get(version.docId);
    if (diskHash === undefined || diskHash !== version.token) {
      result.push(version.docId);
    }
  }

  for (const marker of onDisk) {
    if (!seen.has(marker.docId)) {
      seen.add(marker.docId);
      result.push(marker.docId);
    }
  }

  return result.sort();
}
