/**
 * P5-C1：WindowManager 核心纯逻辑测试。
 * 覆盖方案 §6 全部场景 + T5 的「低于最小尺寸」「视口小于最小尺寸」两边界。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WindowManager,
  clampGeometry,
  computeCascadeLayout,
  computeDefaultGeometry,
  computeDefaultPosition,
  computeTileLayout,
  hasTileOverlap,
  DEFAULT_WINDOW_SIZES,
  MIN_WINDOW_HEIGHT,
  MIN_WINDOW_WIDTH,
  WINDOW_BASE_Z_INDEX,
  type Geometry,
  type Viewport,
} from '../../src/windows/manager.ts';

const VP: Viewport = { width: 1000, height: 800 };

void test('默认位置：水平居中 + 垂直中心落在视口 45%（T1 修正公式 y = h*0.45 - height/2）', () => {
  const pos = computeDefaultPosition({ width: 720, height: 480 }, VP);
  assert.equal(pos.x, (1000 - 720) / 2);
  // 正确值 800*0.45 - 480/2 = 360 - 240 = 120；旧错公式 800*0.45 - 480*0.45 = 144
  assert.equal(pos.y, 120);
});

void test('默认位置：不同高度验证除的是 height/2 而非 height*0.45', () => {
  assert.equal(computeDefaultPosition({ width: 100, height: 200 }, VP).y, 360 - 100);
  assert.equal(computeDefaultPosition({ width: 100, height: 100 }, VP).y, 360 - 50);
});

void test('computeDefaultGeometry：editor 默认 720×480 + 默认位置 + 钳制', () => {
  const g = computeDefaultGeometry('editor', VP);
  assert.deepEqual(g, { x: 140, y: 120, width: 720, height: 480 });
});

void test('T5 尺寸钳制：低于最小尺寸抬到 MIN_W/MIN_H', () => {
  const g = clampGeometry({ x: 50, y: 50, width: 200, height: 150 }, VP);
  assert.equal(g.width, MIN_WINDOW_WIDTH);
  assert.equal(g.height, MIN_WINDOW_HEIGHT);
  assert.equal(g.x, 50);
  assert.equal(g.y, 50);
});

void test('T5 尺寸钳制：超过视口尺寸压到视口尺寸', () => {
  const g = clampGeometry({ x: 0, y: 0, width: 2000, height: 2000 }, VP);
  assert.equal(g.width, 1000);
  assert.equal(g.height, 800);
  assert.equal(g.x, 0);
  assert.equal(g.y, 0);
});

void test('T5 边界：视口小于最小尺寸 → 尺寸保持 MIN，位置钳到左上角', () => {
  const g = clampGeometry({ x: 10, y: 10, width: 500, height: 500 }, { width: 300, height: 200 });
  assert.equal(g.width, MIN_WINDOW_WIDTH);
  assert.equal(g.height, MIN_WINDOW_HEIGHT);
  assert.equal(g.x, 0);
  assert.equal(g.y, 0);
});

void test('T5 顺序：先钳尺寸后钳位置，避免尺寸放大后位置越界', () => {
  // width 从 100 抬到 360 后，x=700 会越界（700+360>1000），必须被钳到 640
  const g = clampGeometry({ x: 700, y: 0, width: 100, height: 100 }, VP);
  assert.equal(g.width, 360);
  assert.equal(g.x, 640);
  assert.equal(g.x + g.width, 1000);
});

void test('位置钳制：给定越界 x/y 被钳回视口内', () => {
  const g = clampGeometry({ x: 900, y: 700, width: 720, height: 480 }, VP);
  assert.equal(g.x, 1000 - 720);
  assert.equal(g.y, 800 - 480);
});

void test('边界：视口 0×0 与负尺寸不抛，归一到 MIN + 左上角', () => {
  const a = clampGeometry({ x: 0, y: 0, width: 720, height: 480 }, { width: 0, height: 0 });
  assert.deepEqual(a, { x: 0, y: 0, width: MIN_WINDOW_WIDTH, height: MIN_WINDOW_HEIGHT });
  const b = clampGeometry({ x: 0, y: 0, width: -100, height: -50 }, VP);
  assert.equal(b.width, MIN_WINDOW_WIDTH);
  assert.equal(b.height, MIN_WINDOW_HEIGHT);
});

void test('位置记忆优先级：rememberedById > 内容类型默认 > 全局默认', () => {
  const wm = new WindowManager();
  // 1) 首次打开用默认
  const first = wm.open('a', 'editor', VP);
  assert.equal(first.geometry.width, 720);

  // 2) setGeometry 后记入记忆，关闭再开沿用记忆
  const remembered: Geometry = { x: 33, y: 44, width: 500, height: 400 };
  assert.equal(wm.setGeometry('a', remembered, VP), true);
  assert.equal(wm.close('a'), true);
  const reopened = wm.open('a', 'editor', VP);
  assert.equal(reopened.geometry.x, 33);
  assert.equal(reopened.geometry.y, 44);
  assert.equal(reopened.geometry.width, 500);

  // 3) 记忆在会话内跨 close/reopen 保留（W2=C）；不同 id 仍取默认
  assert.equal(wm.close('a'), true);
  const again = wm.open('a', 'editor', VP);
  assert.equal(again.geometry.x, 33, '同 id 重开沿用记忆');
  const other = wm.open('b', 'editor', VP);
  assert.equal(other.geometry.x, 140, '不同 id 取默认');
});

void test('setDefaultGeometry：实例级自定义默认覆盖模块常量', () => {
  const wm = new WindowManager();
  wm.setDefaultGeometry('ai', { x: 0, y: 0, width: 400, height: 300 });
  const g = wm.open('p1', 'ai', VP).geometry;
  assert.equal(g.width, 400);
  assert.equal(g.height, 300);
  // 位置仍走默认居中公式（基于自定义尺寸），非 (0,0)
  assert.equal(g.x, (1000 - 400) / 2);
});

void test('z 序：数组末尾 = 最顶层，getZIndex 随顺序派生（无 zOrder 冗余字段）', () => {
  const wm = new WindowManager();
  wm.open('a', 'editor', VP);
  wm.open('b', 'editor', VP);
  wm.open('c', 'editor', VP);
  assert.equal(wm.getZIndex('a'), WINDOW_BASE_Z_INDEX + 0);
  assert.equal(wm.getZIndex('c'), WINDOW_BASE_Z_INDEX + 2);
  assert.equal(wm.getZIndex('nope'), -1);
});

void test('焦点/z 序解耦：focus 不动顺序，raiseToTop 不改焦点，activate 两者皆改', () => {
  const wm = new WindowManager();
  wm.open('a', 'editor', VP);
  wm.open('b', 'editor', VP);
  wm.open('c', 'editor', VP); // 顺序 [a,b,c]，焦点 c

  // focus(a)：焦点变 a，顺序不变
  assert.equal(wm.focus('a'), true);
  assert.equal(wm.snapshot().focusedId, 'a');
  assert.equal(wm.getZIndex('a'), WINDOW_BASE_Z_INDEX + 0);

  // raiseToTop(a)：顺序变 [b,c,a]，焦点仍为 a（不被改）
  assert.equal(wm.raiseToTop('a'), true);
  assert.equal(wm.getZIndex('a'), WINDOW_BASE_Z_INDEX + 2);
  assert.equal(wm.snapshot().focusedId, 'a');

  // activate(b)：顺序变 [c,a,b]，焦点变 b
  assert.equal(wm.activate('b'), true);
  assert.equal(wm.getZIndex('b'), WINDOW_BASE_Z_INDEX + 2);
  assert.equal(wm.snapshot().focusedId, 'b');
});

void test('focus 不存在的 id 返回 false 且不发变更', () => {
  const wm = new WindowManager();
  let calls = 0;
  wm.subscribe(() => {
    calls += 1;
  });
  assert.equal(wm.focus('ghost'), false);
  assert.equal(calls, 0);
});

void test('focusNext / focusPrev：循环 + 跳最小化', () => {
  const wm = new WindowManager();
  wm.open('a', 'editor', VP);
  wm.open('b', 'editor', VP);
  wm.open('c', 'editor', VP);
  wm.focus('a');

  assert.equal(wm.focusNext(), true);
  assert.equal(wm.snapshot().focusedId, 'b');
  assert.equal(wm.focusNext(), true);
  assert.equal(wm.snapshot().focusedId, 'c');
  assert.equal(wm.focusNext(), true);
  assert.equal(wm.snapshot().focusedId, 'a'); // 循环回 a

  wm.minimize('b');
  assert.equal(wm.focusNext(), true);
  assert.equal(wm.snapshot().focusedId, 'c'); // 跳过 b
  assert.equal(wm.focusPrev(), true);
  assert.equal(wm.snapshot().focusedId, 'a'); // 反向跳 b
});

void test('close：移除记录，焦点顺势落到新的最顶层', () => {
  const wm = new WindowManager();
  wm.open('a', 'editor', VP);
  wm.open('b', 'editor', VP);
  assert.equal(wm.snapshot().focusedId, 'b');
  assert.equal(wm.close('b'), true);
  assert.equal(wm.size, 1);
  assert.equal(wm.snapshot().focusedId, 'a');
  assert.equal(wm.close('a'), true);
  assert.equal(wm.snapshot().focusedId, null);
  assert.equal(wm.close('a'), false);
});

void test('tile：n=1..6 网格由单公式派生，无矛盾特例', () => {
  const check = (n: number, cols: number, rows: number): void => {
    const ids = Array.from({ length: n }, (_, i) => `w${i}`);
    const layout = computeTileLayout(ids, VP);
    assert.equal(layout.size, n, `n=${n} 应分配 ${n} 个窗口`);
    // 全部在视口内（经 clampGeometry 保证）
    for (const g of layout.values()) {
      assert.ok(g.x >= 0 && g.y >= 0);
      assert.ok(g.x + g.width <= 1000 + 1e-9);
      assert.ok(g.y + g.height <= 800 + 1e-9);
    }
    // row-major 填序：第 i 个的列 = i % cols
    const first = layout.get(ids[0]!);
    assert.ok(first);
    assert.equal(first.x, 0);
    assert.equal(first.y, 0);
    if (n > 1) {
      const second = layout.get(ids[1]!);
      assert.ok(second);
      // 第二个在第 1 列：x = cellW + gap；cellW = (1000 - 8*(cols-1))/cols
      const cellW = (1000 - 8 * (cols - 1)) / cols;
      assert.equal(second.x, cellW + 8);
    }
    // 行数验证：第 n 个（最后一个）的行
    const last = layout.get(ids[n - 1]!);
    assert.ok(last);
    const cellH = (800 - 8 * (rows - 1)) / rows;
    const lastRow = Math.floor((n - 1) / cols);
    assert.equal(last.y, lastRow * (cellH + 8));
  };
  check(1, 1, 1);
  check(2, 2, 1);
  check(3, 2, 2);
  check(4, 2, 2);
  check(5, 3, 2);
  check(6, 3, 2);
});

void test('tile：空集合返回空 map，不抛', () => {
  assert.equal(computeTileLayout([], VP).size, 0);
});

void test('tile 集成：WindowManager.tile 只改几何不动 z 序/焦点', () => {
  const wm = new WindowManager();
  wm.open('a', 'editor', VP);
  wm.open('b', 'editor', VP);
  wm.focus('a');
  const zBefore = wm.getZIndex('a');
  assert.equal(wm.tile(['a', 'b'], VP), true);
  assert.equal(wm.getZIndex('a'), zBefore, '平铺不得改 z 序');
  assert.equal(wm.snapshot().focusedId, 'a', '平铺不得改焦点');
  // 两窗宽度之和（含间隙）应铺满视口
  const ga = wm.snapshot().windows.find((w) => w.id === 'a')?.geometry;
  const gb = wm.snapshot().windows.find((w) => w.id === 'b')?.geometry;
  assert.ok(ga && gb);
  assert.equal(ga.x, 0);
  assert.equal(gb.x + gb.width, 1000);
});

void test('cascade：每窗右下偏移 step，到边界钳制', () => {
  const layout = computeCascadeLayout(['a', 'b', 'c'], VP);
  const base = computeDefaultPosition(DEFAULT_WINDOW_SIZES.editor, VP);
  const a = layout.get('a');
  const b = layout.get('b');
  const c = layout.get('c');
  assert.ok(a && b && c);
  assert.equal(a.x, base.x);
  assert.equal(a.y, base.y);
  assert.equal(b.x, base.x + 28);
  assert.equal(b.y, base.y + 28);
  assert.equal(c.x, base.x + 56);
  assert.equal(c.y, base.y + 56);
});

void test('cascade：大 n 时偏移越界被钳制不抛', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `w${i}`);
  const layout = computeCascadeLayout(ids, VP);
  for (const g of layout.values()) {
    assert.ok(g.x >= 0 && g.y >= 0);
    assert.ok(g.x + g.width <= 1000 + 1e-9);
  }
});

void test('边界：0 / 1 / 多窗口不抛，snapshot 稳定', () => {
  const wm = new WindowManager();
  assert.equal(wm.size, 0);
  assert.deepEqual(wm.snapshot().windows, []);
  assert.equal(wm.snapshot().focusedId, null);
  assert.equal(wm.focusNext(), false);

  wm.open('only', 'editor', VP);
  assert.equal(wm.size, 1);
  assert.equal(wm.focusNext(), true);
  assert.equal(wm.snapshot().focusedId, 'only'); // 单窗循环回自己

  for (let i = 0; i < 25; i += 1) wm.open(`m${i}`, 'editor', VP);
  assert.equal(wm.size, 26);
  assert.equal(wm.tile(wm.snapshot().windows.map((w) => w.id), VP), true);
});

void test('subscribe：变更触发监听，取消订阅后不再触发', () => {
  const wm = new WindowManager();
  let count = 0;
  const off = wm.subscribe(() => {
    count += 1;
  });
  wm.open('a', 'editor', VP);
  assert.equal(count, 1);
  off();
  wm.open('b', 'editor', VP);
  assert.equal(count, 1, '取消订阅后不应再触发');
});

void test('snapshot：两次快照引用稳定，变更后才换引用（useSyncExternalStore 契约）', () => {
  const wm = new WindowManager();
  wm.open('a', 'editor', VP);
  const first = wm.snapshot();
  const second = wm.snapshot();
  assert.equal(first, second, '未变更时应返回同一缓存引用');
  wm.focus('a');
  assert.notEqual(wm.snapshot(), first, '变更后应换引用');
});

void test('hasTileOverlap：小视口 MIN 抬升致相邻重叠，大视口不重叠', () => {
  const small: Viewport = { width: 1000, height: 800 };
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const layout = computeTileLayout(ids, small);
  for (const geo of layout.values()) {
    assert.ok(geo.width >= MIN_WINDOW_WIDTH, `width ${geo.width} 小于最小宽度`);
    assert.ok(geo.height >= MIN_WINDOW_HEIGHT, `height ${geo.height} 小于最小高度`);
  }
  // n=5 @ 1000×800：cols=3，cellW=328 < 360 → clamp 放大到 360 → 相邻重叠
  assert.equal(hasTileOverlap(ids, small), true);
  // n=2 @ 1000×800：cols=2，cellW=496 ≥ 360 → 不重叠
  assert.equal(hasTileOverlap(['a', 'b'], small), false);
  assert.equal(hasTileOverlap([], small), false);
  assert.equal(hasTileOverlap(['a'], small), false);
});

void test('open：已存在且最小化的窗口再次 open 会先 restore 再激活', () => {
  const wm = new WindowManager();
  wm.open('a', 'editor', VP);
  wm.minimize('a');
  assert.equal(wm.snapshot().windows.find((w) => w.id === 'a')?.minimized, true);

  const reopened = wm.open('a', 'editor', VP);
  assert.equal(reopened.minimized, false, '再次 open 应还原最小化窗');
  assert.equal(wm.snapshot().focusedId, 'a');
  assert.equal(wm.size, 1, '不重复创建记录');
});

void test('C3 契约：同一 path（文档）二次 open 不产生第二个窗，只激活既有窗', () => {
  const wm = new WindowManager();
  wm.open('a.md', 'editor', VP);
  const first = wm.snapshot();
  assert.equal(wm.size, 1);

  const again = wm.open('a.md', 'editor', VP);
  assert.equal(wm.size, 1, '同一 path 不得产生第二个记录');
  assert.equal(wm.snapshot().windows.length, 1);
  assert.equal(again.id, 'a.md');
  assert.notEqual(wm.snapshot(), first, '再次 open 仍须 emit（激活既有窗）');

  wm.minimize('a.md');
  assert.equal(wm.snapshot().windows[0]?.minimized, true);
  const reopened = wm.open('a.md', 'editor', VP);
  assert.equal(reopened.minimized, false, '最小化后再次 open 应还原');
  assert.equal(wm.size, 1);
  assert.equal(wm.snapshot().focusedId, 'a.md');
});

// ---------------------------------------------------------------- P1 回归
//
// 缺陷：最小化焦点窗时 `setMinimized` 用 `focusNext()` 代替 `emit()`；当没有其他
// 可聚焦窗口（唯一窗口 / 最后一个可聚焦窗口）时 `cycleFocus` 返回 false 且不 emit，
// 快照缓存不失效 → useSyncExternalStore 订阅方拿不到新快照 → UI 卡在最小化前。
// 下面两条必须在旧实现上报红，修复后转绿。

void test('P1 回归：最小化唯一窗口必须 emit——快照换引用且 minimized=true', () => {
  const wm = new WindowManager();
  wm.open('a', 'editor', VP);

  // 先填充快照缓存，模拟渲染层已订阅并持有当前快照。
  const filled = wm.snapshot();
  assert.equal(filled.windows.find((w) => w.id === 'a')?.minimized, false);

  assert.equal(wm.minimize('a'), true);

  const after = wm.snapshot();
  assert.notEqual(after, filled, '最小化唯一窗口后快照必须换引用（旧实现因 focusNext 无候选漏 emit）');
  assert.equal(after.windows.find((w) => w.id === 'a')?.minimized, true);
  assert.equal(after.focusedId, null, 'F1：唯一窗口最小化后不得保留指向最小化窗的焦点');
});

void test('P1 回归：依次最小化 A/B，最后一个无候选时仍必须换快照引用', () => {
  const wm = new WindowManager();
  wm.open('a', 'editor', VP);
  wm.open('b', 'editor', VP); // 焦点在 b
  wm.snapshot(); // 填充缓存

  // 非焦点窗最小化走 else 分支 emit，缓存失效。
  assert.equal(wm.minimize('a'), true);
  const filled = wm.snapshot(); // 重新填充缓存
  assert.equal(filled.windows.find((w) => w.id === 'a')?.minimized, true);
  assert.equal(filled.windows.find((w) => w.id === 'b')?.minimized, false);

  // 焦点窗最小化且已无其他可聚焦窗口：旧实现此处不 emit。
  assert.equal(wm.minimize('b'), true);

  const after = wm.snapshot();
  assert.notEqual(after, filled, '最后一个可聚焦窗口最小化后快照必须换引用');
  assert.equal(after.windows.find((w) => w.id === 'b')?.minimized, true);
  assert.equal(after.windows.every((w) => w.minimized), true);
  assert.equal(after.focusedId, null, '最后可聚焦窗口最小化后焦点必须清空');
})

void test('F2：无可聚焦窗口后 restore 不自动夺焦', () => {
  const wm = new WindowManager();
  wm.open('a', 'editor', VP);
  wm.minimize('a');
  assert.equal(wm.snapshot().focusedId, null);

  assert.equal(wm.restore('a'), true);
  assert.equal(wm.snapshot().windows.find((w) => w.id === 'a')?.minimized, false);
  assert.equal(wm.snapshot().focusedId, null);
});

void test('F3：close 焦点窗时跳过最小化窗，聚焦最顶层非最小化窗', () => {
  const wm = new WindowManager();
  wm.open('a', 'editor', VP);
  wm.open('c', 'editor', VP);
  wm.open('b', 'editor', VP);
  wm.minimize('c');

  assert.equal(wm.snapshot().focusedId, 'b');
  assert.equal(wm.close('b'), true);
  assert.equal(wm.snapshot().focusedId, 'a');
});

void test('F4：close 焦点窗后其余窗口均最小化时清空焦点', () => {
  const wm = new WindowManager();
  wm.open('a', 'editor', VP);
  wm.open('b', 'editor', VP);
  wm.minimize('a');

  assert.equal(wm.close('b'), true);
  assert.equal(wm.snapshot().focusedId, null);
});

void test('F5：close 非焦点窗不影响当前焦点', () => {
  const wm = new WindowManager();
  wm.open('a', 'editor', VP);
  wm.open('b', 'editor', VP);

  assert.equal(wm.close('a'), true);
  assert.equal(wm.snapshot().focusedId, 'b');
});

// ------------------------------------------------------- 通用契约：快照失效
//
// 强制约束：任何修改 records 字段的 public 方法，调用后 `snapshot()` 必须返回新引用。
// 防止 C3/C4 新增写方法时重蹈「改了状态但忘记 emit」的覆辙（P1 根因）。

void test('契约：所有修改 records 的 public 方法调用后 snapshot() 必须返回新引用', () => {
  interface MutatorCase {
    readonly name: string;
    readonly setup: () => WindowManager;
    readonly run: (wm: WindowManager) => void;
  }

  const twoWindows = (): WindowManager => {
    const wm = new WindowManager();
    wm.open('a', 'editor', VP);
    wm.open('b', 'editor', VP); // 顺序 [a,b]，焦点 b
    return wm;
  };

  const cases: ReadonlyArray<MutatorCase> = [
    { name: 'open', setup: () => new WindowManager(), run: (wm) => void wm.open('a', 'editor', VP) },
    { name: 'close', setup: twoWindows, run: (wm) => void wm.close('a') },
    { name: 'focus', setup: twoWindows, run: (wm) => void wm.focus('a') },
    { name: 'raiseToTop', setup: twoWindows, run: (wm) => void wm.raiseToTop('a') },
    { name: 'activate', setup: twoWindows, run: (wm) => void wm.activate('a') },
    { name: 'focusNext', setup: twoWindows, run: (wm) => void wm.focusNext() },
    { name: 'focusPrev', setup: twoWindows, run: (wm) => void wm.focusPrev() },
    {
      name: 'setGeometry',
      setup: () => {
        const wm = new WindowManager();
        wm.open('a', 'editor', VP);
        return wm;
      },
      run: (wm) => void wm.setGeometry('a', { x: 10, y: 10, width: 500, height: 400 }, VP),
    },
    {
      // 唯一焦点窗最小化 = 无候选路径（P1 根因），确保契约测试也能拦截该缺陷。
      name: 'minimize',
      setup: () => {
        const wm = new WindowManager();
        wm.open('a', 'editor', VP);
        return wm;
      },
      run: (wm) => void wm.minimize('a'),
    },
    {
      name: 'restore',
      setup: () => {
        const wm = new WindowManager();
        wm.open('a', 'editor', VP);
        wm.minimize('a');
        return wm;
      },
      run: (wm) => void wm.restore('a'),
    },
    { name: 'tile', setup: twoWindows, run: (wm) => void wm.tile(['a', 'b'], VP) },
    { name: 'cascade', setup: twoWindows, run: (wm) => void wm.cascade(['a', 'b'], VP) },
  ];

  for (const c of cases) {
    const wm = c.setup();
    const before = wm.snapshot(); // 填充缓存
    c.run(wm);
    assert.notEqual(wm.snapshot(), before, `${c.name} 修改 records 后必须让快照换引用`);
  }
});
