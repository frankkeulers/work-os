import { londonAt, type AgendaEvent } from '@work-os/shared';
import type { ItemSummary } from '../api';
import { headsUp, IMMINENT_MINUTES, type AgendaDay } from './agenda';
import { fmtTime } from './format';

// The cockpit's time column (CK-3.4–3.6): the day as a timeline of meetings and deadline pins, the
// next meeting, and what's due before it. Times are minutes after the London day's midnight.

export const PX_PER_HOUR = 72;
/** Below this the timeline scrolls instead of shrinking further. */
export const MIN_PX_PER_HOUR = 48;
/** Pins closer than this stack into one. */
export const STACK_MINUTES = 30;
/** A pin's short title. */
export const PIN_TITLE_MAX = 28;

const MIN = 60_000;
const DAY = 24 * 60;

export interface Span {
  from: number;
  to: number;
}

/** The times of "Mon–Fri 08:00–18:30"; 08:00–18:30 when unreadable, as isWorkHours reads it. */
export function workSpan(spec: string): Span {
  const m = /(\d\d):(\d\d)\s*[–-]\s*(\d\d):(\d\d)\s*$/.exec(spec.trim());
  const from = m ? Number(m[1]) * 60 + Number(m[2]) : 8 * 60;
  const to = m ? Number(m[3]) * 60 + Number(m[4]) : 18 * 60 + 30;
  return to > from ? { from, to } : { from: 8 * 60, to: 18 * 60 + 30 };
}

/** Work hours widened to every meeting and pin on the day, in whole hours. */
export function timelineSpan(work: Span, marks: readonly number[]): Span {
  const from = Math.min(work.from, ...marks);
  const to = Math.max(work.to, ...marks);
  return { from: Math.max(0, Math.floor(from / 60) * 60), to: Math.min(DAY, Math.ceil(to / 60) * 60) };
}

/** Pixels an hour: 72 when the day fits, shrinking to 48, below which the column scrolls. */
export function hourHeight(available: number, span: Span): number {
  const hours = (span.to - span.from) / 60;
  if (available <= 0 || hours <= 0) return PX_PER_HOUR;
  return Math.max(MIN_PX_PER_HOUR, Math.min(PX_PER_HOUR, Math.floor(available / hours)));
}

/** The London midnight that starts the day shown. */
export const dayStart = (now: Date, day: AgendaDay) => londonAt(now, '00:00', day === 'today' ? 0 : 1);

/** Minutes after the day's midnight, clamped to the day. */
export const minuteOf = (iso: string | number, start: string) => Math.max(0, Math.min(DAY, ((typeof iso === 'number' ? iso : Date.parse(iso)) - Date.parse(start)) / MIN));

export interface PlacedMeeting {
  event: AgendaEvent;
  from: number;
  to: number;
  /** Side by side with the meetings it overlaps: its column, of `cols`. */
  col: number;
  cols: number;
  past: boolean;
}

/** The day's timed meetings, overlapping ones side by side. At least 15 minutes tall. */
export function placeMeetings(events: readonly AgendaEvent[], start: string, now: Date): PlacedMeeting[] {
  const timed = events
    .filter((e) => !e.allDay)
    .map((event) => {
      const from = minuteOf(event.start, start);
      return { event, from, to: Math.max(from + 15, minuteOf(event.end, start)), col: 0, cols: 1, past: Date.parse(event.end) <= now.getTime() };
    })
    .sort((a, b) => a.from - b.from || b.to - a.to);
  // Clusters of meetings that overlap one another share their width.
  let cluster: PlacedMeeting[] = [];
  let clusterEnd = -1;
  const close = () => {
    const cols = Math.max(...cluster.map((m) => m.col)) + 1;
    for (const m of cluster) m.cols = cols;
  };
  for (const m of timed) {
    if (cluster.length && m.from >= clusterEnd) {
      close();
      cluster = [];
    }
    const used = new Set(cluster.filter((o) => o.to > m.from).map((o) => o.col));
    let col = 0;
    while (used.has(col)) col++;
    m.col = col;
    cluster.push(m);
    clusterEnd = Math.max(clusterEnd, m.to);
  }
  if (cluster.length) close();
  return timed;
}

export type PinTone = 'late' | 'now' | 'today';

export interface Pin {
  /** Where it sits: its due time, or the now-line when overdue. */
  at: number;
  items: ItemSummary[];
  tone: PinTone;
  overdue: boolean;
  label: string;
}

const NEEDS = new Set<ItemSummary['lane']>(['now', 'today', 'failed']);
const RANK: Record<PinTone, number> = { late: 0, now: 1, today: 2 };

