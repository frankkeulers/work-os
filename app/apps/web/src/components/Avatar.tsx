import { usePrefs } from '../store/prefs';
import { Icon } from './icons';
import { cx } from './ui';

/** The profile picture from Settings › Appearance, or a person icon until one is set. Decorative: label its control. */
export function Avatar({ size = 28, className }: { size?: number; className?: string }) {
  const src = usePrefs((s) => s.avatar);
  if (src) return <img src={src} alt="" width={size} height={size} data-avatar="picture" className={cx('shrink-0 rounded-full object-cover', className)} />;
  return (
    <span aria-hidden="true" data-avatar="icon" style={{ width: size, height: size }} className={cx('inline-flex shrink-0 items-center justify-center rounded-full bg-track text-ink-2', className)}>
      <Icon name="user" size={Math.round(size * 0.58)} />
    </span>
  );
}
