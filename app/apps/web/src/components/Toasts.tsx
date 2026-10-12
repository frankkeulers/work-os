import { useEffect, useState } from 'react';
import { useOpenItem } from '../hooks/useOpenItem';
import { useToasts, type OsNotification, type Toast } from '../store/toasts';
import { BrandMark } from './brand/BrandMark';
import { Icon } from './icons';
import { Kbd, cx } from './ui';

function ToastRow({ t }: { t: Toast }) {
  const dismiss = useToasts((s) => s.dismiss);
  const ttl = t.ttl ?? (t.action ? 7000 : 4500);
  // Held while the pointer or focus is on it, so what it asks can be read and answered; the
  // countdown starts again when they leave.
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (held) return;
    const id = setTimeout(() => dismiss(t.id), ttl);
    return () => clearTimeout(id);
  }, [t, ttl, dismiss, held]);
  const tone = t.tone ?? 'default';
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      data-held={held || undefined}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setHeld(false)}
      className="pointer-events-auto relative flex w-[380px] max-w-full items-start gap-3 overflow-hidden rounded-xl border border-line bg-surface p-3.5 text-ink shadow-[0_12px_32px_rgba(20,23,28,0.16)]"
    >
      <span className={cx('mt-px inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full', TONE[tone])}>
        <Icon name={tone === 'success' ? 'check' : tone === 'error' ? 'alert' : 'info'} size={15} strokeWidth={2.25} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-1">
        <span className="text-sm font-medium leading-snug">{t.message}</span>
        {t.description && <span className="text-[13px] leading-snug text-muted">{t.description}</span>}
        {t.body}
        {t.action && (
          <button
            type="button"
            className="mt-1.5 self-start text-[13px] font-semibold text-accent hover:underline cursor-pointer"
            onClick={() => {
              t.action!.run();
              dismiss(t.id);
            }}
          >
            {t.action.label}
            {t.action.label === 'Undo' && (
              <span aria-hidden className="ml-1.5">
                <Kbd>z</Kbd>
              </span>
            )}
          </button>
        )}
      </div>
      <button type="button" aria-label="Dismiss" className="-mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-ink cursor-pointer" onClick={() => dismiss(t.id)}>
        <Icon name="x" size={14} />
      </button>
      {/* Runs down until the toast closes. */}
      {!held && <span aria-hidden data-countdown className={cx('toast-countdown absolute inset-x-0 bottom-0 h-0.5 bg-current opacity-60', BAR[tone])} style={{ animationDuration: `${ttl}ms` }} />}
    </div>
  );
}

const BAR = { default: 'text-accent', success: 'text-green-fg', error: 'text-red-fg' } as const;

const TONE = {
  default: 'bg-accent-wash text-accent',
  success: 'bg-teal-wash text-green-fg',
  error: 'bg-red-line/15 text-red-fg',
} as const;

function NotificationCard({ n }: { n: OsNotification }) {
  const dismiss = useToasts((s) => s.dismissNotification);
  const openItem = useOpenItem();
  useEffect(() => {
    const id = setTimeout(() => dismiss(n.id), 9000);
    return () => clearTimeout(id);
  }, [n, dismiss]);
  return (
    <button
      type="button"
      data-testid="os-notification"
      onClick={() => {
        dismiss(n.id);
        openItem(n.itemId);
      }}
      className="pointer-events-auto flex w-[360px] items-start gap-3 rounded-[14px] border border-line bg-surface/95 p-3 text-left shadow-[0_16px_40px_rgba(20,23,28,0.22)] backdrop-blur cursor-pointer hover:bg-surface"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-solid text-on-solid">
        <BrandMark size={22} state="attention" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2 text-xs text-muted">
          <span className="flex-1 font-semibold text-ink">Work OS · Now</span>
          now
        </span>
        <span className="text-[13px] font-semibold">{n.title}</span>
        <span className="text-[13px] leading-snug text-ink-2">{n.summary}</span>
      </span>
    </button>
  );
}

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const notifications = useToasts((s) => s.notifications);
  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-5 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
        {toasts.map((t) => (
          <ToastRow key={t.id} t={t} />
        ))}
      </div>
      <div className="pointer-events-none fixed right-4 top-[72px] z-[70] flex flex-col gap-2" aria-live="polite" aria-label="Notifications">
        {notifications.map((n) => (
          <NotificationCard key={n.id} n={n} />
        ))}
      </div>
    </>
  );
}
