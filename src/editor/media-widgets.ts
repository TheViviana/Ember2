/**
 * 编辑器行内媒体控件。只呈现库内只读 `media://` URL，不修改 CodeMirror 文档。
 */
import { WidgetType } from '@codemirror/view';
import { mediaUrlForPath } from '../core/media-url.ts';

export interface MediaWidgetSpec {
  readonly kind: 'image' | 'audio' | 'video';
  readonly path: string;
  readonly label: string;
}

const LOAD_ERROR = '媒体加载失败：文件不存在或格式不受支持';

export class MediaPreviewWidget extends WidgetType {
  private readonly elements = new WeakMap<HTMLElement, HTMLMediaElement | HTMLImageElement>();
  private readonly spec: MediaWidgetSpec;

  constructor(spec: MediaWidgetSpec) {
    super();
    this.spec = spec;
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof MediaPreviewWidget &&
      other.spec.kind === this.spec.kind &&
      other.spec.path === this.spec.path &&
      other.spec.label === this.spec.label
    );
  }

  toDOM(): HTMLElement {
    const root = document.createElement('span');
    root.className = `ember-media-preview ember-media-${this.spec.kind}`;
    root.contentEditable = 'false';
    root.dataset.mediaKind = this.spec.kind;
    root.dataset.mediaPath = this.spec.path;

    const media = document.createElement(this.spec.kind === 'image' ? 'img' : this.spec.kind);
    media.setAttribute('src', mediaUrlForPath(this.spec.path));
    media.setAttribute('aria-label', this.spec.label);
    media.setAttribute('title', this.spec.label);
    if (media instanceof HTMLImageElement) {
      media.alt = this.spec.label;
      media.loading = 'lazy';
    } else {
      media.controls = true;
      media.preload = 'metadata';
      if (media instanceof HTMLVideoElement) media.playsInline = true;
    }

    const error = document.createElement('span');
    error.className = 'ember-media-error';
    error.setAttribute('role', 'alert');
    error.textContent = LOAD_ERROR;
    error.hidden = true;
    const showError = (): void => {
      error.hidden = false;
      root.dataset.mediaError = 'true';
    };
    const clearError = (): void => {
      error.hidden = true;
      delete root.dataset.mediaError;
    };
    media.addEventListener('error', showError);
    media.addEventListener(this.spec.kind === 'image' ? 'load' : 'loadedmetadata', clearError);

    const label = document.createElement('span');
    label.className = 'ember-media-label';
    label.textContent = this.spec.label;
    root.append(media, label, error);
    this.elements.set(root, media);
    return root;
  }

  override ignoreEvent(): boolean {
    // 控件事件留给原生 audio/video；源码通过键盘选区进入引用范围后显示。
    return true;
  }

  override destroy(root: HTMLElement): void {
    const media = this.elements.get(root);
    this.elements.delete(root);
    if (!media) return;
    if (this.spec.kind !== 'image') {
      const player = media as HTMLMediaElement;
      player.pause();
      player.removeAttribute('src');
      player.load();
    } else {
      media.removeAttribute('src');
    }
  }
}
