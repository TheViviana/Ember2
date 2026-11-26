/* CR-20261121-45 项7：通知三态轮廓图标（theme-v1.1.md §1.5：颜色不是唯一通道）。
 * info/成功档=圆内对勾（最轻）、warning=三角感叹号（描边块）、error=八角叉（反色块）。
 * 几何走统一 Icon：16 坐标系下有效描边 1.25px，随 currentColor 取灰阶重量。 */
import { Icon, type IconSize } from '../../ui/icon.tsx';

export interface NoticeIconProps {
  readonly tone: 'info' | 'warning' | 'error';
  readonly size?: IconSize;
}

export function NoticeIcon({ tone, size = 16 }: NoticeIconProps) {
  if (tone === 'warning') {
    return (
      <Icon size={size} viewBox="0 0 16 16">
        <path d="M8 1.8 15 14H1Z" />
        <path d="M8 6v3.6" />
        <path d="M8 11.5v.01" />
      </Icon>
    );
  }
  if (tone === 'error') {
    return (
      <Icon size={size} viewBox="0 0 16 16">
        <path d="M5.2 1.5h5.6l3.7 3.7v5.6l-3.7 3.7H5.2l-3.7-3.7V5.2Z" />
        <path d="m6.2 6.2 3.6 3.6" />
        <path d="m9.8 6.2-3.6 3.6" />
      </Icon>
    );
  }
  return (
    <Icon size={size} viewBox="0 0 16 16">
      <circle cx="8" cy="8" r="6.5" />
      <path d="m5.2 8.2 2.2 2.2 3.8-4" />
    </Icon>
  );
}
