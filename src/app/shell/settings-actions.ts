/**
 * R4-1：设置菜单入口 → 壳层动作的纯映射。
 *
 * CR-R6-1：映射由 settings-registry 单一登记表派生，
 * 不再手写 panel 表或 special 判断；登记表缺项即返回 null（未知 id 语义不变）。
 */
import type { ShellPanelId } from './shell-panels.ts';
import { SETTINGS_ENTRIES } from './settings-registry.ts';

export type SettingsAction =
  | { readonly kind: 'panel'; readonly panel: ShellPanelId }
  | { readonly kind: 'special'; readonly id: 'import' | 'dev-render-fault' };

const ACTIONS: ReadonlyMap<string, SettingsAction> = new Map(
  SETTINGS_ENTRIES.flatMap((entry): ReadonlyArray<readonly [string, SettingsAction]> => {
    if ('panel' in entry) {
      return [[entry.id, Object.freeze({ kind: 'panel', panel: entry.panel })]];
    }
    return [[entry.id, Object.freeze({ kind: 'special', id: entry.special })]];
  }),
);

export function resolveSettingsAction(id: string): SettingsAction | null {
  return ACTIONS.get(id) ?? null;
}
