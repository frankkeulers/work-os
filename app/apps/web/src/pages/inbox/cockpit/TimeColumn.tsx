import { OUTLOOK_COLORS, londonAt, mondayOf, type AgendaEvent, type AgendaView, type TodoSummary } from '@work-os/shared';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, type ItemSummary } from '../../../api';
import { BrandIcon } from '../../../components/BrandIcon';
import { Icon } from '../../../components/icons';
import { Button, IconButton, Segmented, cx } from '../../../components/ui';
import { useResizable } from '../../../components/useResizable';
import { onTopics, useApiQuery } from '../../../hooks/useApiQuery';
import { useNow } from '../../../hooks/useNow';
import { dayEvents } from '../../../lib/agenda';
import { fmtAgo, fmtDayDate, fmtIn, fmtTime } from '../../../lib/format';
import { OUTLOOK_CALENDAR, meetingLink } from '../../../lib/links';
import { TIME_WIDTH, usePrefs } from '../../../store/prefs';
import { dayPins, dayStart, dueBefore, hourHeight, minuteOf, nextMeeting, placeMeetings, placeTodos, shortTitle, timelineSpan, workSpan, type Pin, type PinTone } from '../../../lib/timeline';
import { TodoDrawer, openTodoPlan, todoCounts } from '../TodoGroup';

// The cockpit's time column (CK-3.4–3.6): the clock, the next meeting and what's due before it, and
// the day as a timeline of meetings and deadline pins. As in Outlook, Today and the arrows under the
// header step through the days the calendar holds; Calendar and To Dos in the header switch what
// the column shows. A Teams meeting joins in the browser until it
// ends; other meetings open in Outlook; pins open the item. A meeting with Outlook categories has the
// first one's colour down its edge and a light shade of it behind, as on the agenda strip.
// It folds to a rail, and its right edge drags to widen it; both are kept in prefs. The time Work OS
// planned for each To Do (FR-16.8) shows in the meetings' lane, dashed (solid when Frank set it);
// a click opens its plan under the To Dos tab, which lists them all in place of the day (FR-16.2):
// the cockpit's one place for To Dos.

/** Where the timeline's lanes sit: hour labels, then meetings, then pins. The meetings take 60% of
 * the width after the labels (186 px at the default width) and the pins the rest, as the column widens. */
const MEETINGS_LEFT = 44;
const MEETINGS_SHARE = 0.6;
const LANE_GAP = 8;
const PIN_HEIGHT = 22;
const MEETING_MIN_HEIGHT = 19;

const PIN_TONE: Record<PinTone, { pin: string; dot: string }> = {
  late: { pin: 'bg-red-wash text-red-fg', dot: 'bg-red' },
  now: { pin: 'bg-orange-wash text-orange-fg', dot: 'bg-orange' },
  today: { pin: 'bg-accent-wash text-accent-ink', dot: 'bg-accent' },
};

/** How many days the arrows go without a calendar: the To Dos' planning horizon (FR-16.8). */
const DAYS_WITHOUT_CALENDAR = 13;

/** "today", "tomorrow" or "on Thu 15 Oct", for the timeline's lists. */
const dayWords = (day: number, now: Date) => (day === 0 ? 'today' : day === 1 ? 'tomorrow' : `on ${fmtDayDate(londonAt(now, '12:00', day))}`);

const isTyping = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [data-no-shortcuts]');

const categoryHex = (e: AgendaEvent) => (e.categories?.length ? OUTLOOK_COLORS[e.categories[0].color] : undefined);

