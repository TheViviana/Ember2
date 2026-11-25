/**
 * CR-20261119-14：library-list-reducer 纯状态机测试。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIBRARY_LIST_INITIAL,
  libraryListReducer,
  type LibraryListAction,
  type LibraryListState,
} from '../../../src/features/library/library-list-reducer.ts';
import type { LibraryDto } from '../../../src/types/ipc.ts';

function dto(overrides: Partial<LibraryDto> = {}): LibraryDto {
  return {
    id: 'A',
    name: '库 A',
    path: '/tmp/a',
    current: false,
    available: true,
    ...overrides,
  };
}

function run(state: LibraryListState, action: LibraryListAction): LibraryListState {
  return libraryListReducer(state, action);
}

function requireOk(state: LibraryListState): { items: readonly LibraryDto[] } {
  assert.equal(state.kind, 'ok');
  assert.ok(state.kind === 'ok');
  return state;
}

void describe('libraryListReducer', () => {
  void it('初始 idle / OPEN → loading / REFRESH → ok / CLOSE → idle', () => {
    const s0 = LIBRARY_LIST_INITIAL;
    assert.equal(s0.kind, 'idle');

    const s1 = run(s0, { type: 'OPEN' });
    assert.equal(s1.kind, 'loading');

    const s2 = run(s1, { type: 'REFRESH', items: [dto()] });
    const okState = requireOk(s2);
    assert.equal(okState.items.length, 1);

    const s3 = run(s2, { type: 'CLOSE' });
    assert.equal(s3.kind, 'idle');
  });

  void it('REFRESH_FAIL → error / 再次 OPEN → loading 覆盖', () => {
    const s0 = run(LIBRARY_LIST_INITIAL, { type: 'OPEN' });
    const s1 = run(s0, { type: 'REFRESH_FAIL', message: 'E_IO' });
    assert.equal(s1.kind, 'error');
    assert.equal(s1.message, 'E_IO');

    const s2 = run(s1, { type: 'OPEN' });
    assert.equal(s2.kind, 'loading');
  });

  void it('加载中 REFRESH → items 全量替换（不手动 splice）', () => {
    const s0 = run(LIBRARY_LIST_INITIAL, { type: 'OPEN' });
    const s1 = run(s0, { type: 'REFRESH', items: [dto({ id: 'A' })] });
    assert.equal(requireOk(s1).items.length, 1);

    // 添加库后：统一走 REFRESH 全量替换——断言这条语义
    const afterAdd = run(s1, {
      type: 'REFRESH',
      items: [dto({ id: 'A' }), dto({ id: 'B' })],
    });
    const okState = requireOk(afterAdd);
    assert.equal(okState.items.length, 2);
    assert.ok(okState.items.some((x) => x.id === 'B'));
  });

  void it('移除库后：REFRESH 返回的 items 直接替换', () => {
    const s0 = run(LIBRARY_LIST_INITIAL, { type: 'OPEN' });
    const s1 = run(s0, { type: 'REFRESH', items: [dto({ id: 'A' }), dto({ id: 'B' })] });
    assert.equal(requireOk(s1).items.length, 2);

    // 移除 B：Rust 返回完整列表，直接替换
    const afterRemove = run(s1, { type: 'REFRESH', items: [dto({ id: 'A' })] });
    const okState = requireOk(afterRemove);
    assert.equal(okState.items.length, 1);
    assert.equal(okState.items[0]!.id, 'A');
  });

  void it('error 后 REFRESH 仍能恢复 ok', () => {
    const s0 = run(LIBRARY_LIST_INITIAL, { type: 'OPEN' });
    const s1 = run(s0, { type: 'REFRESH_FAIL', message: 'E_IO' });
    assert.equal(s1.kind, 'error');

    const s2 = run(s1, { type: 'REFRESH', items: [dto()] });
    assert.equal(requireOk(s2).items.length, 1);
  });
});
