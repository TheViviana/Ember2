/**
 * CR-20261119-24：媒体播放支持判定与文案（纯函数，零 React / 零 IPC）。
 *
 * 复核修订口径：**`canPlayType` 不作拒绝依据**——对 mov/mp4 恒返回 "maybe"，
 * 区分不了 H.264 与 ProRes/HEVC；它只做能力预提示。真正判定走元素 `error`
 * 事件 + `media.error.code`，文案绑在 error 上，不静默、不误杀。
 */

/** 严格容器清单：只有这四种容器提供播放控件（其他格式不新增，现有额外媒体格式保留）。 */
export const PLAYABLE_CONTAINERS: readonly string[] = Object.freeze([
  'mp3',
  'm4a',
  'mp4',
  'mov',
]);

/** 容器可识别但编码不支持（ProRes/HEVC 等）时的固定文案。 */
export const CONTAINER_ONLY_MESSAGE = '容器已识别，此编码暂不支持';

/** 通用媒体加载失败文案（非编码类 error）。 */
export const MEDIA_LOAD_FAILED_MESSAGE = '媒体加载失败';

const MEDIA_ERROR_CODE_DECODE = 3;
const MEDIA_ERROR_CODE_SRC_NOT_SUPPORTED = 4;

/**
 * 元素 `error` 事件 → 用户文案：
 * - `MEDIA_ERR_SRC_NOT_SUPPORTED(4)` / `MEDIA_ERR_DECODE(3)` → 容器文案（编码不支持）；
 * - 其余（ABORT / NETWORK / 未知）→ 通用「媒体加载失败」。
 */
export function mediaLoadErrorMessage(errorCode: number | null | undefined): string {
  if (
    errorCode === MEDIA_ERROR_CODE_SRC_NOT_SUPPORTED ||
    errorCode === MEDIA_ERROR_CODE_DECODE
  ) {
    return CONTAINER_ONLY_MESSAGE;
  }
  return MEDIA_LOAD_FAILED_MESSAGE;
}

/** `canPlayType` 三值 → 能力预提示（仅 UI 提示，不决定是否渲染控件）。 */
export function canPlayHint(support: '' | 'maybe' | 'probably'): string | null {
  if (support === '') return '此格式可能无法播放';
  return null;
}

/** 严格容器判定（扩展名小写；供预提示与文案语境使用，不拦截渲染）。 */
export function isPlayableContainer(extension: string): boolean {
  return PLAYABLE_CONTAINERS.includes(extension);
}

/** 可暂停媒体的最小结构（HTMLMediaElement / 测试替身）。 */
export interface PauseableMedia {
  readonly paused: boolean;
  pause(): void;
}

/**
 * CR-28 B7：暂停集合内正在播放的媒体。
 *
 * `except` 用于“开始播放当前元素时暂停其他元素”；传 null 表示全暂停
 * （窗口卸载、切 tab、关闭预览）。返回实际暂停的数量，供调用方判断。
 * 只 pause，不改 src / 不 load，避免控件失效（CR-24 C3 教训）。
 */
export function pausePlayingMedia(
  elements: Iterable<PauseableMedia>,
  except: PauseableMedia | null = null,
): number {
  let paused = 0;
  for (const media of elements) {
    if (media === except) continue;
    if (media.paused) continue;
    media.pause();
    paused += 1;
  }
  return paused;
}
