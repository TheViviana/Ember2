# split / merge 格式与执行决策

> 状态：由实现方按用户 2026-11-28 任务口径补建；待用户确认的条目已显式标注。

## 已落地的 v3 事实

- `schemaVersion = 3`；读入 v2 时按 v3 归一，首次保存写回 v3（单向升级）。
- 节点类型：`document | media | text | group | ai | prompt | split | merge`。
- `split` 可选 `mode?: 'split' | 'refine'`、`chunkChars?: number`、`text?: string`、`model?: string`。
- `merge` 可选 `text?: string`、`model?: string`。
- 跨类型互斥由格式层 inspection 校验：`mode/chunkChars` 仅 `split`；`model` 仅 `ai/split/merge`；`text` 仅 `ai/prompt/split/merge`。
- 命令批次：`executeCommands(commands)` 整批应用或整批失败，成功时只推进一条历史。

## 子块节点（已确认）

- 子块是普通可编辑 `text` 节点，只带 `chunkIndex/sourceNodeId`（两者成对、可选、仅 text），不新增 `offset/length`，不新增编辑态 / 锁定字段。
- 编辑第 k 块后，merge 读取块当前内容；不回写上游原文。
- 重跑 split 以当前上游原文重新切分，不映射编辑内容回原文偏移。

## 历史与取消（已确认：方案 A 延迟提交）

- refine 期间不落块：全部提炼完成后一次性提交「删旧块 + 建新块 + 连线」，整批只占一条历史。
- 取消 = 不提交：无残留节点、历史栈不新增；重跑时旧块在运行期锁定，取消后保持原样并可编辑。
- 单块失败：保留成功块与失败块原始文本，失败块标记错误态；卡片「重试提炼」只重跑该块，成功写回一条 `updateNode` 历史。

## 重跑冲突检测（不新增字段的实现口径）

- 「有下游连线」：存在从任一子块出发的边。
- 「块被编辑」：按当前上游原文重新切分，逐块比较当前块文本与重切分结果；不一致即视为已编辑。
- 二者任一命中 → 二次确认；确认后整批覆盖，文案明确「已编辑的块将被覆盖」。