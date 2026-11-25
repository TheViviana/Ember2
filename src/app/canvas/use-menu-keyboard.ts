/**
 * Cinematic Ember §8.1：画布菜单的键盘焦点管理。
 *
 * 菜单打开时焦点进入首个可用项；↑/↓ 在可用项间环绕；Esc 关闭并把焦点还给
 * 打开菜单前的元素。Enter/Space 交给按钮原生行为，左右键（子菜单导航）不在本轮范围。
 */
import { useLayoutEffect, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';
import { nextMenuIndex } from './menu-keyboard.ts';

function menuButtons(menu: HTMLElement): HTMLButtonElement[] {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('button'));
}

export function useMenuKeyboard(onClose: () => void): {
  readonly ref: RefObject<HTMLUListElement | null>;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLUListElement>) => void;
} {
  const ref = useRef<HTMLUListElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const opener = document.activeElement;
    // StrictMode 下 effect 会二次执行：第二次的 activeElement 已是菜单项，
    // 不能覆盖真正的外部触发器。
    if (!(opener instanceof HTMLElement) || ref.current?.contains(opener) !== true) {
      openerRef.current = opener instanceof HTMLElement ? opener : null;
    }
    const buttons = ref.current === null ? [] : menuButtons(ref.current);
    buttons.find((button) => !button.disabled)?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLUListElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      const opener = openerRef.current;
      if (opener !== null && opener.isConnected) opener.focus({ preventScroll: true });
      onClose();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    // 子面板经 portal 渲染，其按键会沿 React 树冒泡到这里；只有焦点仍在
    // 根菜单内时才接管方向键，避免从子面板里把焦点跳回顶层。
    if (ref.current === null || !ref.current.contains(document.activeElement)) return;
    const buttons = menuButtons(ref.current);
    if (buttons.length === 0) return;
    event.preventDefault();
    const current = buttons.findIndex((button) => button === document.activeElement);
    const enabled = buttons.map((button) => !button.disabled);
    const next = nextMenuIndex(enabled, current, event.key === 'ArrowDown' ? 1 : -1);
    buttons[next]?.focus({ preventScroll: true });
  };

  return { ref, onKeyDown };
}