/** A pin's few words: the next step, or the summary, cut at 28 characters. */
export function shortTitle(i: Pick<ItemSummary, 'next' | 'summary'>): string {
  const t = (i.next?.step ?? i.summary).trim();
  return t.length > PIN_TITLE_MAX ? `${t.slice(0, PIN_TITLE_MAX - 1).trimEnd()}…` : t;
}

/**
 * The deadline pins (CK-3.6). Today: each open Needs you item due today, or overdue, which sits at
 * the now-line in red. Tomorrow: This week items due tomorrow. Colours follow the chips (9 Oct):
 * orange within about 4 hours, blue later, red when overdue. Pins within 30 minutes stack.
 */
export function dayPins(items: readonly ItemSummary[], now: Date, day: AgendaDay): Pin[] {
  const start = dayStart(now, day);
  const end = londonAt(now, '00:00', day === 'today' ? 1 : 2);
  const t = now.getTime();
  const due = items
    .filter((i) => i.status === 'open' && i.next?.dueAt)
    .filter((i) => (day === 'today' ? NEEDS.has(i.lane) && i.next!.dueAt! < end : i.lane === 'week' && i.next!.dueAt! >= start && i.next!.dueAt! < end))
    .map((item) => {
      const dueMs = Date.parse(item.next!.dueAt!);
      const overdue = day === 'today' && dueMs < t;
      const tone: PinTone = overdue ? 'late' : day === 'today' && dueMs - t <= 4 * 60 * MIN ? 'now' : 'today';
      return { item, dueMs, overdue, tone, pos: overdue ? t : dueMs };
    })
    .sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.pos - b.pos || a.dueMs - b.dueMs);

  const groups: (typeof due)[] = [];
  for (const d of due) {
    const g = groups.at(-1);
    if (g && g[0].overdue === d.overdue && d.pos - g[0].pos < STACK_MINUTES * MIN) g.push(d);
    else groups.push([d]);
  }
  return groups.map((g) => {
    const first = g[0];
    const tone = g.map((d) => d.tone).sort((a, b) => RANK[a] - RANK[b])[0];
    const label = first.overdue
      ? g.length === 1
        ? `Overdue · ${shortTitle(first.item)}`
        : `${g.length} overdue`
      : g.length === 1
        ? `${fmtTime(new Date(first.dueMs).toISOString())} ${shortTitle(first.item)}`
        : `${g.length} due ${fmtTime(new Date(first.dueMs).toISOString())}`;
    return { at: minuteOf(first.pos, start), items: g.map((d) => d.item), tone, overdue: first.overdue, label };
  });
}

export type NextMeeting =
  | {
      kind: 'meeting';
      event: AgendaEvent;
      phase: 'now' | 'next';
      /** Whole minutes to go, rounded up, for one about to start. */
      minutes: number;
      imminent: boolean;
      /** Others Frank is going to that overlap it. */
      also: AgendaEvent[];
    }
  | { kind: 'none'; tomorrow?: AgendaEvent };

/**
 * The next-meeting card (CK-3.5): the first meeting today Frank is going to (as the sidebar cues:
 * timed, not Free, accepted, tentative or his own) that hasn't ended; or, with none left, the first
 * one tomorrow.
 */
export function nextMeeting(events: readonly AgendaEvent[], now: Date): NextMeeting {
  const t = now.getTime();
  const todayEnd = Date.parse(londonAt(now, '00:00', 1));
  const tomorrowEnd = Date.parse(londonAt(now, '00:00', 2));
  const going = events.filter(headsUp).sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.id.localeCompare(b.id));
  const left = going.filter((e) => Date.parse(e.end) > t && Date.parse(e.start) < todayEnd);
  const event = left[0];
  if (!event) return { kind: 'none', tomorrow: going.find((e) => Date.parse(e.start) >= todayEnd && Date.parse(e.start) < tomorrowEnd) };
  const on = Date.parse(event.start) <= t;
  const minutes = on ? 0 : Math.ceil((Date.parse(event.start) - t) / MIN);
  const also = left.filter((e) => e !== event && Date.parse(e.start) < Date.parse(event.end) && Date.parse(e.end) > Date.parse(event.start));
  return { kind: 'meeting', event, phase: on ? 'now' : 'next', minutes, imminent: !on && minutes <= IMMINENT_MINUTES, also };
}

/** "Due before it": open Needs you items due on or before the meeting starts, soonest first. */
export function dueBefore(items: readonly ItemSummary[], start: string): ItemSummary[] {
  const at = Date.parse(start);
  return items
    .filter((i) => i.status === 'open' && NEEDS.has(i.lane) && i.next?.dueAt && Date.parse(i.next.dueAt) <= at)
    .sort((a, b) => a.next!.dueAt!.localeCompare(b.next!.dueAt!));
}
