/**
 * 连线样式浮层：线型 / 箭头 / 颜色 / 走线四组。
 *
 * 纯展示组件：只接收归一后的当前样式与变更回调，不读 store、不碰 engine。
 * 点击任一项立即回调并保持浮层打开，便于连续调整；Esc / 点击外部关闭。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { EdgeStyleView } from './edge-layout.ts';
import type { EdgeStylePatch } from './canvas-interactions.ts';
import styles from './CanvasView.module.css';

interface LineOption {
  readonly value: EdgeStyleView['line'];
  readonly label: string;
}

interface ArrowOption {
  readonly value: EdgeStyleView['arrow'];
  readonly label: string;
}

interface ColorOption {
  readonly value: EdgeStyleView['color'];
  readonly label: string;
  readonly swatch: string;
}

const LINE_OPTIONS: readonly LineOption[] = [
  { value: 'solid', label: '实线' },
  { value: 'dashed', label: '虚线' },
];

const ARROW_OPTIONS: readonly ArrowOption[] = [
  { value: 'end', label: '单向' },
  { value: 'both', label: '双向' },
  { value: 'none', label: '无' },
];

const COLOR_OPTIONS: readonly ColorOption[] = [
  { value: 'default', label: '默认', swatch: 'var(--ember-edge)' },
  { value: 'primary', label: '强调', swatch: 'var(--ember-primary)' },
  { value: 'success', label: '成功', swatch: 'var(--ember-success)' },
  { value: 'warning', label: '警告', swatch: 'var(--ember-warning)' },
  { value: 'danger', label: '危险', swatch: 'var(--ember-danger)' },
];

const DEFAULT_LINE: EdgeStyleView['line'] = 'solid';
const DEFAULT_ARROW: EdgeStyleView['arrow'] = 'end';
const DEFAULT_COLOR: EdgeStyleView['color'] = 'default';
const DEFAULT_ROUTE: EdgeStyleView['route'] = 'curve';

export interface EdgeStyleMenuProps {
  readonly left: number;
  readonly top: number;
  readonly style: EdgeStyleView;
  readonly onChange: (patch: EdgeStylePatch) => void;
  readonly onClose: () => void;
}

export function EdgeStyleMenu({ left, top, style, onChange, onClose }: EdgeStyleMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left, top });

  /* 画布根容器 overflow:hidden；浮层比右键菜单高，靠近底部时「走线」分组会被裁掉。
   * 挂载后按实际尺寸夹到画布可视区内，保证「直角」始终可点。 */
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (menu === null) return;
    const parent = menu.offsetParent;
    const bounds =
      parent instanceof HTMLElement
        ? parent.getBoundingClientRect()
        : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    let dx = 0;
    let dy = 0;
    if (rect.right > bounds.right - margin) dx = rect.right - (bounds.right - margin);
    if (rect.bottom > bounds.bottom - margin) dy = rect.bottom - (bounds.bottom - margin);
    if (rect.left - dx < bounds.left + margin) dx = rect.left - (bounds.left + margin);
    if (rect.top - dy < bounds.top + margin) dy = rect.top - (bounds.top + margin);
    if (dx !== 0 || dy !== 0) {
      setPosition({ left: left - dx, top: top - dy });
    }
  }, [left, top]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (target === null) return;
      if (menuRef.current?.contains(target) === true) return;
      onClose();
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [onClose]);

  /* 选择默认值时提交 null，删除冗余键，落盘保持「缺省即默认」。 */
  const pickLine = (value: EdgeStyleView['line']): void =>
    onChange({ line: value === DEFAULT_LINE ? null : value });
  const pickArrow = (value: EdgeStyleView['arrow']): void =>
    onChange({ arrow: value === DEFAULT_ARROW ? null : value });
  const pickColor = (value: EdgeStyleView['color']): void =>
    onChange({ color: value === DEFAULT_COLOR ? null : value });
  const pickRoute = (value: EdgeStyleView['route']): void =>
    onChange({ route: value === DEFAULT_ROUTE ? null : value });

  return (
    <div
      ref={menuRef}
      className={styles.edgeStyleMenu}
      style={{ left: position.left, top: position.top }}
      role="group"
      aria-label="连线样式"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className={styles.edgeStyleGroup}>
        <span className={styles.edgeStyleGroupLabel}>线型</span>
        <div className={styles.edgeStyleOptions} role="radiogroup" aria-label="线型">
          {LINE_OPTIONS.map((option) => {
            const selected = style.line === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                className={styles.edgeStyleOption}
                data-selected={selected ? 'true' : 'false'}
                onClick={() => pickLine(option.value)}
              >
                <span>{option.label}</span>
                <span className={styles.edgeStyleCheck} aria-hidden="true">✓</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.edgeStyleGroup}>
        <span className={styles.edgeStyleGroupLabel}>箭头</span>
        <div className={styles.edgeStyleOptions} role="radiogroup" aria-label="箭头">
          {ARROW_OPTIONS.map((option) => {
            const selected = style.arrow === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                className={styles.edgeStyleOption}
                data-selected={selected ? 'true' : 'false'}
                onClick={() => pickArrow(option.value)}
              >
                <span>{option.label}</span>
                <span className={styles.edgeStyleCheck} aria-hidden="true">✓</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.edgeStyleGroup}>
        <span className={styles.edgeStyleGroupLabel}>颜色</span>
        <div className={styles.edgeStyleOptions} role="radiogroup" aria-label="颜色">
          {COLOR_OPTIONS.map((option) => {
            const selected = style.color === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                className={styles.edgeStyleOption}
                data-selected={selected ? 'true' : 'false'}
                onClick={() => pickColor(option.value)}
              >
                <span
                  className={styles.edgeStyleSwatch}
                  style={{ background: option.swatch }}
                  aria-hidden="true"
                />
                <span>{option.label}</span>
                <span className={styles.edgeStyleCheck} aria-hidden="true">✓</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={styles.edgeStyleGroup}>
        <span className={styles.edgeStyleGroupLabel}>走线</span>
        <div className={styles.edgeStyleOptions} role="radiogroup" aria-label="走线">
          <button
            type="button"
            role="radio"
            aria-checked={style.route === DEFAULT_ROUTE}
            className={styles.edgeStyleOption}
            data-selected={style.route === DEFAULT_ROUTE ? 'true' : 'false'}
            onClick={() => pickRoute('curve')}
          >
            <span>曲线</span>
            <span className={styles.edgeStyleCheck} aria-hidden="true">✓</span>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={style.route === 'orthogonal'}
            className={styles.edgeStyleOption}
            data-selected={style.route === 'orthogonal' ? 'true' : 'false'}
            onClick={() => pickRoute('orthogonal')}
          >
            <span>直角</span>
            <span className={styles.edgeStyleCheck} aria-hidden="true">✓</span>
          </button>
        </div>
      </div>
    </div>
  );
}