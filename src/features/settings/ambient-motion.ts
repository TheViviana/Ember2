/**
 * 画布「动态背景」三档偏好（Cinematic Ember §2.3.5）。
 *
 * - dynamic（默认）：L1 慢推 + 内容驱动层 L2；
 * - static：只保留 L1 静态氛围；
 * - off：隐藏 L1/L2，保留底色、点阵、暗角与颗粒。
 *
 * 存储写法与外观主题一致：localStorage + 同页自定义事件通知。
 */
export type AmbientMotionPreference = 'off' | 'static' | 'dynamic';

export const AMBIENT_MOTION_STORAGE_KEY = 'ember.ambient-motion';
const CHANGE_EVENT = 'ember:ambient-motion';

export function readAmbientMotionPreference(): AmbientMotionPreference {
  try {
    const value = localStorage.getItem(AMBIENT_MOTION_STORAGE_KEY);
    return value === 'off' || value === 'static' ? value : 'dynamic';
  } catch {
    /* localStorage 不可用：使用默认动态 */
    return 'dynamic';
  }
}

export function writeAmbientMotionPreference(preference: AmbientMotionPreference): void {
  try {
    if (preference === 'dynamic') localStorage.removeItem(AMBIENT_MOTION_STORAGE_KEY);
    else localStorage.setItem(AMBIENT_MOTION_STORAGE_KEY, preference);
  } catch {
    /* 隐私模式等：仅本次会话生效 */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeAmbientMotionPreference(listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== null && event.key !== AMBIENT_MOTION_STORAGE_KEY) return;
    listener();
  };
  window.addEventListener(CHANGE_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}
