# Changelog

本项目所有值得注意的变更都记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.3.0] - 2026-11-28

### Added

- 画布新增 split（分块）与 merge（汇总）节点：文章按预算切块、逐块提炼、按连线顺序汇总，结果可写入文本节点或空文档。
- 分块卡片显示预计块数（「预计 N 块」「块数待计算」「素材过长」），运行中显示 k/N；失败块带标记并支持单块重试。
- AI 步骤、分块、汇总卡片统一运行圆钮：空闲为三角，运行中切换为三角 + 竖线并可停止。
- 分块子块标题显示块序号；竖排布局每列最多 8 块后向右换列，换列后继续避让已有节点。

### Changed

- 分批重跑与单块重试增加覆盖确认；merge 输出到文档时保留「文档写入不进入画布撤销」提示。

### Fixed

- 平台更新包缺失时返回可读提示，不再暴露底层 `TargetNotFound`。
- split 模式启动即进入运行态，停止钮与运行态指示不再缺失。

### Internal

- AI 请求按模型预算裁剪上下文，补齐 endpoint / error 映射与请求体测试。
- canvas-format 升级到 v3，新增 split / merge 节点与子块元数据校验。
- 新增画布瞬态状态存储、分块预览投影与浏览器验收 harness（不进 CI）。
- Windows 构建接入 updater 产物签名，并预留代码签名钩子（CI）。
- 空间工作区隔离骨架（为后续多空间准备）。

## [1.2.2] - 2026-11-28

### Added

- 外部修改导致冲突时，把冲突发生时的本地未保存草稿另存到 `.workbench/conflicts/`，并在冲突横幅展示副本路径；副本保存失败时提示手动备份，不会伪装成已保存。

### Internal

- 新增 `conflict_save` IPC 命令：create-only 原子写、逐级拒绝 symlink、复用路径解析防逃逸。
- IPC 入口/出口与统一错误载荷写入结构化日志（`~/Library/Logs/app.ember.desktop/ember.log`）。
- 发版脚本校验 tag 与版本号一致，不一致时拒绝生成 `latest.json`。

## [1.2.1] - 2026-11-26

### Fixed

- Windows 版启动即报「I/O 失败：拒绝访问」（目录 fsync 在 Windows 上不可用）。
- Windows 删除文件改走系统回收站，调用失败时仍回落库内回收站。
- Prompt 节点自环不再误触发 AI 执行（边缘输入下的行为收紧）。

### Internal

- Windows 应用状态目录改用 `%APPDATA%\Ember`，避免锁与库表落到临时目录被清理。
- 节点视图投影 `CanvasNodeView` 新增必填 `type` 字段（无用户可见变化）。
- IPC 命令名称门禁改为 AST 双向校验（仅开发期检查）。

## [Unreleased]
