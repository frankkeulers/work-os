import { OUTLOOK_COLORS, type AgendaEvent, type AgendaView } from '@work-os/shared';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { onTopics, useApiQuery } from '../hooks/useApiQuery';
import { useNow } from '../hooks/useNow';
import { dayEvents, phaseOf, wantsAnswer, type AgendaDay } from '../lib/agenda';
import { fmtAgo, fmtTime } from '../lib/format';
import { Icon } from './icons';
import { FutureButton, IconButton, Segmented, cx } from './ui';

// The agenda strip on the inbox (R2.8): today's or tomorrow's meetings from Outlook Calendar, the
// one on now picked out. A meeting opens in Outlook; "Not answered" opens its invite item. Hidden
// while the calendar is off, except in Full scope, which says how to turn it on.

const OUTLOOK_CALENDAR = 'https://outlook.office.com/calendar/';

function AgendaChip({ e, phase, onOpenItem }: { e: AgendaEvent; phase: 'past' | 'now' | 'later'; onOpenItem: (id: string) => void }) {
  const when = e.allDay ? 'All day' : fmtTime(e.start);
  const tag = 'inline-flex min-h-7 cursor-pointer items-center rounded-md border-0 bg-transparent px-1.5 text-xs font-medium hover:bg-bg';
  const categories = e.categories ?? [];
  const named = categories.map((c) => c.name).join(', ');
  // A meeting with Outlook categories has the first one's colour down its left edge, as in Outlook,
  // and a light shade of it behind (mixed into the surface, so it stays dark in the dark theme).
  const hex = categories.length ? OUTLOOK_COLORS[categories[0].color] : undefined;
  return (
    <li
      data-agenda-event={e.id}
      data-phase={phase}
      data-category-color={categories[0]?.color}
      className={cx('flex shrink-0 items-center gap-0.5 rounded-lg border pl-2 pr-0.5', categories.length > 0 && 'pl-3', phase === 'now' ? 'border-accent-line bg-accent-wash' : 'border-line-soft bg-surface', phase === 'past' && 'opacity-60')}
      style={hex ? { boxShadow: `inset 4px 0 0 ${hex}`, background: `color-mix(in srgb, ${hex} 14%, var(--surface))` } : undefined}
    >
      <a href={e.link ?? OUTLOOK_CALENDAR} target="_blank" rel="noreferrer" title={`${e.title}${e.organizer ? ` · ${e.organizer}` : ''}${named ? ` · ${named}` : ''}: open in Outlook`} className="flex min-h-9 max-w-[280px] items-center gap-1.5 pr-1.5 !text-ink no-underline hover:underline">
        <span className="font-mono text-xs text-ink-2">{when}</span>
        <span className="truncate">{e.title}</span>
        {phase === 'now' && <span className="rounded bg-accent-bg px-1 text-[10px] font-semibold text-on-solid no-underline">Now</span>}
        {named && <span className="sr-only">, {named}</span>}
      </a>
      {wantsAnswer(e) &&
        (e.inviteItemId ? (
          <button type="button" className={cx(tag, 'text-amber-fg')} onClick={() => onOpenItem(e.inviteItemId!)}>
            Not answered
          </button>
        ) : (
          <span className="px-1.5 text-xs font-medium text-amber-fg">Not answered</span>
        ))}
      {e.notesItemId && (
        <button type="button" className={cx(tag, 'text-accent-ink')} onClick={() => onOpenItem(e.notesItemId!)}>
          Notes
        </button>
      )}
    </li>
  );
}

/** Whether a sideways-scrolling list has more before or after what shows, for its fades and arrows. */
function useMoreAround(ref: RefObject<HTMLElement | null>, key: string) {
  const [more, setMore] = useState({ before: false, after: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return setMore({ before: false, after: false });
    const update = () => setMore({ before: el.scrollLeft > 1, after: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [ref, key]);
  return more;
}

/** What the strip says about the calendar itself, beside the meetings. */
function StateNote({ v, now }: { v: AgendaView; now: Date }) {
  if (v.state === 'auth_failed')
    return (
      <Link to="/settings/outlook" className="shrink-0 py-2 text-xs font-medium !text-red-fg">
        Connector signed out
      </Link>
    );
  if (v.state === 'stale' && v.polledAt) return <span className="shrink-0 py-2 text-xs text-muted">Read {fmtAgo(v.polledAt, now)} ago</span>;
  return null;
}

export function Agenda({ full, onOpenItem }: { full: boolean; onOpenItem: (id: string) => void }) {
  const q = useApiQuery(() => api.getAgenda(), onTopics('inbox', 'settings', 'health'), []);
  const now = useNow(60_000);
  const [day, setDay] = useState<AgendaDay>('today');
  const listRef = useRef<HTMLOListElement>(null);
  const v = q.data;
  const list = v ? dayEvents(v.events, now, day) : [];
  const more = useMoreAround(listRef, `${day}:${list.map((e) => e.id).join(',')}`);
  if (!v || (v.state === 'off' && !full)) return null;
  const page = (dir: 1 | -1) => listRef.current?.scrollBy({ left: dir * listRef.current.clientWidth * 0.8, behavior: 'smooth' });
  const arrow = 'absolute top-1/2 -translate-y-1/2 bg-surface shadow-sm';
  const empty = v.state === 'off' ? (
    <>
      Outlook Calendar is off. <Link to="/settings/outlook">Turn it on</Link> to see your meetings here.
    </>
  ) : v.state === 'never' ? (
    'Outlook Calendar hasn’t been read yet.'
  ) : (
    `No meetings ${day}.`
  );
  return (
    <section aria-label="Agenda" className="mx-6 mt-3 flex items-start gap-3 rounded-[10px] border border-line bg-bg py-1.5 pl-3 pr-2 text-[13px]">
      <Icon name="calendar" className="mt-2.5 shrink-0 text-muted" />
      <Segmented
        size="sm"
        label="Agenda day"
        className="shrink-0"
        value={day}
        onChange={setDay}
        options={[
          { value: 'today', label: 'Today' },
          { value: 'tomorrow', label: 'Tomorrow' },
        ]}
      />
      <div className="relative min-w-0 flex-1">
        {list.length ? (
          <>
            <ol ref={listRef} aria-label={day === 'today' ? 'Today’s meetings' : 'Tomorrow’s meetings'} className="m-0 flex list-none gap-1.5 overflow-x-auto p-0 py-0.5">
              {list.map((e) => (
                <AgendaChip key={e.id} e={e} phase={day === 'today' ? phaseOf(e, now) : 'later'} onOpenItem={onOpenItem} />
              ))}
            </ol>
            {/* Meetings past either edge fade out under an arrow that scrolls to them. */}
            {more.before && (
              <>
                <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-linear-to-r from-bg via-bg/80 to-transparent" />
                <IconButton label="Earlier meetings" icon="back" size={28} bordered className={cx(arrow, 'left-0')} onClick={() => page(-1)} />
              </>
            )}
            {more.after && (
              <>
                <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-linear-to-l from-bg via-bg/80 to-transparent" />
                <IconButton label="Later meetings" icon="forward" size={28} bordered className={cx(arrow, 'right-0')} onClick={() => page(1)} />
              </>
            )}
          </>
        ) : (
          <p className="m-0 py-2.5 text-muted">{empty}</p>
        )}
      </div>
      <StateNote v={v} now={now} />
      {full && (
        <div className="shrink-0 py-0.5">
          <FutureButton phase="P4" label="Meeting briefs" size="sm" />
        </div>
      )}
    </section>
  );
}
