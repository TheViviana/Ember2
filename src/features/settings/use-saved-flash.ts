/**
 * 设置项即时保存的内联反馈：改变后短暂显示「已保存」，不阻塞控件。
 * 定时器在卸载时清理，避免切页后回写状态。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface SavedFlash {
  readonly visible: boolean;
  readonly flash: () => void;
}

export function useSavedFlash(durationMs = 1600): SavedFlash {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback((): void => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const flash = useCallback((): void => {
    clearTimer();
    setVisible(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setVisible(false);
    }, durationMs);
  }, [clearTimer, durationMs]);

  return { visible, flash };
}
