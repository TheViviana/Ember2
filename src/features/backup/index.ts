/**
 * CR-20261119-22：features/backup 对外出口。AppShell 仅从此处消费，
 * backup 内部模块不得被 app 层深引（传输边界见 CR §3 D1）。
 */
export { BackupSettingsBody } from './BackupPanel.tsx';
export type { BackupPanelEffects, BackupSettingsBodyProps } from './BackupPanel.tsx';
