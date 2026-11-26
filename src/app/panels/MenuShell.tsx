/** 右键菜单壳：接入键盘焦点管理（↑↓ 循环 / Esc 关闭并返还焦点），打开挂载时聚焦首个可用项。 */
import type { ReactNode } from 'react';
import { useMenuKeyboard } from '../canvas/use-menu-keyboard.ts';

export function MenuShell({ x, y, className, onClose, children }: {
  readonly x: number;
  readonly y: number;
  readonly className?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const { ref, onKeyDown } = useMenuKeyboard(onClose);
  return (
    <ul
      ref={ref}
      className={className}
      style={{ left: x, top: y }}
      role="menu"
      onKeyDown={onKeyDown}
      onPointerLeave={onClose}
    >
      {children}
    </ul>
  );
}
