/**
 * 段落级分段纯逻辑已迁至 core 层（src/core/translate-segments.ts）：
 * editor / app 层可直接引 core；此处 re-export 保持既有 import 路径与测试不变。
 */
export * from '../../core/translate-segments.ts';
