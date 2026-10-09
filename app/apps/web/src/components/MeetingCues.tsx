import { OUTLOOK_COLORS } from '@work-os/shared';
import { api } from '../api';
import { onTopics, useApiQuery } from '../hooks/useApiQuery';
import { useNow } from '../hooks/useNow';
import { meetingCues, type MeetingCue } from '../lib/agenda';
import { fmtTime } from '../lib/format';
import { Icon } from './icons';
import { cx } from './ui';

// Meetings now and next, in the sidebar on every page (R2.8), for meetings Frank is going to: one
// from a few minutes before it starts (5 by default, Settings › Notifications), and on as "Now"
// until it ends. Overlapping meetings are a row each, those on now first. A quiet list, not an
// alert: no sound, no motion, not announced; a countdown turns amber in the last two minutes. Each
// row opens its meeting in Outlook, where the Join button is.

const OUTLOOK_CALENDAR = 'https://outlook.office.com/calendar/';
/** Rows shown before "+N more". */
const MAX_ROWS = 3;

const label = (c: MeetingCue) => (c.phase === 'now' ? `until ${fmtTime(c.event.end)}` : `in ${c.minutes} min`);
const lineOf = (c: MeetingCue) => `${c.phase === 'now' ? 'Now' : 'Next'}, ${label(c)}: ${fmtTime(c.event.start)} ${c.event.title}`;
const tint = (c: MeetingCue) => {
  const cat = c.event.categories?.[0];
  const hex = cat ? OUTLOOK_COLORS[cat.color] : undefined;
  return hex ? { boxShadow: `inset 3px 0 0 ${hex}`, background: `color-mix(in srgb, ${hex} 14%, var(--surface))` } : undefined;
};

function CueRow({ c }: { c: MeetingCue }) {
  const e = c.event;
  return (
    <li data-meeting-cue={e.id} data-phase={c.phase} data-imminent={c.imminent || undefined}>
      <a
        href={e.link ?? OUTLOOK_CALENDAR}
        target="_blank"
        rel="noreferrer"
        title={`${lineOf(c)}. Open in Outlook`}
        className="flex flex-col gap-0.5 rounded-lg border border-line-soft bg-surface-2 py-2 pl-3 pr-2.5 !text-ink no-underline hover:border-line"
        style={tint(c)}
      >
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
          <Icon name="clock" size={12} />
          {c.phase === 'now' ? <span className="text-accent-ink">Now</span> : 'Next'} ·
          <span className={cx('normal-case tracking-normal', c.imminent ? 'text-amber-fg' : 'text-ink-2')}>{label(c)}</span>
        </span>
        <span className="flex min-w-0 items-baseline gap-1.5 text-[13px]">
          <span className="font-mono text-xs text-ink-2">{fmtTime(e.start)}</span>
          <span className="min-w-0 truncate">{e.title}</span>
        </span>
      </a>
    </li>
  );
}

export function MeetingCues({ collapsed }: { collapsed: boolean }) {
  const q = useApiQuery(() => api.getAgenda(), onTopics('inbox', 'settings', 'health'), []);
  const now = useNow(15_000);
  const v = q.data;
  const cues = v && v.state !== 'off' && v.state !== 'never' ? meetingCues(v.events, now, v.leadMinutes) : [];
  if (!cues.length) return null;
  const shown = cues.slice(0, MAX_ROWS);
  const hidden = cues.length - shown.length;
  const all = cues.map(lineOf).join('; ');

  if (collapsed) {
    // One tile: the first meeting to come, its minutes as a badge; a dot when only meetings on now.
    const first = cues.find((c) => c.phase === 'next');
    const lead = first ?? cues[0];
    return (
      <section aria-label="Meetings now and next" data-meeting-cues={cues.length}>
        <a
          href={lead.event.link ?? OUTLOOK_CALENDAR}
          target="_blank"
          rel="noreferrer"
          title={`${all}. Open in Outlook`}
          className="relative flex min-h-10 items-center justify-center rounded-lg border border-line-soft bg-surface-2 !text-ink no-underline hover:border-line"
          style={tint(lead)}
        >
          <Icon name="calendar" className="shrink-0 text-ink-2" />
          {first ? (
            <span className={cx('absolute right-0.5 top-0.5 min-w-4 rounded-full px-1 text-center font-mono text-[10px] leading-4 text-on-solid', first.imminent ? 'bg-amber-fg' : 'bg-ink-2')}>{first.minutes}</span>
          ) : (
            <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-accent-bg" />
          )}
          <span className="sr-only">{all}</span>
        </a>
      </section>
    );
  }
  return (
    <section aria-label="Meetings now and next" data-meeting-cues={cues.length}>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {shown.map((c) => (
          <CueRow key={c.event.id} c={c} />
        ))}
      </ul>
      {hidden > 0 && (
        <a href={OUTLOOK_CALENDAR} target="_blank" rel="noreferrer" title={`${all}. Open Outlook Calendar`} className="mt-1 block px-3 text-xs text-muted no-underline hover:underline">
          +{hidden} more
        </a>
      )}
    </section>
  );
}
