# IPC DTO 契约测试化、画布引擎限量抽取与节点注册表继续暂缓

- 日期：2026-11-27
- 状态：已接受（决策一、决策二棘轮、决策三已实施；决策二三簇抽取经实测取消）

## 背景

一次外部架构评审提出 5 条建议。逐条对照代码后，其中 2 条（core 拆分仓储接口、引入 Zustand 做单一状态源）描述的前提与仓库现状不符，2 条（DTO 契约自动化、画布引擎拆分）部分成立，1 条（节点注册表）与既有决策重复。

本 ADR 只记录需要行动的三项，并把未采纳项的理由一并留档，避免同类建议反复提出。

## 决策一：IPC DTO 契约用快照测试，不引入代码生成

现状：门禁只对齐命令名（[command-registry.mjs](../../scripts/gates/command-registry.mjs#L1-L8)），`src/types/ipc.ts` 与 Rust 侧 `*Dto` struct 的字段级一致性没有任何自动校验。

做法：

1. Rust 侧 `src-tauri/tests/ipc_dto_snapshot.rs`：每个 DTO 用**完整结构体字面量**构造样本，`serde_json::to_value` 后与 `tests/fixtures/ipc/<Name>.json` 比对。新增字段会让字面量编译失败，这就是强制同步点；`rename_all = "camelCase"` 写错也会被抓到。
2. TS 侧 `tests/contract/ipc-dto.test.ts`：读同一批快照，用双向可赋值的 `Exact<T>` 做编译期校验，并断言运行时键集合。字段改名、漏字段、多字段三类漂移会同时打红两侧。
3. 覆盖棘轮：测试内维护 `COVERED_DTOS`，未覆盖的 `*Dto` 数量只减不增，防止新增 DTO 绕过。

范围：第一批只覆盖 `VaultPort` 用到的 10 个 DTO（identity/constants/scan/read/write/stat/list/rename/remove + fileChanged/watchError），第二批补 ai/canvas/backup/history/media/translate。枚举型 DTO（如 `EntryKindDto`）的 union 收敛用 `satisfies` 加运行时断言单独处理。

理由：不选"基于 TS 类型生成 Rust 签名"，因为 [contract.md](../contract.md#L1-L3) 是唯一契约源、代码不一致即 bug；生成器会引入第二真理源，且无法表达 Rust 侧的条件写、回滚等行为约束。快照方案零新增依赖、零运行时改动。

验收：改一个 Rust 字段名 → Rust 快照红；删一个 TS 字段 → TS 测试红；`pnpm run check` 全绿。

## 决策二：画布引擎只抽取三簇，并设行数棘轮

现状：渲染（grid / world / node / edge / edge-pulse / viewport）、交互（interaction / interactions / document-controller）、节点业务（ai-node-execution / ai-node-run / doc-preview）已是独立模块，[engine.ts](../../src/app/canvas/engine.ts#L1-L18) 是编排器。再按"渲染 vs 交互"切一遍是重复劳动。

做法：

1. 先立棘轮：`scripts/size-budget.json` + `tests/architecture/size-budget.test.ts`，把当前行数写成上限，只允许下调；`BoardView.tsx`、`network.ts` 等大文件纳入观测但不拆。
2. 只抽取三簇低耦合逻辑，一次一簇、纯移动加构造注入、不改逻辑：

   | 簇 | 代表方法 | 规模 |
   |---|---|---|
   | 视口/适配 | `applyTransform` / `zoomAtCenter` / `fitAllNodes` / `applyInitialFit` / `resize` / `screenToWorld` | ~300 行 |
   | 测量调度 | `autoHeights` / `scheduleMeasure` / `onAutoHeightMeasured` / `autoHeightPruneAndSchedule` | ~100 行 |
   | 文档预览同步 | `syncDocPreviews` / `isDocNodeVisible` / `refreshDocPreviews` / `invalidateDocPreview` | ~80 行 |

3. 输入手势簇（`onPointerDown/Move/Up`、`onKeyDown`、`hitTest*`，约 600 行）与选择、拖拽、滚动状态耦合最深，不拆。
4. 停止条件：三簇搬完、`engine.ts` 约 1500 行即停；剩余是事件接线与状态机，属固有编排职责，继续拆会把状态搬来搬去，收益为负。

验收：每簇 PR 内现有 canvas 测试零改动通过；预算棘轮同步收紧；`CanvasEngineOptions` / `CanvasEngineEvent` 公开 API 不变。

### 实测记录（2026-11-27）：视口簇不可拆，Phase 2.2 停止

执行前逐方法量了「视口/适配」的实际体量，与本文估算不一致：

| 方法 | 行数 |
|---|---|
| `applyTransform` | 44 |
| `applyInitialFit` | 37 |
| `resize` | 27 |
| mount 内初始适配块 | ~26 |
| 缩放 / 适配 / 重置命令（`zoomAtCenter`、`fitAllNodes`、`resetPrecisionView`、`resetView`、`finishInitialFit`） | ~22 |
| `screenToWorld` | 10 |

合计约 166 行，而非 ~300。且这些方法内没有可整体搬走的逻辑体：纯数学已在 `viewport.ts`，剩余部分靠 `gridInvalidation`、`frameState`、`world` 层、`dirtyNodeIds`、`scheduleMeasure`、`docPreview`、`emitNotice` 等九项宿主能力驱动——搬出必然引入跨模块状态传递，与本决策「收益为负」的判断冲突。测量调度、预览同步两簇（各 30~50 行）同样是这种形态。

结论：按本决策「三簇搬完即停」的停止条款，Phase 2.2 不再执行。行数棘轮保留，`engine.ts` 上限维持 2048；后续若确实需要增长，必须回到本 ADR 重新评估，而不是默默上调阈值。

### 执行口径（补充，2026-11-27）

> **本条为重启条件，非当前执行计划。**

**一、停止理由的显式化。** 上面的实测记录已给出 166 行与九项宿主能力的事实，这里只补决策层的成本对比：把视口簇搬出去只有两条路——（a）在 engine 内部构造适配器，需要包住 `gridInvalidation`、`frameState`、`world` 层、`dirtyNodeIds`、`scheduleMeasure`、`docPreview`、`emitNotice` 等九项能力，形成胖接口；（b）让 `CanvasEngineOptions` 新增字段，触碰所有直接构造点（当前 3 个测试 harness 文件、7 处构造，另有 `CanvasView.tsx` 的 1 处生产构造）。两条路分别产生跨模块耦合或契约变更，因此即使只有 166 行也不拆。未来若有人重新提出「这么小为什么不拆」，应先反驳这两条路，而不是重新估算行数。

**二、可验证的 API 约束。** 本小节取代决策二验收口径中「公开 API 不变」的表述（原文过于绝对且不可验证），不推翻决策二本身。

- `CanvasEngineOptions` 不新增必填字段，现有构造点无需修改即可编译。
- `CanvasEngineEvent` 不新增或删除变体。
- 新增可选字段时，至少一个现有构造点（测试 harness 或生产构造）不传该字段，作为缺省路径用例，断言行为与改动前完全一致；其余构造点不得因此被强制修改。

**三、两提交纪律与触发条件。** 每簇拆成两个提交：

- **move-only**：只搬方法与类型，包含使新模块可编译所需的机械替换（`this.xxx` → `host.xxx`、import/export 路径），不做任何逻辑改写；
- **wiring**：才做注入、替换调用点、删除旧私有方法。

两条提交必须各自可编译、测试通过（否则 bisect 与回滚失效）。review 时用 `git show --color-moved --color-moved-ws=allow-indentation-change` 区分纯移动与修改：跨文件搬方法缩进必变，缺这个参数会把纯移动显示成删除加新增。`git log --follow` 只跟单文件重命名，不能作为方法级移动的保障。若出现第二次同类重构，再考虑 PR 模板。

## 决策三：节点注册表继续暂缓，改为观测加覆盖断言

[ADR 0002 决策二](0002-ipc-thickness-and-canvas-extension.md#L12-L18) 已明确暂缓注册表并给出触发条件。本决策不改变该结论，只把"采集漏改点"变成可执行流程：

1. 在 0002 追加观测项（append-only，不改原决策）：固定五触点清单（schema / 投影 / 工厂 / 渲染 / 菜单），并记录每个新节点类型的改动文件数、漏改点、回归数。
2. 新增 `tests/app/canvas/node-type-coverage.test.ts`：枚举 `CANVAS_NODE_TYPES`（[node-types.ts](../../packages/canvas-format/src/node-types.ts#L1-L11)），要求每个类型在测试内声明表中显式列出五触点落点，新类型未声明即红。
   - 边界：这张表只在测试内，不进运行时，不成为第二份业务真相源；它的作用是强迫人去看那五处，而不是抽象行为。
3. 升级门槛：任一新节点出现「漏改 ≥2 处」或「单次改动 ≥6 文件且跨层」，才另立 ADR 讨论注册表，用真实数据而非直觉决策。

## 未采纳的建议及理由

- **core 再拆领域模型与仓储接口**：[ports.ts](../../src/core/ports.ts#L27-L41) 的 `VaultPort` 就是仓储接口，生产适配在 `src/data/`，真实读写在 Rust `src-tauri/src/vault/`；[layers.mjs](../../scripts/gates/layers.mjs#L27-L37) 已强制 core 不引 React / zustand / `@tauri-apps`。再拆会与 ADR 0002 决策一冲突，并丢失跨进程写入一致性。
- **引入 Zustand 做单一状态源**：领域状态已在 core 的 `createSlice`，zustand 只是 [ember-store.ts](../../src/app/stores/ember-store.ts#L1-L12) 的薄桥；把文档树、画布节点、连线合并进一个 store 等于把领域状态搬进 React 层，违背 D12 与分层规则。
- **全局 IPC 重试**：`E_CONFLICT` / `E_PERM` / `E_READONLY` 不是瞬时错误；重试 `E_CONFLICT` 会覆盖外部修改。现有只在翻译链路做 retry，范围正确。
- **补写"为何选 Tauri 而非 Electron"ADR**：该决策早于 v2 重写，事后补写只能追忆，容易失真；ADR 只对未决或易反复的决策有约束价值。

## 后果

- 三项均为内部改进，按 [release.md](../../.trae/rules/release.md) 不单独发版，随下次用户可感知版本带上。
- 建立三道防线：契约漂移（决策一）、文件膨胀（决策二棘轮）、节点漏改（决策三覆盖断言）。
- 实施顺序：决策一 → 决策二棘轮 → 决策三观测。决策二的「三簇抽取」经实测取消（见决策二实测记录）；决策三与决策二文件不重叠，可并行。