import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AudioEngineController, AudioEngineStatus } from './audio-engine.ts';
import {
  MAX_DURATION_MINUTES,
  MIN_DURATION_MINUTES,
  type PomodoroController,
  type PomodoroPhase,
  type PomodoroStatus,
} from './pomodoro.ts';
import { writeAudioVolume, writePomodoroDurations } from './tool-preferences.ts';
import styles from './tools.module.css';

export interface ToolsSettingsBodyProps {
  readonly pomodoro: PomodoroController;
  readonly audio: AudioEngineController;
}

const phaseLabels: Record<PomodoroPhase, string> = {
  focus: '专注',
  'short-break': '短休',
};

const pomodoroStatusLabels: Record<PomodoroStatus, string> = {
  idle: '未开始',
  running: '进行中',
  paused: '已暂停',
};

const audioStatusLabels: Record<AudioEngineStatus, string> = {
  idle: '未播放',
  starting: '正在启动',
  running: '播放中',
  stopping: '正在停止',
  error: '播放失败',
};

function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function isDurationDraftValid(value: string): boolean {
  if (value.trim() === '') return false;
  const minutes = Number(value);
  return Number.isFinite(minutes)
    && minutes >= MIN_DURATION_MINUTES
    && minutes <= MAX_DURATION_MINUTES;
}

export function ToolsSettingsBody({ pomodoro, audio }: ToolsSettingsBodyProps) {
  const pomodoroSnapshot = useSyncExternalStore(pomodoro.subscribe, pomodoro.getSnapshot);
  const audioSnapshot = useSyncExternalStore(audio.subscribe, audio.getSnapshot);
  const [focusDraft, setFocusDraft] = useState(String(pomodoroSnapshot.focusMinutes));
  const [shortBreakDraft, setShortBreakDraft] = useState(String(pomodoroSnapshot.shortBreakMinutes));

  useEffect(() => {
    setFocusDraft(String(pomodoroSnapshot.focusMinutes));
  }, [pomodoroSnapshot.focusMinutes]);

  useEffect(() => {
    setShortBreakDraft(String(pomodoroSnapshot.shortBreakMinutes));
  }, [pomodoroSnapshot.shortBreakMinutes]);

  const durationsValid = isDurationDraftValid(focusDraft)
    && isDurationDraftValid(shortBreakDraft);

  return (
    <div className={styles.body} data-tools-host="true">
          <section className={styles.section} aria-labelledby="tools-pomodoro-title">
            <div className={styles.sectionHeading}>
              <h3 id="tools-pomodoro-title">番茄钟</h3>
              <span>{pomodoroStatusLabels[pomodoroSnapshot.status]}</span>
            </div>
            <div className={styles.timer} role="timer" aria-label="番茄钟剩余时间">
              {formatRemaining(pomodoroSnapshot.remainingMs)}
            </div>
            <div className={styles.timerMeta}>
              <span>{phaseLabels[pomodoroSnapshot.phase]}</span>
              <span>已完成 {pomodoroSnapshot.completedRounds} 轮</span>
            </div>
            <div className={styles.actions}>
              {pomodoroSnapshot.status === 'idle' ? (
                <button type="button" className={styles.primary} onClick={pomodoro.start}>开始</button>
              ) : null}
              {pomodoroSnapshot.status === 'running' ? (
                <button type="button" className={styles.primary} onClick={pomodoro.pause}>暂停</button>
              ) : null}
              {pomodoroSnapshot.status === 'paused' ? (
                <button type="button" className={styles.primary} onClick={pomodoro.resume}>继续</button>
              ) : null}
              <button type="button" onClick={pomodoro.reset}>重置</button>
            </div>

            <form
              className={styles.durationForm}
              onSubmit={(event) => {
                event.preventDefault();
                if (!durationsValid) return;
                const next = {
                  focusMinutes: Number(focusDraft),
                  shortBreakMinutes: Number(shortBreakDraft),
                };
                pomodoro.setDurations(next);
                writePomodoroDurations(next);
              }}
            >
              <label>
                <span>专注（分钟）</span>
                <input
                  type="number"
                  min={MIN_DURATION_MINUTES}
                  max={MAX_DURATION_MINUTES}
                  step="1"
                  value={focusDraft}
                  onChange={(event) => { setFocusDraft(event.target.value); }}
                  aria-label="专注时长（分钟）"
                />
              </label>
              <label>
                <span>短休（分钟）</span>
                <input
                  type="number"
                  min={MIN_DURATION_MINUTES}
                  max={MAX_DURATION_MINUTES}
                  step="1"
                  value={shortBreakDraft}
                  onChange={(event) => { setShortBreakDraft(event.target.value); }}
                  aria-label="短休时长（分钟）"
                />
              </label>
              <button type="submit" disabled={!durationsValid}>应用时长</button>
            </form>
            <p className={styles.hint}>
              {durationsValid
                ? '进行中的周期保持原时长，新时长用于后续未开始周期。'
                : `时长需为 ${MIN_DURATION_MINUTES}–${MAX_DURATION_MINUTES} 分钟。`}
            </p>
          </section>

          <section className={styles.section} aria-labelledby="tools-noise-title">
            <div className={styles.sectionHeading}>
              <h3 id="tools-noise-title">白噪音</h3>
              <span>{audioStatusLabels[audioSnapshot.status]}</span>
            </div>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primary}
                onClick={() => { void audio.start(); }}
                disabled={audioSnapshot.status === 'starting'
                  || audioSnapshot.status === 'running'
                  || audioSnapshot.status === 'stopping'}
              >
                {audioSnapshot.status === 'starting' ? '正在启动…' : '开始'}
              </button>
              <button
                type="button"
                onClick={() => { void audio.stop(); }}
                disabled={audioSnapshot.status === 'idle' || audioSnapshot.status === 'stopping'}
              >
                停止
              </button>
            </div>
            <label className={styles.volumeRow}>
              <span>音量</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={audioSnapshot.volume}
                onChange={(event) => {
                  audio.setVolume(event.target.valueAsNumber);
                  writeAudioVolume(event.target.valueAsNumber);
                }}
                aria-label="白噪音音量"
              />
              <output>{Math.round(audioSnapshot.volume * 100)}%</output>
            </label>
            {audioSnapshot.error !== null ? (
              <p className={styles.error} role="alert">白噪音错误：{audioSnapshot.error}</p>
            ) : null}
          </section>
    </div>
  );
}
