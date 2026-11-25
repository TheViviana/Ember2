/**
 * 媒体库播放协调：窗口内同时只播放一个 audio/video。
 *
 * 只 pause，**不 removeAttribute('src') / load()**——元素由 React 管理，
 * 外部改 src 后 React 不会回写，控件会变成死控件（CR-24 C3 教训）。
 * 暂停逻辑抽成 `pausePlayingMedia` 纯函数，供单元测试覆盖 B7。
 */
import { useCallback } from 'react';
import type { RefObject, SyntheticEvent } from 'react';
import { pausePlayingMedia } from '../../../features/media/media-playback.ts';

export interface MediaPlaybackControls {
  readonly pauseAllMedia: () => void;
  readonly handlePlay: (event: SyntheticEvent<HTMLMediaElement>) => void;
}

export function useMediaPlayback(
  rootRef: RefObject<HTMLElement | null>,
): MediaPlaybackControls {
  const pauseAllMedia = useCallback((): void => {
    const root = rootRef.current;
    if (root === null) return;
    pausePlayingMedia(Array.from(root.querySelectorAll<HTMLMediaElement>('audio, video')));
  }, [rootRef]);

  const handlePlay = useCallback(
    (event: SyntheticEvent<HTMLMediaElement>): void => {
      const root = rootRef.current;
      if (root === null) return;
      pausePlayingMedia(
        Array.from(root.querySelectorAll<HTMLMediaElement>('audio, video')),
        event.currentTarget,
      );
    },
    [rootRef],
  );

  return { pauseAllMedia, handlePlay };
}