/** A meeting's shade of its category's colour, mixed into the surface so it stays dark in the dark theme; fainter once over. */
const tint = (hex: string | undefined, past: boolean) => (hex ? { background: `color-mix(in srgb, ${hex} ${past ? 8 : 14}%, var(--surface))`, borderColor: `color-mix(in srgb, ${hex} ${past ? 25 : 45}%, var(--surface))` } : undefined);

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
  const go = meetingLink(e, now);
  return (
    // The whole card joins the meeting in Teams, or opens it in Outlook; what's due before it opens the
    // item, and a Teams meeting's Outlook link sits beside the label, both above the card's link.
    <div data-testid="next-meeting" data-phase={next.phase} data-imminent={next.imminent || undefined} className={cx('relative rounded-[10px] border px-4 py-3.5', next.imminent ? 'border-amber-line bg-amber-wash' : 'border-accent-line bg-accent-wash')}>
      <div className={cx('flex justify-between gap-2 text-xs font-semibold tracking-[0.04em]', next.imminent ? 'text-amber-fg' : 'text-accent-ink')}>
        <span>{head}</span>
        {go.teams ? (
          <span className="flex items-center gap-1.5 font-medium tracking-normal">
            <BrandIcon brand="teams" size={14} decorative /> Join in Teams ·
            <a href={e.link ?? OUTLOOK_CALENDAR} target="_blank" rel="noreferrer" data-open-outlook className="relative z-[1] !text-inherit">
              Outlook
            </a>
          </span>
        ) : (
          <span className="font-medium tracking-normal">Open in Outlook</span>
        )}
      </div>
      <a
        href={go.href}
        target="_blank"
        rel="noreferrer"
        data-join-teams={go.teams || undefined}
        title={`${e.title}${e.organizer ? ` · ${e.organizer}` : ''}: ${go.teams ? 'join in Teams' : 'open in Outlook'}`}
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

function Timeline({ v, items, todos, now, day, workHours, onOpenItem }: { v: AgendaView | undefined; items: readonly ItemSummary[]; todos: readonly TodoSummary[]; now: Date; day: number; workHours: string; onOpenItem: (id: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => (setAvailable(el.clientHeight), setWidth(inner.current?.clientWidth ?? 0));
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  const meetingsWidth = Math.round(((width || TIME_WIDTH.default - 40) - MEETINGS_LEFT - LANE_GAP) * MEETINGS_SHARE);
  const pinsLeft = MEETINGS_LEFT + meetingsWidth + LANE_GAP;

  const start = dayStart(now, day);
  const calendar = v && v.state !== 'off' && v.state !== 'never';
  const events = calendar ? dayEvents(v.events, now, day) : [];
  const allDay = events.filter((e) => e.allDay);
  const meetings = placeMeetings(events, start, now);
  const pins = dayPins(items, now, day);
  const planned = placeTodos(todos, start, now);
  const nowMin = minuteOf(now.getTime(), start);
  const span = timelineSpan(workSpan(workHours), [...meetings.flatMap((m) => [m.from, m.to]), ...planned.flatMap((t) => [t.from, t.to]), ...pins.map((p) => p.at), ...(day === 0 ? [nowMin] : [])]);
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
            <li key={e.id} data-timeline-event={e.id} data-category-color={e.categories?.[0]?.color}>
              <a href={meetingLink(e, now).href} target="_blank" rel="noreferrer" className="inline-flex min-h-6 items-center gap-1.5 rounded-md border border-line bg-surface-2 px-2 text-xs !text-ink-2 no-underline hover:underline" style={tint(categoryHex(e), false)}>
                {meetingLink(e, now).teams && <BrandIcon brand="teams" size={12} decorative />}
                <span className="font-semibold">All day</span> {e.title}
              </a>
            </li>
          ))}
        </ul>
      )}
      <div ref={scroller} data-testid="timeline" data-px-per-hour={ph} className="-mx-5 min-h-0 flex-1 overflow-y-auto px-5">
        <div ref={inner} className="relative" style={{ height }}>
          {hours.map((m) => (
            <div key={m} aria-hidden className="absolute inset-x-0 border-t border-line-soft" style={{ top: top(m) }}>
              <span className="absolute -top-2 left-0 bg-surface pr-1.5 font-mono text-xs text-faint">{fmtHour(m)}</span>
            </div>
          ))}
          {day === 0 && <div aria-hidden className="absolute bg-past" style={{ left: MEETINGS_LEFT, width: meetingsWidth, top: 0, height: top(nowMin) }} />}
          <ol aria-label={day === 0 ? 'Today’s meetings' : day === 1 ? 'Tomorrow’s meetings' : `Meetings ${dayWords(day, now)}`} className="m-0 list-none p-0">
            {meetings.map((m) => {
              const hex = categoryHex(m.event);
              const w = meetingsWidth / m.cols;
              const named = (m.event.categories ?? []).map((c) => c.name).join(', ');
              const h = Math.max(MEETING_MIN_HEIGHT, top(m.to) - top(m.from) - 2);
              // A short meeting is one line, so its time and title show however short the block.
              const short = h < 34;
              const go = meetingLink(m.event, now);
              return (
                <li key={m.event.id} data-timeline-event={m.event.id} data-past={m.past || undefined} data-category-color={m.event.categories?.[0]?.color} className="absolute" style={{ top: top(m.from), height: h, left: MEETINGS_LEFT + m.col * w, width: w - (m.cols > 1 ? 2 : 0) }}>
                  <a
                    href={go.href}
                    target="_blank"
                    rel="noreferrer"
                    data-join-teams={go.teams || undefined}
                    title={`${fmtTime(m.event.start)}–${fmtTime(m.event.end)} ${m.event.title}${named ? ` · ${named}` : ''}: ${go.teams ? 'join in Teams' : 'open in Outlook'}`}
                    className={cx(
                      'flex h-full gap-1.5 overflow-hidden rounded-md border px-2 text-xs leading-[15px] no-underline hover:underline',
                      short ? 'items-center py-0' : 'py-[3px]',
                      m.past ? 'border-line bg-tray !text-faint' : 'border-accent-line bg-surface !text-ink',
                      hex && m.past && '!text-muted',
                    )}
                    style={tint(hex, m.past)}
                  >
                    <span aria-hidden className="w-[3px] shrink-0 self-stretch rounded-sm" style={{ background: hex ?? 'var(--gray-mid)' }} />
                    <span className={cx('min-w-0 flex-1', short && 'truncate')}>
                      <b className="font-semibold">{fmtTime(m.event.start)}</b> {m.event.title}
                    </span>
                    {go.teams && <BrandIcon brand="teams" size={13} decorative className={cx('shrink-0', !short && 'mt-px')} />}
                  </a>
                </li>
              );
            })}
          </ol>
          <ol aria-label={`To Dos planned ${dayWords(day, now)}`} className="m-0 list-none p-0">
            {planned.map((p) => {
              const s = p.todo.slot!;
              const h = Math.max(MEETING_MIN_HEIGHT, top(p.to) - top(p.from) - 2);
              // On a meeting (Frank's own time only): the right half, so both show.
              const half = s.clash ? meetingsWidth / 2 : 0;
              return (
                <li key={p.todo.id} data-timeline-todo={p.todo.id} data-slot-by={s.by} data-clash={s.clash || undefined} data-past={p.past || undefined} className="absolute" style={{ top: top(p.from), height: h, left: MEETINGS_LEFT + half, width: meetingsWidth - half }}>
                  <button
                    type="button"
                    title={`${fmtTime(s.start)}–${fmtTime(s.end)} ${p.todo.step}: ${s.by === 'you' ? 'your time' : 'free time Work OS found'}${s.clash ? ', on a meeting' : ''}. Click to change it.`}
                    onClick={() => openTodoPlan(p.todo.id)}
                    className={cx(
                      'flex size-full items-center gap-1.5 overflow-hidden rounded-md border px-2 text-left text-xs leading-[15px] cursor-pointer hover:brightness-[0.97]',
                      s.by === 'you' ? 'border-violet-line' : 'border-dashed border-violet-line',
                      s.clash && 'border-l-2 border-l-red',
                      p.past ? 'bg-tray text-faint' : 'bg-violet-wash text-violet-fg',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      <b className="font-semibold">{fmtTime(s.start)}</b> {p.todo.step}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
          {/* Under the pins: an overdue pin sits on it. */}
          {day === 0 && (
            <div data-testid="now-line" aria-hidden className="absolute right-0 border-t-2 border-red" style={{ left: 36, top: top(nowMin) - 1 }}>
              <span className="absolute -left-9 -top-[9px] rounded-[3px] bg-red px-[3px] py-px font-mono text-[11px] font-medium text-on-solid">{fmtTime(now)}</span>
            </div>
          )}
          <ol aria-label="Deadlines" className="m-0 list-none p-0">
            {pins.map((p, n) => (
              <li key={p.items.map((i) => i.id).join(',')} className="absolute right-0" style={{ top: tops[n], left: pinsLeft, height: PIN_HEIGHT }}>
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

export function TimeColumn({ items, todos = [], onOpenItem }: { items: readonly ItemSummary[]; todos?: readonly TodoSummary[]; onOpenItem: (id: string) => void }) {
  const now = useNow(15_000);
  const agenda = useApiQuery(() => api.getAgenda(), onTopics('inbox', 'settings', 'health'), []).data;
  const workHours = useApiQuery(() => api.getSettings(), onTopics('settings'), []).data?.settings.schedule.workHours ?? '';
  const calendar = agenda && agenda.state !== 'off' && agenda.state !== 'never';
  // The day shown, in days from today. The agenda has today's and tomorrow's meetings; other days
  // come from the week (CK-5.6), which also says which days the calendar holds.
  const [day, setDay] = useState(0);
  const monday = mondayOf(new Date(londonAt(now, '12:00', day)));
  const week = useApiQuery(() => (calendar ? api.getWeek(monday) : Promise.resolve(undefined)), onTopics('inbox', 'settings', 'health'), [calendar, monday]).data;
  const held = week?.held;
  const canGo = useCallback(
    (to: number) => (held ? londonAt(now, '00:00', to) >= held.from && londonAt(now, '00:00', to) < held.to : to >= 0 && to <= DAYS_WITHOUT_CALENDAR),
    [held, now],
  );
  const go = useCallback((to: number) => {
    if (canGo(to)) setDay(to);
  }, [canGo]);
  const shown: AgendaView | undefined =
    day === 0 || day === 1 || !agenda || !calendar ? agenda : { ...agenda, events: (week?.events ?? []).filter((e) => !e.cancelled && e.response !== 'declined') };
  const collapsed = usePrefs((s) => s.timeCollapsed);
  const setCollapsed = usePrefs((s) => s.setTimeCollapsed);
  const { width, dragging, handle } = useResizable({ saved: usePrefs((s) => s.timeWidth), save: usePrefs((s) => s.setTimeWidth), bounds: TIME_WIDTH, edge: 'right', label: 'Resize the time column' });
  const showTodos = usePrefs((s) => s.timeTodos);
  const setShowTodos = usePrefs((s) => s.setTimeTodos);
  const count = todoCounts(todos, now);

  // t: today's calendar, from any day or the To Dos; [ and ]: the day before and after.
  useEffect(() => {
    if (collapsed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === 't') {
        setShowTodos(false);
        setDay(0);
      } else if (e.key === '[' && !usePrefs.getState().timeTodos) go(day - 1);
      else if (e.key === ']' && !usePrefs.getState().timeTodos) go(day + 1);
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [collapsed, day, go, setShowTodos]);
  // Red with how many need a look when any do; else how many are open.
  const countBadge = (count.look || count.open) > 0 && (
    <span data-testid="todo-count" data-look={count.look > 0 || undefined} title={count.look ? `${count.look} To Do${count.look === 1 ? '' : 's'} need${count.look === 1 ? 's' : ''} a look` : undefined} className={cx('rounded-full px-1.5 text-[11px] font-semibold tabular-nums leading-[18px]', count.look ? 'bg-red text-white' : 'bg-violet-wash text-violet-fg')}>
      {count.look || count.open}
    </span>
  );

  if (collapsed)
    return (
      <section aria-label="Time" data-cockpit-zone="time" data-collapsed="true" className="flex w-14 shrink-0 flex-col items-center border-r border-line">
        <div className="flex h-14 w-full shrink-0 items-center justify-center">
          <IconButton label="Expand the time column" size={32} aria-expanded={false} onClick={() => setCollapsed(false)}>
            <Icon name="forward" size={17} />
          </IconButton>
        </div>
        <div className="flex w-full flex-1 justify-center border-t border-line">
          <div className="mt-3 flex flex-col items-center gap-2">
            <span data-testid="clock" className="text-[13px] font-semibold tabular-nums">
              {fmtTime(now)}
            </span>
            {countBadge && (
              <button type="button" aria-label="Show the To Dos" title="To Dos" onClick={() => (setShowTodos(true), setCollapsed(false))} className="cursor-pointer">
                {countBadge}
              </button>
            )}
          </div>
        </div>
      </section>
    );

  return (
    <section aria-label="Time" data-cockpit-zone="time" className={cx('relative flex shrink-0 flex-col border-r border-line', !dragging && 'transition-[width] duration-200 ease-out motion-reduce:transition-none')} style={{ width }}>
      {/* 56 px, the height of the Needs you and Later headers, with the rule under it on what follows
          as theirs is, so the three lines are one. */}
      <div className="flex h-14 shrink-0 items-center gap-2.5 pl-5 pr-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
          <span data-testid="clock" className="text-glance-xl tabular-nums" title={fmtDayDate(now)}>
            {fmtTime(now)}
          </span>
        </div>
        <Segmented
          size="sm"
          label="Show"
          value={showTodos ? 'todos' : 'calendar'}
          onChange={(v) => setShowTodos(v === 'todos')}
          options={[
            { value: 'calendar', label: 'Calendar' },
            { value: 'todos', label: <>To Dos{countBadge}</> },
          ]}
        />
        <IconButton label="Collapse the time column" size={32} aria-expanded onClick={() => setCollapsed(true)}>
          <Icon name="back" size={17} />
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 border-t border-line px-5 pt-4">
        {showTodos ? (
          <TodoDrawer todos={todos} onOpen={onOpenItem} />
        ) : (
          <>
            <div role="group" aria-label="Day" className="-mt-1 flex items-center gap-1">
              <Button size="sm" onClick={() => setDay(0)} title="Today (t)" aria-pressed={day === 0}>
                Today
              </Button>
              <IconButton label="Previous day" title="Previous day ([)" icon="back" size={28} disabled={!canGo(day - 1)} onClick={() => go(day - 1)} />
              <IconButton label="Next day" title="Next day (])" icon="forward" size={28} disabled={!canGo(day + 1)} onClick={() => go(day + 1)} />
              <h3 data-testid="day-shown" className="m-0 ml-1.5 min-w-0 truncate text-[15px] font-semibold">
                {fmtDayDate(londonAt(now, '12:00', day))}
                {day >= -1 && day <= 1 && <span className="ml-1.5 text-sm font-normal text-muted">{day === 0 ? 'Today' : day === 1 ? 'Tomorrow' : 'Yesterday'}</span>}
              </h3>
            </div>
            {calendar && day === 0 && <NextMeetingCard v={agenda} items={items} now={now} onOpenItem={onOpenItem} />}
            <CalendarNote v={agenda} now={now} />
            <Timeline v={shown} items={items} todos={todos} now={now} day={day} workHours={workHours} onOpenItem={onOpenItem} />
          </>
        )}
      </div>
      {handle}
    </section>
  );
}
