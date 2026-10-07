import { initialsOf } from '../lib/profile';
import { usePrefs } from '../store/prefs';
import { Icon } from './icons';
import { cx } from './ui';

/**
 * The profile picture from Settings › Profile; until one is set, the initials of the name there, or a
 * person icon without a name. Decorative: label the control it sits in.
 */
export function Avatar({ size = 28, className }: { size?: number; className?: string }) {
  const src = usePrefs((s) => s.avatar);
  const initials = usePrefs((s) => initialsOf(s));
  if (src) return <img src={src} alt="" width={size} height={size} data-avatar="picture" className={cx('shrink-0 rounded-full object-cover', className)} />;
  const frame = cx('inline-flex shrink-0 select-none items-center justify-center rounded-full', className);
  if (initials)
    return (
      <span aria-hidden="true" data-avatar="initials" style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }} className={cx(frame, 'bg-accent-wash font-semibold leading-none text-accent-ink')}>
        {initials}
      </span>
    );
  return (
    <span aria-hidden="true" data-avatar="icon" style={{ width: size, height: size }} className={cx(frame, 'bg-track text-ink-2')}>
      <Icon name="user" size={Math.round(size * 0.58)} />
    </span>
  );
}
