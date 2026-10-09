import { OUTLOOK_COLORS, type AgendaEvent, type AgendaView } from '@work-os/shared';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, type ItemSummary } from '../../../api';
import { Segmented, cx } from '../../../components/ui';
import { onTopics, useApiQuery } from '../../../hooks/useApiQuery';
import { useNow } from '../../../hooks/useNow';
import { dayEvents, type AgendaDay } from '../../../lib/agenda';
import { fmtAgo, fmtDayDate, fmtIn, fmtTime } from '../../../lib/format';
import { dayPins, dayStart, dueBefore, hourHeight, minuteOf, nextMeeting, placeMeetings, shortTitle, timelineSpan, workSpan, type Pin, type PinTone } from '../../../lib/timeline';

// The cockpit's time column (CK-3.4–3.6): the clock, the next meeting and what's due before it, and
// the day as a timeline of meetings and deadline pins. Meetings open in Outlook; pins open the item.

const OUTLOOK_CALENDAR = 'https://outlook.office.com/calendar/';

/** Where the timeline's lanes sit: hour labels, then meetings, then pins. */
const MEETINGS_LEFT = 44;
const MEETINGS_WIDTH = 186;
const PINS_LEFT = 238;
const PIN_HEIGHT = 22;
const MEETING_MIN_HEIGHT = 19;

const PIN_TONE: Record<PinTone, { pin: string; dot: string }> = {
  late: { pin: 'bg-red-wash text-red-fg', dot: 'bg-red' },
  now: { pin: 'bg-orange-wash text-orange-fg', dot: 'bg-orange' },
  today: { pin: 'bg-accent-wash text-accent-ink', dot: 'bg-accent' },
};

const categoryHex = (e: AgendaEvent) => (e.categories?.length ? OUTLOOK_COLORS[e.categories[0].color] : undefined);

/** "Matt M. · MVI V2 go/no-go": who it's from and what's due. */
const dueName = (i: ItemSummary) => `${i.title} · ${shortTitle(i)}`;

function NextMeetingCard({ v, items, now, onOpenItem }: { v: AgendaView; items: readonly ItemSummary[]; now: Date; onOpenItem: (id: string) => void }) {
  const next = nextMeeting(v.events, now);
  if (next.kind === 'none') {
    const t = next.tomorrow;
    return (
      <div data-testid="next-meeting" data-phase="none" className="rounded-[10px] border border-line bg-surface-2 px-4 py-3.5">
        <div className="text-xs font-semibold tracking-[0.04em] text-muted">NO MORE MEETINGS TODAY</div>
        {t ? (
          <a href={t.link ?? OUTLOOK_CALENDAR} target="_blank" rel="noreferrer" className="mt-1 block truncate text-[15px] font-medium !text-ink no-underline hover:underline">
            Tomorrow {fmtTime(t.start)} {t.title}
          </a>
        ) : (
          <div className="mt-1 text-[15px] text-ink-2">Nothing tomorrow either.</div>
        )}
      </div>
    );
  }
  const e = next.event;
  const due = dueBefore(items, e.start);
  const head = next.phase === 'now' ? `NOW · UNTIL ${fmtTime(e.end)}` : `NEXT · ${fmtIn(e.start, now).toUpperCase()}`;
  return (
    // The whole card opens the meeting in Outlook; what's due before it opens the item, above that link.
    <div data-testid="next-meeting" data-phase={next.phase} data-imminent={next.imminent || undefined} className={cx('relative rounded-[10px] border px-4 py-3.5', next.imminent ? 'border-amber-line bg-amber-wash' : 'border-accent-line bg-accent-wash')}>
      <div className={cx('flex justify-between text-xs font-semibold tracking-[0.04em]', next.imminent ? 'text-amber-fg' : 'text-accent-ink')}>
        <span>{head}</span>
        <span className="font-medium tracking-normal">Open in Outlook</span>
      </div>
      <a
        href={e.link ?? OUTLOOK_CALENDAR}
        target="_blank"
        rel="noreferrer"
        title={`${e.title}${e.organizer ? ` · ${e.organizer}` : ''}: open in Outlook`}
        className="mt-1 block truncate text-glance-m !text-ink no-underline after:absolute after:inset-0 after:rounded-[10px] hover:underline"
      >
        {fmtTime(e.start)} {e.title}
      </a>
      {next.also.length > 0 && (
        <div className="relative mt-0.5 w-fit text-xs text-ink-2" title={next.also.map((a) => `${fmtTime(a.start)} ${a.title}`).join('\n')}>
          +{next.also.length} at the same time
        </div>
      )}
      <div className="relative mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        {due.length ? (
          <>
            <span aria-hidden className="size-2 shrink-0 rotate-45 bg-orange" />
            <span className="text-orange-fg">Due before it:</span>
            {due.map((i, n) => (
              <button key={i.id} type="button" data-open-item={i.id} onClick={() => onOpenItem(i.id)} className="min-w-0 max-w-full truncate text-left text-orange-fg cursor-pointer hover:underline">
                {dueName(i)}
                {n < due.length - 1 ? ',' : ''}
              </button>
            ))}
          </>
        ) : (
          <span className="text-muted">Nothing due before it</span>
        )}
      </div>
    </div>
  );
}

