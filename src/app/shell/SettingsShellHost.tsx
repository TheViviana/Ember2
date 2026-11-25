/**
 * 设置壳宿主：构建导航、维护当前入口、分发页面与动作。
 *
 * 唯一把 app 层数据与 effects 接到设置页面的地方；SettingsShell 只负责展示。
 * 动作型入口（import / dev-render-fault）执行后关闭壳，不渲染页面。
 */
import { useMemo } from 'react';
import type { CommandBindingMap } from '../../features/commands/bindings.ts';
import type { CommandDefinition } from '../../features/commands/commands.ts';
import type { AiPanelEffects } from '../../features/ai/AiPanel.tsx';
import { AiSettingsBody } from '../../features/ai/AiSettingsBody.tsx';
import { AppearanceSettingsBody } from '../../features/settings/AppearancePanel.tsx';
import { EditorSettingsBody } from '../../features/settings/EditorSettingsBody.tsx';
import { ShortcutSettingsBody } from '../../features/settings/ShortcutSettings.tsx';
import { TranslateSettingsBody } from '../../features/translate/TranslateSettingsPanel.tsx';
import type { TranslateSettings } from '../../features/translate/translate-settings.ts';
import { LibrarySettingsBody } from '../panels/LibrarySettingsPanel.tsx';
import { BackupSettingsBody, type BackupPanelEffects } from '../../features/backup/index.ts';
import { AboutSettingsBody, type UpdatePanelEffects } from '../../features/updater/UpdatePanel.tsx';
import { ToolsSettingsBody } from '../../features/tools/ToolsPanel.tsx';
import type { PomodoroController } from '../../features/tools/pomodoro.ts';
import type { AudioEngineController } from '../../features/tools/audio-engine.ts';
import { InboxSettingsBody } from '../panels/InboxPanelHost.tsx';
import type { InboxItem } from '../../features/collect/model.ts';
import { ReplaceSettingsBody } from '../../features/replace/ReplacePanel.tsx';
import type { ReplaceRunnerEffects } from '../../features/replace/replace-runner.ts';
import { HealthSettingsBody } from '../../features/health/HealthPanel.tsx';
import type { HealthPanelEffects } from '../../features/health/health-flow.ts';
import { HistorySettingsBody } from '../../features/history/HistoryPanel.tsx';
import type { HistoryPanelEffects } from '../../features/history/history-flow.ts';
import { RecoveryDemoBody } from '../../windows/RecoveryDemoPanel.tsx';
import { SETTINGS_ENTRIES } from './settings-registry.ts';
import { buildSettingsNav, findSettingsNavEntry, type SettingsPageId } from './settings-nav.ts';
import { SETTINGS_HOME_ID, SettingsShell } from './SettingsShell.tsx';

export interface SettingsShellHostProps {
  readonly open: boolean;
  readonly entry: string;
  readonly onEntryChange: (id: string) => void;
  readonly onClose: () => void;
  readonly vaultId: string | null;
  readonly readonly: boolean;
  readonly activePath: string | null;
  readonly activeDocId: string | null;
  readonly dev: boolean;
  readonly aiEffects: AiPanelEffects;
  readonly backupEffects: BackupPanelEffects;
  readonly updaterEffects: UpdatePanelEffects;
  readonly replaceEffects: ReplaceRunnerEffects;
  readonly healthEffects: HealthPanelEffects;
  readonly historyEffects: HistoryPanelEffects;
  readonly inbox: {
    readonly items: readonly InboxItem[];
    readonly persistenceError: string | null;
    readonly loadWarning: string | null;
    readonly onChange: (items: readonly InboxItem[]) => void;
  };
  readonly shortcuts: {
    readonly definitions: readonly CommandDefinition[];
    readonly bindings: CommandBindingMap;
    readonly onSave: (bindings: CommandBindingMap) => string | null;
  };
  readonly tools: {
    readonly pomodoro: PomodoroController;
    readonly audio: AudioEngineController;
  };
  readonly onTranslateSaved: (settings: TranslateSettings) => void;
  readonly onOpenImport: () => void;
  readonly onTriggerRenderFault: () => void;
}

export function SettingsShellHost({
  open,
  entry,
  onEntryChange,
  onClose,
  vaultId,
  readonly,
  activePath,
  activeDocId,
  dev,
  aiEffects,
  backupEffects,
  updaterEffects,
  replaceEffects,
  healthEffects,
  historyEffects,
  inbox,
  shortcuts,
  tools,
  onTranslateSaved,
  onOpenImport,
  onTriggerRenderFault,
}: SettingsShellHostProps) {
  const sections = useMemo(
    () => buildSettingsNav(SETTINGS_ENTRIES, { vaultId, readonly, activePath, dev }),
    [vaultId, readonly, activePath, dev],
  );

  const handleSelect = (id: string): void => {
    if (id === SETTINGS_HOME_ID) {
      onEntryChange(id);
      return;
    }
    const target = findSettingsNavEntry(sections, id);
    if (target === null || target.disabled === true) return;
    if (target.action === 'import') {
      onOpenImport();
      onClose();
      return;
    }
    if (target.action === 'dev-render-fault') {
      onTriggerRenderFault();
      onClose();
      return;
    }
    onEntryChange(id);
  };

  const renderBody = (page: SettingsPageId | undefined) => {
    switch (page) {
      case 'appearance':
        return <AppearanceSettingsBody />;
      case 'editor':
        return <EditorSettingsBody />;
      case 'ai':
        return <AiSettingsBody effects={aiEffects} />;
      case 'translate':
        return <TranslateSettingsBody onSaved={onTranslateSaved} />;
      case 'library':
        return <LibrarySettingsBody />;
      case 'backup':
        return <BackupSettingsBody effects={backupEffects} />;
      case 'shortcuts':
        return (
          <ShortcutSettingsBody
            definitions={shortcuts.definitions}
            bindings={shortcuts.bindings}
            onSave={shortcuts.onSave}
          />
        );
      case 'update':
        return <AboutSettingsBody effects={updaterEffects} />;
      case 'tools':
        return <ToolsSettingsBody pomodoro={tools.pomodoro} audio={tools.audio} />;
      case 'inbox':
        return (
          <InboxSettingsBody
            items={inbox.items}
            persistenceError={inbox.persistenceError}
            loadWarning={inbox.loadWarning}
            onChange={inbox.onChange}
          />
        );
      case 'replace':
        return <ReplaceSettingsBody effects={replaceEffects} />;
      case 'health':
        return <HealthSettingsBody effects={healthEffects} />;
      case 'history':
        return (
          <HistorySettingsBody path={activePath} docId={activeDocId} effects={historyEffects} />
        );
      case 'recoveryDemo':
        return <RecoveryDemoBody />;
      default:
        return null;
    }
  };

  const activeEntry = findSettingsNavEntry(sections, entry);

  return (
    <SettingsShell
      open={open}
      sections={sections}
      activeId={entry}
      onSelect={handleSelect}
      onClose={onClose}
    >
      {renderBody(activeEntry?.page)}
    </SettingsShell>
  );
}
