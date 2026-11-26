# Changelog

本项目所有值得注意的变更都记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- 节点视图投影 `CanvasNodeView` 新增必填 `type` 字段（内部类型铺垫，无用户可见变化）。

### Fixed

- Prompt 节点自环不再误触发 AI 执行（边缘输入下的行为收紧）。

### Internal

- IPC 命令名称门禁改为 AST 双向校验（仅开发期检查）。
