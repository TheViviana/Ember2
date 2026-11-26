# 保持 Rust IPC 厚度并暂缓节点注册表

- 日期：2026-11-26
- 状态：已接受

## 决策一：保持 Rust IPC 厚度

写闸门、expected-SHA 条件写、原子替换、批量回滚和 watcher 写日志继续留在 Rust，以保留跨进程与文件一致性保证；不把上述职责下移到 WebView。

证据：[doc.rs](../../src-tauri/src/vault/doc.rs)、[replace.rs](../../src-tauri/src/vault/replace.rs)。

## 决策二：暂缓节点注册表

节点扩展仍分散在 schema、投影、工厂、渲染和菜单，记为已知债务。当前只补充 `CanvasNodeView.type`，不引入节点注册表；待一至两个真实节点落地，采集漏改点、修改文件数和回归成本后再决策。

证据：[node-layout.ts](../../src/app/canvas/node-layout.ts)、[node-layer.ts](../../src/app/canvas/node-layer.ts)、[CanvasMenus.tsx](../../src/app/canvas/CanvasMenus.tsx)。

**已确认的语义差异：**

- `findPromptAiNode` 有意忽略自环。正常 Prompt 节点结果不变；异常重复 ID 且同 ID 被标成 AI 时，不再执行 `promptId`，改为“未连接”。这不是无条件的等价重构。
- `isRecord` 现在统一拒绝数组对象。生产画布文档仅来自 JSON 解析、空文档及普通对象命令变更，未发现携带自定义属性的异常数组，因此接受这一收紧。程序化构造路径已扫描，节点/边均为普通对象，isRecord 排除数组不构成行为回归。

证据：[ai-node-execution.ts](../../src/app/canvas/ai-node-execution.ts)、[format.ts](../../src/app/canvas/format.ts)、[document-controller.ts](../../src/app/canvas/document-controller.ts)、[mutate.ts](../../packages/canvas-format/src/mutate.ts)。

**观察项：两套专用边遍历。** `findPromptAiNode` 取首个直连 AI 并提前返回，`collectAiNeighbors` 收集全部邻居；两者共享 `isRecord` / `endpointNodeId`，暂不收拢。出现第三套边遍历时再评估是否抽象通用遍历器。