/** Pins sit at their time, nudged down so none covers the one above it. */
function pinTops(pins: Pin[], top: (minute: number) => number): number[] {
  let floor = -Infinity;
  return pins.map((p) => {
    const at = Math.max(top(p.at) - PIN_HEIGHT / 2, floor);
    floor = at + PIN_HEIGHT + 2;
    return at;
  });
}

const fmtHour = (minute: number) => `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:00`;

function Timeline({ v, items, now, day, workHours, onOpenItem }: { v: AgendaView | undefined; items: readonly ItemSummary[]; now: Date; day: AgendaDay; workHours: string; onOpenItem: (id: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvailable(el.clientHeight));
    ro.observe(el);
    setAvailable(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const start = dayStart(now, day);
  const calendar = v && v.state !== 'off' && v.state !== 'never';
  const events = calendar ? dayEvents(v.events, now, day) : [];
  const allDay = events.filter((e) => e.allDay);
  const meetings = placeMeetings(events, start, now);
  const pins = dayPins(items, now, day);
  const nowMin = minuteOf(now.getTime(), start);
  const span = timelineSpan(workSpan(workHours), [...meetings.flatMap((m) => [m.from, m.to]), ...pins.map((p) => p.at), ...(day === 'today' ? [nowMin] : [])]);
  // A little room above the first hour and below the last, so their labels and pins aren't cut off.
  const pad = 12;
  const ph = hourHeight(available - 2 * pad, span);
  const top = (minute: number) => pad + ((minute - span.from) / 60) * ph;
  const height = top(span.to) + pad;
  const hours = Array.from({ length: (span.to - span.from) / 60 + 1 }, (_, n) => span.from + n * 60);
  const tops = pinTops(pins, top);

  // The now-line comes into view when the day is taller than the column: when the day shown or the
  // scale changes, not every minute.
  useEffect(() => {
    const el = scroller.current;
    const line = el?.querySelector<HTMLElement>('[data-testid="now-line"]');
    if (!el || !line || el.scrollHeight <= el.clientHeight) return;
    el.scrollTop = Math.max(0, line.offsetTop - el.clientHeight / 3);
  }, [start, day, ph]);

  return (
    <>
      {allDay.length > 0 && (
        <ul aria-label="All day" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {allDay.map((e) => (
            <li key={e.id} data-timeline-event={e.id}>
              <a href={e.link ?? OUTLOOK_CALENDAR} target="_blank" rel="noreferrer" className="inline-flex min-h-6 items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 text-xs !text-ink-2 no-underline hover:underline">
                <span className="font-semibold">All day</span> {e.title}
              </a>
            </li>
          ))}
        </ul>
      )}
      <div ref={scroller} data-testid="timeline" data-px-per-hour={ph} className="-mx-5 min-h-0 flex-1 overflow-y-auto px-5">
        <div className="relative" style={{ height }}>
          {hours.map((m) => (
            <div key={m} aria-hidden className="absolute inset-x-0 border-t border-line-soft" style={{ top: top(m) }}>
              <span className="absolute -top-2 left-0 bg-surface pr-1.5 font-mono text-xs text-faint">{fmtHour(m)}</span>
            </div>
          ))}
          {day === 'today' && <div aria-hidden className="absolute bg-past" style={{ left: MEETINGS_LEFT, width: MEETINGS_WIDTH, top: 0, height: top(nowMin) }} />}
          <ol aria-label={day === 'today' ? 'Today’s meetings' : 'Tomorrow’s meetings'} className="m-0 list-none p-0">
            {meetings.map((m) => {
              const hex = categoryHex(m.event);
              const w = MEETINGS_WIDTH / m.cols;
              const named = (m.event.categories ?? []).map((c) => c.name).join(', ');
              const h = Math.max(MEETING_MIN_HEIGHT, top(m.to) - top(m.from) - 2);
              // A short meeting is one line, so its time and title show however short the block.
              const short = h < 34;
              return (
                <li key={m.event.id} data-timeline-event={m.event.id} data-past={m.past || undefined} className="absolute" style={{ top: top(m.from), height: h, left: MEETINGS_LEFT + m.col * w, width: w - (m.cols > 1 ? 2 : 0) }}>
                  <a
                    href={m.event.link ?? OUTLOOK_CALENDAR}
                    target="_blank"
                    rel="noreferrer"
                    title={`${fmtTime(m.event.start)}–${fmtTime(m.event.end)} ${m.event.title}${named ? ` · ${named}` : ''}: open in Outlook`}
                    className={cx(
                      'flex h-full gap-1.5 overflow-hidden rounded-md border px-2 text-xs leading-[15px] no-underline hover:underline',
                      short ? 'items-center py-0' : 'py-[3px]',
                      m.past ? 'border-line bg-tray !text-faint' : 'border-accent-line bg-surface !text-ink',
                    )}
                  >
                    <span aria-hidden className="w-[3px] shrink-0 rounded-sm" style={{ background: hex ?? 'var(--gray-mid)' }} />
                    <span className={cx('min-w-0', short && 'truncate')}>
                      <b className="font-semibold">{fmtTime(m.event.start)}</b> {m.event.title}
                    </span>
                  </a>
                </li>
              );
            })}
          </ol>
          {/* Under the pins: an overdue pin sits on it. */}
          {day === 'today' && (
            <div data-testid="now-line" aria-hidden className="absolute right-0 border-t-2 border-red" style={{ left: 36, top: top(nowMin) - 1 }}>
              <span className="absolute -left-9 -top-[9px] rounded-[3px] bg-red px-[3px] py-px font-mono text-[11px] font-medium text-on-solid">{fmtTime(now)}</span>
            </div>
          )}
          <ol aria-label="Deadlines" className="m-0 list-none p-0">
            {pins.map((p, n) => (
              <li key={p.items.map((i) => i.id).join(',')} className="absolute right-0" style={{ top: tops[n], left: PINS_LEFT, height: PIN_HEIGHT }}>
                <button
                  type="button"
                  data-pin={p.tone}
                  data-open-item={p.items[0].id}
                  title={p.items.map((i) => `${i.next?.dueAt ? fmtTime(i.next.dueAt) : ''} ${i.title} · ${i.summary}`).join('\n')}
                  onClick={() => onOpenItem(p.items[0].id)}
                  className={cx('flex size-full items-center gap-1.5 overflow-hidden whitespace-nowrap rounded px-1.5 text-left text-xs cursor-pointer hover:brightness-[0.97]', PIN_TONE[p.tone].pin)}
                >
                  <span aria-hidden className={cx('size-1.5 shrink-0 rotate-45', PIN_TONE[p.tone].dot)} />
                  <span className="truncate">{p.label}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </>
  );
}

/** What the column says about the calendar itself, when it can't show the day as it is. */
function CalendarNote({ v, now }: { v: AgendaView | undefined; now: Date }) {
  if (!v) return null;
  if (v.state === 'auth_failed')
    return (
      <Link to="/settings/outlook" className="text-xs font-medium !text-red-fg">
        Calendar connector signed out
      </Link>
    );
  if (v.state === 'stale' && v.polledAt) return <span className="text-xs text-muted">Calendar read {fmtAgo(v.polledAt, now)} ago</span>;
  if (v.state === 'off')
    return (
      <span className="text-xs text-muted">
        Outlook Calendar is off. <Link to="/settings/outlook">Turn it on</Link> to see your meetings here.
      </span>
    );
  return null;
}

export function TimeColumn({ items, day, setDay, onOpenItem }: { items: readonly ItemSummary[]; day: AgendaDay; setDay: (d: AgendaDay) => void; onOpenItem: (id: string) => void }) {
  const now = useNow(15_000);
  const agenda = useApiQuery(() => api.getAgenda(), onTopics('inbox', 'settings', 'health'), []).data;
  const workHours = useApiQuery(() => api.getSettings(), onTopics('settings'), []).data?.settings.schedule.workHours ?? '';
  const calendar = agenda && agenda.state !== 'off' && agenda.state !== 'never';
  return (
    <section aria-label="Time" data-cockpit-zone="time" className="flex w-[400px] shrink-0 flex-col gap-4 border-r border-line px-5 pt-5">
      <div className="flex items-baseline justify-between">
        <div className="flex items-baseline gap-2.5">
          <span data-testid="clock" className="text-glance-xl tabular-nums">
            {fmtTime(now)}
          </span>
          <span className="text-sm text-muted">{fmtDayDate(now)}</span>
        </div>
        <Segmented
          size="sm"
          label="Day"
          value={day}
          onChange={setDay}
          options={[
            { value: 'today', label: 'Today' },
            { value: 'tomorrow', label: 'Tomorrow' },
          ]}
        />
      </div>
      {calendar && <NextMeetingCard v={agenda} items={items} now={now} onOpenItem={onOpenItem} />}
      <CalendarNote v={agenda} now={now} />
      <Timeline v={agenda} items={items} now={now} day={day} workHours={workHours} onOpenItem={onOpenItem} />
    </section>
  );
}
