import { OUTLOOK_COLORS } from '@work-os/shared';
import { api } from '../api';
import { onTopics, useApiQuery } from '../hooks/useApiQuery';
import { useNow } from '../hooks/useNow';
import { nextUp } from '../lib/agenda';
import { fmtTime } from '../lib/format';
import { Icon } from './icons';
import { cx } from './ui';

// The next meeting, in the sidebar on every page (R2.8): from a few minutes before it starts (5 by
// default, Settings › Notifications) until it starts, for meetings Frank is going to. A quiet line,
// not an alert: no sound, no motion, not announced; the countdown turns amber in the last two
// minutes. It opens the meeting in Outlook, where the Join button is.

const OUTLOOK_CALENDAR = 'https://outlook.office.com/calendar/';

export function NextMeeting({ collapsed }: { collapsed: boolean }) {
  const q = useApiQuery(() => api.getAgenda(), onTopics('inbox', 'settings', 'health'), []);
  const now = useNow(15_000);
  const v = q.data;
  const next = v && v.state !== 'off' && v.state !== 'never' ? nextUp(v.events, now, v.leadMinutes) : undefined;
  if (!next) return null;
  const e = next.event;
  const when = `in ${next.minutes} min`;
  const hex = e.categories?.length ? OUTLOOK_COLORS[e.categories[0].color] : undefined;
  const line = `${fmtTime(e.start)} ${e.title}${next.more ? ` +${next.more} more` : ''}`;
  return (
    <section aria-label="Next meeting" data-next-meeting={e.id} data-imminent={next.imminent || undefined}>
      <a
        href={e.link ?? OUTLOOK_CALENDAR}
        target="_blank"
        rel="noreferrer"
        title={`Next meeting, ${when}: ${line}. Open in Outlook`}
        className={cx('relative flex rounded-lg border border-line-soft bg-surface-2 !text-ink no-underline hover:border-line', collapsed ? 'min-h-10 items-center justify-center' : 'flex-col gap-0.5 py-2 pl-3 pr-2.5')}
        style={hex ? { boxShadow: `inset 3px 0 0 ${hex}`, background: `color-mix(in srgb, ${hex} 14%, var(--surface))` } : undefined}
      >
        {collapsed ? (
          <>
            <Icon name="calendar" className="shrink-0 text-ink-2" />
            <span className={cx('absolute right-0.5 top-0.5 min-w-4 rounded-full px-1 text-center font-mono text-[10px] leading-4 text-on-solid', next.imminent ? 'bg-amber-fg' : 'bg-ink-2')}>{next.minutes}</span>
            <span className="sr-only">
              Next meeting, {when}: {line}
            </span>
          </>
        ) : (
          <>
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
              <Icon name="clock" size={12} />
              Next ·<span className={cx('normal-case tracking-normal', next.imminent ? 'text-amber-fg' : 'text-ink-2')}>{when}</span>
            </span>
            <span className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
              <span className="font-mono text-xs text-ink-2">{fmtTime(e.start)}</span>
              <span className="min-w-0 truncate">{e.title}</span>
              {next.more > 0 && <span className="shrink-0 text-xs text-muted">+{next.more} more</span>}
            </span>
          </>
        )}
      </a>
    </section>
  );
}
