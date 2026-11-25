/**
 * P5-C5：恢复检测演示面板（仅 DEV 构建挂载）。
 *
 * 演示控件与真实产品 UI 隔离：固定文案声明「不读取真实文档、不写盘、刷新即清空」，
 * 结果区禁止出现「已恢复」等成功承诺。真实触发与恢复流程递延 P6 machine IPC CR。
 */
import { useState } from 'react';
import { recoveryDemo, type DemoSeed } from './recovery-demo.ts';
import { useRecoveryDemo } from './use-recovery-demo.ts';
import styles from './RecoveryDemoPanel.module.css';

type ScenarioId = 'dirty' | 'clean' | 'no-flag';

interface Scenario {
  readonly id: ScenarioId;
  readonly label: string;
  readonly hint: string;
  readonly seed: DemoSeed;
}

const SCENARIOS: Readonly<Record<ScenarioId, Scenario>> = {
  dirty: {
    id: 'dirty',
    label: '异常退出 + 未落盘',
    hint: '崩溃标志为真，两篇文档的末版与磁盘 hash 不同。',
    seed: {
      crashFlag: true,
      latest: [
        { docId: 'notes/a.md', token: 'v2' },
        { docId: 'notes/b.md', token: 'v2' },
      ],
      onDisk: [
        { docId: 'notes/a.md', hash: 'v1' },
        { docId: 'notes/b.md', hash: 'v1' },
      ],
    },
  },
  clean: {
    id: 'clean',
    label: '异常退出 + 无差异',
    hint: '崩溃标志为真，但末版与磁盘一致：不应出现候选。',
    seed: {
      crashFlag: true,
      latest: [
        { docId: 'notes/a.md', token: 'v2' },
        { docId: 'notes/b.md', token: 'v2' },
      ],
      onDisk: [
        { docId: 'notes/a.md', hash: 'v2' },
        { docId: 'notes/b.md', hash: 'v2' },
      ],
    },
  },
  'no-flag': {
    id: 'no-flag',
    label: '正常退出 + 存在差异',
    hint: '没有崩溃标志：即使末版与磁盘不同，也不触发恢复。',
    seed: {
      crashFlag: false,
      latest: [
        { docId: 'notes/a.md', token: 'v2' },
        { docId: 'notes/b.md', token: 'v2' },
      ],
      onDisk: [
        { docId: 'notes/a.md', hash: 'v1' },
        { docId: 'notes/b.md', hash: 'v1' },
      ],
    },
  },
};

const SCENARIO_ORDER: ReadonlyArray<ScenarioId> = ['dirty', 'clean', 'no-flag'];

export function RecoveryDemoBody() {
  const snapshot = useRecoveryDemo();
  const [scenarioId, setScenarioId] = useState<ScenarioId>('dirty');
  const scenario = SCENARIOS[scenarioId];

  const canSeed =
    snapshot.phase === 'idle' ||
    snapshot.phase === 'resolved' ||
    (snapshot.phase === 'scanned' && snapshot.candidates.length === 0);
  const canScan = snapshot.phase === 'seeded';

  return (
    <section className={styles.body} aria-label="恢复检测演示">
          <p className={styles.note}>
            仅演示判定与列表交互：数据存于当前页面内存，刷新即清空；不读取真实文档、不写盘。
          </p>

          <div className={styles.scenarios} role="group" aria-label="演示场景">
            {SCENARIO_ORDER.map((id) => (
              <button
                key={id}
                type="button"
                aria-pressed={scenarioId === id}
                className={
                  scenarioId === id
                    ? `${styles.scenario} ${styles.scenarioActive}`
                    : styles.scenario
                }
                onClick={() => setScenarioId(id)}
              >
                {SCENARIOS[id].label}
              </button>
            ))}
          </div>
          <p className={styles.hint}>{scenario.hint}</p>

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.primary}
              disabled={!canSeed}
              onClick={() => {
                recoveryDemo.seed(scenario.seed);
              }}
            >
              注入场景
            </button>
            <button
              type="button"
              className={styles.primary}
              disabled={!canScan}
              onClick={() => {
                recoveryDemo.scan();
              }}
            >
              模拟下次启动
            </button>
            <button
              type="button"
              className={styles.quiet}
              onClick={() => {
                recoveryDemo.reset();
              }}
            >
              重置
            </button>
          </div>

          <p
            className={
              snapshot.messageTone === 'warning' ? styles.messageWarning : styles.message
            }
            role={snapshot.messageTone === 'warning' ? 'alert' : 'status'}
          >
            {snapshot.message ?? '尚未注入演示场景。'}
          </p>

          {snapshot.candidates.length > 0 ? (
            <ul className={styles.candidates} aria-label="恢复候选">
              {snapshot.candidates.map((candidate) => (
                <li key={candidate.docId} className={styles.candidate}>
                  <div className={styles.candidateMeta}>
                    <span className={styles.docId}>{candidate.docId}</span>
                    <span className={styles.hash}>
                      末版 {candidate.latestToken} · 磁盘 {candidate.diskHash}
                    </span>
                  </div>
                  {candidate.decision === null ? (
                    <div className={styles.rowActions}>
                      <button
                        type="button"
                        className={styles.primary}
                        onClick={() => {
                          recoveryDemo.decide(candidate.docId, 'restore');
                        }}
                      >
                        恢复
                      </button>
                      <button
                        type="button"
                        className={styles.quiet}
                        onClick={() => {
                          recoveryDemo.decide(candidate.docId, 'discard');
                        }}
                      >
                        放弃
                      </button>
                    </div>
                  ) : (
                    <span className={styles.decision}>
                      {candidate.decision === 'restore'
                        ? '已记录：恢复（未写盘）'
                        : '已记录：放弃（未写盘）'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}

          {snapshot.excluded.length > 0 ? (
            <div className={styles.excluded}>
              <p className={styles.excludedTitle}>已排除（不属恢复范围）</p>
              <ul className={styles.excludedList}>
                {snapshot.excluded.map((item) => (
                  <li key={item.docId}>
                    {item.docId}：
                    {item.reason === 'missing-on-disk' ? '磁盘上不存在' : '无会话末版'}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
    </section>
  );
}
