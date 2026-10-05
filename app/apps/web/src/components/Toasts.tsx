import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import { useToasts, type OsNotification, type Toast } from '../store/toasts';
import { Icon } from './icons';
import { cx } from './ui';

function ToastRow({ t }: { t: Toast }) {
  const dismiss = useToasts((s) => s.dismiss);
  useEffect(() => {
    const id = setTimeout(() => dismiss(t.id), t.ttl ?? (t.action ? 7000 : 4500));
    return () => clearTimeout(id);
  }, [t, dismiss]);
  return (
    <div
      role={t.tone === 'error' ? 'alert' : 'status'}
      className={cx(
        'pointer-events-auto flex max-w-[560px] items-center gap-3 rounded-[10px] px-4 py-2.5 text-[13px] shadow-[0_12px_32px_rgba(20,23,28,0.24)]',
        t.tone === 'error' ? 'bg-red text-on-solid' : 'bg-solid text-on-solid',
      )}
    >
      {t.tone === 'success' && <Icon name="check" strokeWidth={2.5} />}
      {t.tone === 'error' && <Icon name="alert" />}
      <span className="flex-1">{t.message}</span>
      {t.action && (
        <button
          type="button"
          className="rounded-md px-2 py-1 font-semibold text-accent-light underline-offset-2 hover:underline cursor-pointer"
          onClick={() => {
            t.action!.run();
            dismiss(t.id);
          }}
        >
          {t.action.label}
        </button>
      )}
      <button type="button" aria-label="Dismiss" className="opacity-70 hover:opacity-100 cursor-pointer" onClick={() => dismiss(t.id)}>
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

function NotificationCard({ n }: { n: OsNotification }) {
  const dismiss = useToasts((s) => s.dismissNotification);
  const navigate = useNavigate();
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
        navigate(`/item/${encodeURIComponent(n.itemId)}`);
      }}
      className="pointer-events-auto flex w-[360px] items-start gap-3 rounded-[14px] border border-line bg-surface/95 p-3 text-left shadow-[0_16px_40px_rgba(20,23,28,0.22)] backdrop-blur cursor-pointer hover:bg-surface"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-solid text-sm font-semibold text-on-solid">W</span>
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
      <div className="pointer-events-none fixed right-4 top-4 z-[70] flex flex-col gap-2" aria-live="polite" aria-label="Notifications">
        {notifications.map((n) => (
          <NotificationCard key={n.id} n={n} />
        ))}
      </div>
    </>
  );
}
