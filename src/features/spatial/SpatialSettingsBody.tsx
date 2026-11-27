/**
 * 设置壳「工具与维护 / 空间工作区」页。
 *
 * 开关只控制入口是否出现；打开后进入全屏覆盖层，布局不持久化。
 * 主应用不在这里加载任何 3D 依赖。
 */
import { useState } from 'react';
import { readSpatialEnabled, writeSpatialEnabled } from './flag.ts';
import shared from '../settings/settings-shared.module.css';
import styles from './spatial-settings.module.css';

export interface SpatialSettingsBodyProps {
  readonly onOpen: () => void;
}

export function SpatialSettingsBody({ onOpen }: SpatialSettingsBodyProps) {
  const [enabled, setEnabled] = useState<boolean>(() =>
    readSpatialEnabled(window.localStorage),
  );

  const toggle = (next: boolean): void => {
    setEnabled(next);
    writeSpatialEnabled(window.localStorage, next);
  };

  return (
    <div className={styles.body}>
      <section className={shared.card}>
        <h3 className={shared.groupLabel}>空间工作区（实验）</h3>
        <label className={styles.toggleRow}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => {
              toggle(event.target.checked);
            }}
          />
          <span className={styles.toggleText}>
            <span className={styles.toggleTitle}>启用实验入口</span>
            <span className={styles.toggleHint}>
              开启后可打开空间工作区；主应用其余功能不受影响。
            </span>
          </span>
        </label>
        {enabled ? (
          <div className={styles.actions}>
            <button type="button" className={styles.primary} onClick={onOpen}>
              打开空间工作区
            </button>
          </div>
        ) : null}
        <p className={styles.note}>
          实验性：布局不会保存，重新打开会重置；部分设备可能不支持 3D 渲染。
        </p>
      </section>
    </div>
  );
}