export const DIFF_MAX_LINES = 2000;
export const DIFF_MAX_BYTES = 1024 * 1024;

export type LineDiffType = 'equal' | 'insert' | 'delete';

export interface LineDiffOperation {
  readonly type: LineDiffType;
  readonly text: string;
  readonly oldLine: number | null;
  readonly newLine: number | null;
}

export interface LineDiffResult {
  readonly operations: readonly LineDiffOperation[];
  readonly simplified: boolean;
}

interface DiffChunk {
  readonly type: LineDiffType;
  readonly text: string;
}

const encoder = new TextEncoder();

function splitLines(text: string): readonly string[] {
  if (text.length === 0) return [];
  return text.replace(/\r\n?/g, '\n').split('\n');
}

function mapValue(map: ReadonlyMap<number, number>, key: number): number {
  return map.get(key) ?? 0;
}

function backtrackMyers(
  trace: readonly ReadonlyMap<number, number>[],
  oldLines: readonly string[],
  newLines: readonly string[],
): DiffChunk[] {
  const reversed: DiffChunk[] = [];
  let x = oldLines.length;
  let y = newLines.length;

  for (let depth = trace.length - 1; depth > 0; depth -= 1) {
    const previous = trace[depth - 1];
    if (previous === undefined) break;
    const diagonal = x - y;
    const inserted = diagonal === -depth || (
      diagonal !== depth
      && mapValue(previous, diagonal - 1) < mapValue(previous, diagonal + 1)
    );
    const previousDiagonal = inserted ? diagonal + 1 : diagonal - 1;
    const previousX = mapValue(previous, previousDiagonal);
    const previousY = previousX - previousDiagonal;
    const editX = previousX + (inserted ? 0 : 1);
    const editY = previousY + (inserted ? 1 : 0);

    while (x > editX && y > editY) {
      reversed.push({ type: 'equal', text: oldLines[x - 1] ?? '' });
      x -= 1;
      y -= 1;
    }
    if (inserted) {
      reversed.push({ type: 'insert', text: newLines[previousY] ?? '' });
    } else {
      reversed.push({ type: 'delete', text: oldLines[previousX] ?? '' });
    }
    x = previousX;
    y = previousY;
  }

  while (x > 0 && y > 0) {
    reversed.push({ type: 'equal', text: oldLines[x - 1] ?? '' });
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    reversed.push({ type: 'delete', text: oldLines[x - 1] ?? '' });
    x -= 1;
  }
  while (y > 0) {
    reversed.push({ type: 'insert', text: newLines[y - 1] ?? '' });
    y -= 1;
  }
  reversed.reverse();
  return reversed;
}

/** Myers 最短编辑脚本；trace 只包含中间裁剪区，不接触大版本降级分支。 */
function myers(oldLines: readonly string[], newLines: readonly string[]): DiffChunk[] {
  const maximum = oldLines.length + newLines.length;
  const trace: ReadonlyMap<number, number>[] = [];
  let frontier = new Map<number, number>();

  for (let depth = 0; depth <= maximum; depth += 1) {
    const next = new Map<number, number>();
    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      let x: number;
      if (diagonal === -depth || (
        diagonal !== depth
        && mapValue(frontier, diagonal - 1) < mapValue(frontier, diagonal + 1)
      )) {
        x = mapValue(frontier, diagonal + 1);
      } else {
        x = mapValue(frontier, diagonal - 1) + 1;
      }
      let y = x - diagonal;
      while (
        x < oldLines.length
        && y < newLines.length
        && oldLines[x] === newLines[y]
      ) {
        x += 1;
        y += 1;
      }
      next.set(diagonal, x);
      if (x >= oldLines.length && y >= newLines.length) {
        trace.push(next);
        return backtrackMyers(trace, oldLines, newLines);
      }
    }
    trace.push(next);
    frontier = next;
  }
  return [];
}

/** 每个变更块先删后增，替换在 UI 中稳定呈现为旧行 followed by 新行。 */
function deletesBeforeInserts(chunks: readonly DiffChunk[]): DiffChunk[] {
  const result: DiffChunk[] = [];
  let index = 0;
  while (index < chunks.length) {
    const chunk = chunks[index];
    if (chunk === undefined) break;
    if (chunk.type === 'equal') {
      result.push(chunk);
      index += 1;
      continue;
    }
    const block: DiffChunk[] = [];
    while (index < chunks.length && chunks[index]?.type !== 'equal') {
      const changed = chunks[index];
      if (changed !== undefined) block.push(changed);
      index += 1;
    }
    result.push(...block.filter((item) => item.type === 'delete'));
    result.push(...block.filter((item) => item.type === 'insert'));
  }
  return result;
}

function withLineNumbers(chunks: readonly DiffChunk[]): LineDiffResult {
  let oldLine = 1;
  let newLine = 1;
  const operations = chunks.map((chunk): LineDiffOperation => {
    if (chunk.type === 'equal') {
      const operation = { type: chunk.type, text: chunk.text, oldLine, newLine };
      oldLine += 1;
      newLine += 1;
      return operation;
    }
    if (chunk.type === 'delete') {
      const operation = { type: chunk.type, text: chunk.text, oldLine, newLine: null };
      oldLine += 1;
      return operation;
    }
    const operation = { type: chunk.type, text: chunk.text, oldLine: null, newLine };
    newLine += 1;
    return operation;
  });
  return { operations, simplified: false };
}

function wholeFileDiff(oldLines: readonly string[], newLines: readonly string[]): LineDiffResult {
  return withLineNumbers([
    ...oldLines.map((text): DiffChunk => ({ type: 'delete', text })),
    ...newLines.map((text): DiffChunk => ({ type: 'insert', text })),
  ]);
}

export function diffLines(beforeText: string, afterText: string): LineDiffResult {
  const tooManyBytes = encoder.encode(beforeText).byteLength > DIFF_MAX_BYTES
    || encoder.encode(afterText).byteLength > DIFF_MAX_BYTES;
  const oldLines = splitLines(beforeText);
  const newLines = splitLines(afterText);
  if (tooManyBytes || oldLines.length > DIFF_MAX_LINES || newLines.length > DIFF_MAX_LINES) {
    return { ...wholeFileDiff(oldLines, newLines), simplified: true };
  }

  let prefix = 0;
  while (
    prefix < oldLines.length
    && prefix < newLines.length
    && oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const middle = oldMiddle.length === 0
    ? newMiddle.map((text): DiffChunk => ({ type: 'insert', text }))
    : newMiddle.length === 0
      ? oldMiddle.map((text): DiffChunk => ({ type: 'delete', text }))
      : deletesBeforeInserts(myers(oldMiddle, newMiddle));
  const prefixChunks = oldLines.slice(0, prefix).map((text): DiffChunk => ({ type: 'equal', text }));
  const suffixChunks = oldLines.slice(oldLines.length - suffix).map((text): DiffChunk => ({ type: 'equal', text }));
  return withLineNumbers([...prefixChunks, ...middle, ...suffixChunks]);
}
