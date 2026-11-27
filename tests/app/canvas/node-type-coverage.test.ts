/**
 * 节点类型覆盖断言（ADR 0003 决策三 / ADR 0002 决策二观测项）。
 *
 * 这不是运行时注册表，也不参与业务逻辑：它只是一张**测试内的声明表**，强迫新增节点类型时
 * 逐个确认五个触点，避免「加了 schema 却忘了渲染/菜单」这类漏改。
 *
 * 新增节点类型时，按顺序确认并回填 `COVERAGE`：
 * 1. schema：`packages/canvas-format/src/types.ts` 的节点接口；`document.ts` 的解析/校验规则；
 * 2. 投影：`src/app/canvas/node-layout.ts#extractNodeViews`（type/kind/尺寸/专属字段）；
 * 3. 工厂：`src/app/canvas/canvas-interactions.ts`（新建入口）；
 * 4. 渲染：`src/app/canvas/node-layer.ts`（专用分支，或明确复用通用卡片）；
 * 5. 菜单：`src/app/canvas/CanvasMenus.tsx`（右键菜单项；无专属项时注明通用）。
 *
 * 触发升级门槛（ADR 0003 决策三）：漏改 ≥2 处，或单次改动 ≥6 文件且跨层，才另立 ADR 讨论注册表。
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CANVAS_NODE_TYPES, type CanvasNodeType } from '#canvas-format';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const TOUCHPOINTS = ['schema', 'projection', 'factory', 'render', 'menu'] as const;
type Touchpoint = (typeof TOUCHPOINTS)[number];

interface Landing {
  /** 触点所在文件（仓库相对路径）；空数组表示该触点当前无落点，必须在 note 说明。 */
  readonly files: readonly string[];
  /** 该类型在这个触点上的具体处理方式；不留空。 */
  readonly note: string;
}

