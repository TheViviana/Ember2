/* CR-20261121-45 项7：通知三态轮廓图标（theme-v1.1.md §1.5：颜色不是唯一通道）。
 * info/成功档=圆内对勾（最轻）、warning=三角感叹号（描边块）、error=八角叉（反色块）。
 * 线宽 1.5px、round join/cap，随 currentColor 取灰阶重量。 */

export interface NoticeIconProps {
  readonly tone: 'info' | 'warning' | 'error';
  readonly size?: number;
}

export function NoticeIcon({ tone, size = 16 }: NoticeIconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  if (tone === 'warning') {
    return (
      <svg {...common}>
        <path d="M8 1.8 15 14H1Z" />
        <path d="M8 6v3.6" />
        <path d="M8 11.5v.01" />
      </svg>
    );
  }
  if (tone === 'error') {
    return (
      <svg {...common}>
        <path d="M5.2 1.5h5.6l3.7 3.7v5.6l-3.7 3.7H5.2l-3.7-3.7V5.2Z" />
        <path d="m6.2 6.2 3.6 3.6" />
        <path d="m9.8 6.2-3.6 3.6" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="6.5" />
      <path d="m5.2 8.2 2.2 2.2 3.8-4" />
    </svg>
  );
}
