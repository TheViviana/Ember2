import { useEffect, useRef } from 'react';
import { createAudioEngine, type AudioEngineController } from '../../features/tools/audio-engine.ts';
import { createPomodoroController, type PomodoroController } from '../../features/tools/pomodoro.ts';
import {
  readAudioVolume,
  readPomodoroDurations,
} from '../../features/tools/tool-preferences.ts';

export interface ToolControllers {
  readonly pomodoro: PomodoroController;
  readonly audio: AudioEngineController;
}

/**
 * 创建并持有效率工具控制器。
 *
 * 控制器在组件生命周期内保持同一实例；销毁延迟一个宏任务：
 * StrictMode 开发态会执行 setup → cleanup → setup，若在 cleanup 里立即
 * dispose，重新挂载复用的仍是已销毁实例，番茄钟与白噪音将永久静默。
 */
export function useToolControllers(): ToolControllers {
  const controllersRef = useRef<ToolControllers | null>(null);
  if (controllersRef.current === null) {
    // 2026-11-25：优先用上次保存的时长/音量初始化，保证重启后设置效果不变。
    const durations = readPomodoroDurations();
    const volume = readAudioVolume();
    controllersRef.current = {
      pomodoro: createPomodoroController({
        ...(durations === null ? {} : durations),
      }),
      audio: createAudioEngine(volume === null ? {} : { volume }),
    };
  }
  const controllers = controllersRef.current;
  const pendingDisposeRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (pendingDisposeRef.current !== null) {
      clearTimeout(pendingDisposeRef.current);
      pendingDisposeRef.current = null;
    }
    return () => {
      pendingDisposeRef.current = setTimeout(() => {
        pendingDisposeRef.current = null;
        controllers.pomodoro.dispose();
        void controllers.audio.dispose();
      }, 0);
    };
  }, [controllers]);

  return controllers;
}
