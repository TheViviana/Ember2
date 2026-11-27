# Changelog

本项目所有值得注意的变更都记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

### Internal

- Windows 构建接入 updater 产物签名，并预留代码签名钩子（CI）。