/** `Record<CanvasNodeType, …>` 让新增类型在 typecheck 阶段就报缺项。 */
const COVERAGE: Readonly<Record<CanvasNodeType, Readonly<Record<Touchpoint, Landing>>>> = {
  document: {
    schema: {
      files: ['packages/canvas-format/src/types.ts', 'packages/canvas-format/src/document.ts'],
      note: 'CanvasDocumentNode（docPath 必填）+ document.ts 的 docPath/路径校验',
    },
    projection: {
      files: ['src/app/canvas/node-layout.ts'],
      note: 'extractNodeViews 读取 docPath；autoH 由测量回填',
    },
    factory: {
      files: ['src/app/canvas/canvas-interactions.ts'],
      note: 'createDocumentNode / 拉线落空新建文档节点',
    },
    render: {
      files: ['src/app/canvas/node-layer.ts'],
      note: '文档卡片：标题/摘要/正文预览 + 展开按钮',
    },
    menu: {
      files: ['src/app/canvas/CanvasMenus.tsx'],
      note: '通用节点菜单；「展开」走 onOpenReadMode',
    },
  },
  media: {
    schema: {
      files: ['packages/canvas-format/src/types.ts', 'packages/canvas-format/src/document.ts'],
      note: 'CanvasMediaNode（kind=image|audio|video|doc + path 必填）',
    },
    projection: {
      files: ['src/app/canvas/node-layout.ts'],
      note: 'readMediaView 产出 view.media；非法 kind/path 降级为通用卡片',
    },
    factory: {
      files: ['src/app/canvas/canvas-interactions.ts'],
      note: '媒体节点新建/拖入 Finder 路径',
    },
    render: {
      files: ['src/app/canvas/node-layer.ts'],
      note: '图片/音频/视频/文档四类媒体卡与播放控件',
    },
    menu: {
      files: ['src/app/canvas/CanvasMenus.tsx'],
      note: '通用节点菜单；无媒体专属项',
    },
  },
  text: {
    schema: {
      files: ['packages/canvas-format/src/types.ts', 'packages/canvas-format/src/document.ts'],
      note: 'CanvasTextNode；也是历史坏节点投影时的兜底 type',
    },
    projection: {
      files: ['src/app/canvas/node-layout.ts'],
      note: 'extractNodeViews 的默认 kind（无专属字段）',
    },
    factory: {
      files: [
        'src/app/canvas/canvas-interactions.ts',
        'src/app/canvas/use-connection-node-choice.ts',
      ],
      note: '右键/拉线落空新建文本节点',
    },
    render: {
      files: ['src/app/canvas/node-layer.ts'],
      note: '通用文本卡片（kind=text）',
    },
    menu: {
      files: ['src/app/canvas/CanvasMenus.tsx'],
      note: '「编辑文本」而非「修改标题」',
    },
  },
  group: {
    schema: {
      files: ['packages/canvas-format/src/types.ts', 'packages/canvas-format/src/document.ts'],
      note: 'CanvasGroupNode；parentId 必须引用存在的 group，组不参与连线',
    },
    projection: {
      files: ['src/app/canvas/node-layout.ts'],
      note: 'extractNodeViews 写入 view.group 标记',
    },
    factory: {
      files: [],
      note: '当前无新建入口：group 只做解析/投影，不提供创建命令',
    },
    render: {
      files: ['src/app/canvas/node-layer.ts'],
      note: '无专用分支，复用通用卡片',
    },
    menu: {
      files: ['src/app/canvas/CanvasMenus.tsx'],
      note: '通用节点菜单；无 group 专属项',
    },
  },
  ai: {
    schema: {
      files: ['packages/canvas-format/src/types.ts', 'packages/canvas-format/src/document.ts'],
      note: 'CanvasAiNode（固定盒尺寸，自环不触发执行）',
    },
    projection: {
      files: ['src/app/canvas/node-layout.ts'],
      note: 'extractNodeViews 写入 kind=ai；固定尺寸 AI_NODE_WIDTH/HEIGHT',
    },
    factory: {
      files: [
        'src/app/canvas/canvas-interactions.ts',
        'src/app/canvas/use-connection-node-choice.ts',
      ],
      note: '新建 AI 节点',
    },
    render: {
      files: ['src/app/canvas/node-layer.ts'],
      note: 'AI 卡片 + 模型选择 + 执行状态',
    },
    menu: {
      files: ['src/app/canvas/CanvasMenus.tsx'],
      note: 'AI 专属菜单项（模型/执行）',
    },
  },
  prompt: {
    schema: {
      files: ['packages/canvas-format/src/types.ts', 'packages/canvas-format/src/document.ts'],
      note: 'CanvasPromptNode（固定盒尺寸，可连接 AI 节点）',
    },
    projection: {
      files: ['src/app/canvas/node-layout.ts'],
      note: 'extractNodeViews 写入 kind=prompt；固定尺寸 PROMPT_NODE_WIDTH/HEIGHT',
    },
    factory: {
      files: ['src/app/canvas/canvas-interactions.ts'],
      note: '新建提示词节点',
    },
    render: {
      files: ['src/app/canvas/node-layer.ts'],
      note: '提示词卡片 + 右下角「开始」钮',
    },
    menu: {
      files: ['src/app/canvas/CanvasMenus.tsx'],
      note: '提示词专属菜单项（编辑提示词）',
    },
  },
};

void test('每个画布节点类型都声明了五个触点', () => {
  const declared = Object.keys(COVERAGE).sort();
  const actual = [...CANVAS_NODE_TYPES].sort();
  assert.deepEqual(
    declared,
    actual,
    'CANVAS_NODE_TYPES 与测试内声明表不一致：新增类型请回填 COVERAGE；删除类型请同步删表',
  );

  for (const type of CANVAS_NODE_TYPES) {
    const entry = COVERAGE[type];
    for (const touchpoint of TOUCHPOINTS) {
      const landing = entry[touchpoint];
      assert.ok(
        landing !== undefined,
        `${type} 缺少触点声明：${touchpoint}（五触点：${TOUCHPOINTS.join(' / ')}）`,
      );
      assert.ok(
        landing.note.trim().length > 0,
        `${type}.${touchpoint} 必须写明落点；无落点时写「无 …」并说明原因`,
      );
      if (landing.files.length === 0) {
        assert.match(
          landing.note,
          /无/,
          `${type}.${touchpoint} 未列文件时，note 必须以「无…」说明原因`,
        );
      }
      for (const file of landing.files) {
        assert.ok(
          existsSync(join(ROOT, file)),
          `${type}.${touchpoint} 引用了不存在的文件：${file}`,
        );
      }
    }
  }
});