/**
 * P5-C1：崩溃恢复判定纯函数测试（W3=C 比较半式；N1 接口抽象）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectUnflushedChanges } from '../../src/windows/crash-detector.ts';
import type { DiskMarker, VersionToken } from '../../src/windows/crash-detector.ts';

void test('全部一致：返回空数组', () => {
  const latest: VersionToken[] = [
    { docId: 'a', token: 'h1' },
    { docId: 'b', token: 'h2' },
  ];
  const onDisk: DiskMarker[] = [
    { docId: 'a', hash: 'h1' },
    { docId: 'b', hash: 'h2' },
  ];
  assert.deepEqual(detectUnflushedChanges(latest, onDisk), []);
});

void test('部分不一致：仅返回 token ≠ hash 的 docId', () => {
  const latest: VersionToken[] = [
    { docId: 'a', token: 'h1' },
    { docId: 'b', token: 'dirty' },
  ];
  const onDisk: DiskMarker[] = [
    { docId: 'a', hash: 'h1' },
    { docId: 'b', hash: 'h2' },
  ];
  assert.deepEqual(detectUnflushedChanges(latest, onDisk), ['b']);
});

void test('单边存在：latest 有但磁盘无 → 不一致', () => {
  const latest: VersionToken[] = [{ docId: 'a', token: 'h1' }];
  assert.deepEqual(detectUnflushedChanges(latest, []), ['a']);
});

void test('单边存在：磁盘有但 latest 无 → 不一致', () => {
  const onDisk: DiskMarker[] = [{ docId: 'a', hash: 'h1' }];
  assert.deepEqual(detectUnflushedChanges([], onDisk), ['a']);
});

void test('空输入两边：返回空', () => {
  assert.deepEqual(detectUnflushedChanges([], []), []);
});

void test('重复 docId 归并：同一 docId 多次出现只判一次', () => {
  const latest: VersionToken[] = [
    { docId: 'a', token: 'h1' },
    { docId: 'a', token: 'h1' },
    { docId: 'b', token: 'h2' },
  ];
  const onDisk: DiskMarker[] = [
    { docId: 'a', hash: 'h1' },
    { docId: 'b', hash: 'h2' },
  ];
  assert.deepEqual(detectUnflushedChanges(latest, onDisk), []);
});

void test('结果按 docId 字典序排序，确定性输出', () => {
  const latest: VersionToken[] = [
    { docId: 'z', token: 'dz' },
    { docId: 'a', token: 'da' },
    { docId: 'm', token: 'dm' },
  ];
  assert.deepEqual(detectUnflushedChanges(latest, []), ['a', 'm', 'z']);
});

void test('混合：一致 + 不一致 + 单边，全集正确', () => {
  const latest: VersionToken[] = [
    { docId: 'a', token: 'same' }, // 一致
    { docId: 'b', token: 'dirty' }, // 不一致
    { docId: 'c', token: 'only-mem' }, // 单边（latest）
  ];
  const onDisk: DiskMarker[] = [
    { docId: 'a', hash: 'same' },
    { docId: 'b', hash: 'clean' },
    { docId: 'd', hash: 'only-disk' }, // 单边（disk）
  ];
  assert.deepEqual(detectUnflushedChanges(latest, onDisk), ['b', 'c', 'd']);
});
