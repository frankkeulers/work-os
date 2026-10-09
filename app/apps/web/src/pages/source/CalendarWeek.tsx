import { OUTLOOK_COLORS, londonAt, londonParts, mondayOf, type WeekEvent, type WeekView } from '@work-os/shared';
import { Link } from 'react-router';
import { CategoryTags } from '../../components/item';
import { Icon } from '../../components/icons';
import { Button, IconButton, cx } from '../../components/ui';
import { fmtAgo, fmtDate, fmtDayDate, fmtTime, plural } from '../../lib/format';
import { minuteOf, placeMeetings, timelineSpan, workSpan } from '../../lib/timeline';

// Outlook Calendar's history (cockpit CK-5.6): the week, Monday to Sunday, every meeting the
// calendar holds, cancelled and declined ones too, marked. A meeting opens its Wispr Flow notes or
// its invite in the item panel, or else a card with what the calendar says about it.

const OUTLOOK_CALENDAR = 'https://outlook.office.com/calendar/';
const PX_PER_HOUR = 48;
const HOURS_WIDTH = 44;
const MEETING_MIN_HEIGHT = 18;
/** Room above the first hour, so its label isn't under the day heads. */
const PAD = 10;

const fmtHour = (minute: number) => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:00`;
const noon = (dateKey: string) => new Date(`${dateKey}T12:00:00Z`);

/** The Monday `n` weeks from `monday`, as YYYY-MM-DD. */
export const weekFrom = (monday: string, n: number) => londonParts(londonAt(noon(monday), '12:00', 7 * n)).dateKey;

/** The item a meeting opens: its notes, else its invite. */
export const eventItem = (e: WeekEvent) => e.notesItemId ?? e.inviteItemId;

const RESPONSE: Record<string, string> = { accepted: 'Accepted', tentativelyAccepted: 'Tentative', declined: 'Declined', none: 'Not answered', notResponded: 'Not answered', organizer: 'Your meeting' };

function eventState(e: WeekEvent): string | undefined {
  if (e.cancelled) return 'Cancelled';
  if (e.response === 'declined') return 'Declined';
  return undefined;
}

function WeekNote({ week, now }: { week: WeekView; now: Date }) {
  if (week.state === 'off')
    return (
      <span className="text-xs text-muted">
        Outlook Calendar is off. <Link to="/settings/outlook">Turn it on</Link> to see your meetings here.
      </span>
    );
  if (week.state === 'never') return <span className="text-xs text-muted">The calendar hasn’t been read yet.</span>;
  if (week.state === 'auth_failed')
    return (
      <Link to="/settings/outlook" className="text-xs font-medium !text-red-fg">
        Calendar connector signed out
      </Link>
    );
  const from = londonAt(noon(week.weekStart), '00:00');
  const to = londonAt(noon(week.weekStart), '00:00', 7);
  const outside = week.held && (to <= week.held.from || from >= week.held.to);
  const partly = week.held && !outside && (from < week.held.from || to > week.held.to);
  return (
    <span data-week-note className="text-xs text-muted">
      {outside ? 'Not kept: the calendar holds this week and the next two.' : partly ? `Partly kept: the calendar holds ${fmtDayDate(week.held!.from)} to ${fmtDayDate(new Date(Date.parse(week.held!.to) - 1))}.` : null}
      {week.state === 'stale' && week.polledAt && ` Calendar read ${fmtAgo(week.polledAt, now)} ago.`}
    </span>
  );
}

export function CalendarWeek({ week, weekStart, setWeekStart, workHours, now, selected, onEvent }: { week: WeekView | undefined; weekStart: string; setWeekStart: (monday: string) => void; workHours: string; now: Date; selected?: string; onEvent: (e: WeekEvent) => void }) {
  const days = Array.from({ length: 7 }, (_, n) => londonParts(londonAt(noon(weekStart), '12:00', n)).dateKey);
  const today = londonParts(now).dateKey;
  const thisWeek = mondayOf(now);
  const events = week?.weekStart === weekStart ? week.events : [];
  const placed = days.map((d) => {
    const start = londonAt(noon(d), '00:00');
    const mine = events.filter((e) => e.end > start && e.start < londonAt(noon(d), '00:00', 1));
    return { day: d, start, allDay: mine.filter((e) => e.allDay), meetings: placeMeetings(mine, start, now) };
  });
  const span = timelineSpan(workSpan(workHours), placed.flatMap((p) => p.meetings.flatMap((m) => [m.from, m.to])));
  const top = (minute: number) => PAD + ((minute - span.from) / 60) * PX_PER_HOUR;
  const hours = Array.from({ length: (span.to - span.from) / 60 + 1 }, (_, n) => span.from + n * 60);
  const label = `${fmtDayDate(noon(days[0])).replace(/^\w+ /, '')} – ${fmtDate(noon(days[6]))}`;

  return (
    <section aria-label="Week" data-calendar-week={weekStart} className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 px-6 py-3">
        <IconButton label="Previous week" icon="back" size={32} onClick={() => setWeekStart(weekFrom(weekStart, -1))} />
        <IconButton label="Next week" icon="forward" size={32} onClick={() => setWeekStart(weekFrom(weekStart, 1))} />
        <h2 data-week-label className="m-0 text-[15px] font-semibold">
          {label}
        </h2>
        {weekStart !== thisWeek && (
          <Button size="sm" onClick={() => setWeekStart(thisWeek)}>
            This week
          </Button>
        )}
        <span className="flex-1" />
        {week && <WeekNote week={week} now={now} />}
        <span className="font-mono text-xs text-muted">{plural(events.length, 'meeting')}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto border-t border-line px-6 pb-6">
        <div className="grid min-w-[760px]" style={{ gridTemplateColumns: `${HOURS_WIDTH}px repeat(7, minmax(0, 1fr))` }}>
          {/* Day heads and all-day meetings, held at the top while the hours scroll. */}
          <div className="sticky top-0 z-10 bg-surface" />
          {placed.map((p) => (
            <div key={p.day} className="sticky top-0 z-10 flex flex-col gap-1 border-l border-line-soft bg-surface px-1.5 pb-1.5 pt-2">
              <div data-week-day={p.day} aria-current={p.day === today ? 'date' : undefined} className={cx('text-xs font-semibold', p.day === today ? 'text-accent-ink' : 'text-ink-2')}>
                {fmtDayDate(noon(p.day))}
              </div>
              {p.allDay.map((e) => (
                <EventBlock key={e.id} e={e} selected={selected === e.id} onEvent={onEvent} past={e.end <= now.toISOString()} allDay />
              ))}
            </div>
          ))}
          <div className="relative" style={{ height: top(span.to) + 8 }}>
            {hours.map((m) => (
              <span key={m} aria-hidden className="absolute left-0 -translate-y-1/2 font-mono text-[11px] text-faint" style={{ top: top(m) }}>
                {fmtHour(m)}
              </span>
            ))}
          </div>
          {placed.map((p) => (
            <ol key={p.day} aria-label={`${fmtDayDate(noon(p.day))} meetings`} className="relative m-0 list-none border-l border-line-soft p-0" style={{ height: top(span.to) + 8 }}>
              {/* The day gone so far, shaded as on the cockpit's time column. */}
              {p.day < today ? (
                <li aria-hidden className="absolute inset-0 bg-past" />
              ) : p.day === today ? (
                <li aria-hidden className="absolute inset-x-0 top-0 bg-past" style={{ height: top(minuteOf(now.getTime(), p.start)) }} />
              ) : null}
              {hours.map((m) => (
                <li key={m} aria-hidden className="absolute inset-x-0 border-t border-line-soft" style={{ top: top(m) }} />
              ))}
              {p.meetings.map((m) => {
                const w = 100 / m.cols;
                return (
                  <li key={m.event.id} className="absolute px-0.5" style={{ top: top(m.from), height: Math.max(MEETING_MIN_HEIGHT, top(m.to) - top(m.from) - 2), left: `${m.col * w}%`, width: `${w}%` }}>
                    <EventBlock e={m.event as WeekEvent} selected={selected === m.event.id} onEvent={onEvent} past={m.past} />
                  </li>
                );
              })}
              {p.day === today && (
                <li data-testid="week-now-line" aria-hidden className="absolute inset-x-0 border-t-2 border-red" style={{ top: top(minuteOf(now.getTime(), p.start)) - 1 }} />
              )}
            </ol>
          ))}
        </div>
      </div>
    </section>
  );
}

function EventBlock({ e, selected, onEvent, past, allDay }: { e: WeekEvent; selected: boolean; onEvent: (e: WeekEvent) => void; past: boolean; allDay?: boolean }) {
  const state = eventState(e);
  const hex = e.categories?.length ? OUTLOOK_COLORS[e.categories[0].color] : undefined;
  const linked = e.notesItemId ? 'Notes' : e.inviteItemId ? 'Invite' : undefined;
  return (
    <button
      type="button"
      data-week-event={e.id}
      data-state={state?.toLowerCase()}
      data-linked={linked?.toLowerCase()}
      aria-current={selected ? 'true' : undefined}
      title={`${allDay ? 'All day' : `${fmtTime(e.start)}–${fmtTime(e.end)}`} ${e.title}${e.organizer ? ` · ${e.organizer}` : ''}${state ? ` · ${state}` : ''}`}
      onClick={() => onEvent(e)}
      className={cx(
        'flex h-full w-full gap-1 overflow-hidden rounded-md border px-1.5 py-[3px] text-left text-[11px] leading-[14px] cursor-pointer',
        selected ? 'border-accent bg-accent-wash !text-ink' : state ? 'border-dashed border-line bg-surface-2 text-muted' : past ? 'border-line bg-tray text-faint' : 'border-accent-line bg-surface text-ink hover:bg-surface-2',
        allDay && 'min-h-6 items-center',
      )}
    >
      <span aria-hidden className="w-[3px] shrink-0 rounded-sm" style={{ background: hex ?? 'var(--gray-mid)' }} />
      <span className="min-w-0">
        {!allDay && <b className="font-semibold">{fmtTime(e.start)} </b>}
        <span className={cx(state && 'line-through')}>{e.title}</span>
        {state && <span className="ml-1 font-medium not-italic">{state}</span>}
        {linked && (
          <span className="ml-1 inline-flex items-center rounded bg-accent-wash px-1 font-medium text-accent-ink" data-event-link>
            {linked}
          </span>
        )}
      </span>
    </button>
  );
}

/** What the calendar knows about a meeting with no item behind it: read-only, and a link to Outlook. */
export function EventCard({ e, onClose }: { e: WeekEvent; onClose: () => void }) {
  const state = eventState(e);
  return (
    <div data-event-card={e.id} className="flex min-h-0 flex-1 flex-col bg-surface">
      <header className="flex items-center gap-2 border-b border-line px-5 py-3">
        <Icon name="calendar" size={16} className="text-muted" />
        <span className="text-xs font-semibold tracking-[0.04em] text-muted">MEETING</span>
        <span className="flex-1" />
        <IconButton label="Close" icon="x" size={32} onClick={onClose} />
      </header>
      <div className="flex flex-col gap-4 overflow-y-auto px-5 py-4">
        <div className="flex flex-col gap-1">
          <h2 className={cx('m-0 text-lg font-semibold', state && 'line-through')}>{e.title}</h2>
          <div className="text-[13px] text-ink-2">
            {fmtDayDate(e.start)} · {e.allDay ? 'All day' : `${fmtTime(e.start)}–${fmtTime(e.end)}`}
            {state && <span className="ml-2 font-medium text-amber-fg">{state}</span>}
          </div>
        </div>
        <dl className="m-0 grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-[13px]">
          {e.organizer && (
            <>
              <dt className="text-muted">Organiser</dt>
              <dd className="m-0">{e.organizer}</dd>
            </>
          )}
          {e.response && (
            <>
              <dt className="text-muted">Your answer</dt>
              <dd className="m-0">{RESPONSE[e.response] ?? e.response}</dd>
            </>
          )}
          {e.showAs && (
            <>
              <dt className="text-muted">Shows as</dt>
              <dd className="m-0">{e.showAs}</dd>
            </>
          )}
          {e.attendees?.length ? (
            <>
              <dt className="text-muted">Invited</dt>
              <dd className="m-0">{e.attendees.join(', ')}</dd>
            </>
          ) : null}
          {e.categories?.length ? (
            <>
              <dt className="text-muted">Categories</dt>
              <dd className="m-0">
                <CategoryTags tags={e.categories} />
              </dd>
            </>
          ) : null}
        </dl>
        <div className="flex flex-wrap gap-2">
          <a href={e.link ?? OUTLOOK_CALENDAR} target="_blank" rel="noreferrer" className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-[13px] font-medium !text-ink no-underline hover:bg-surface-2">
            <Icon name="external" size={14} /> Open in Outlook
          </a>
        </div>
        <p className="m-0 text-xs text-muted">No Wispr Flow notes or invite for this meeting, so there’s nothing to file. Notes joined to it open instead of this card once they arrive.</p>
      </div>
    </div>
  );
}
