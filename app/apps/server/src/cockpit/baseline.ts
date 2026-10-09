import { emptyProjection, laneFor, londonAt, londonParts, reduce, type ItemState, type Lane, type Projection, type SourceId, type WorkEvent } from '@work-os/shared';

// The cockpit baseline (specs/cockpit/SPEC.md CK-0.1). Replays the event log once and measures what
// stages 2 and 3 are worth: how many items need Frank, how often triage sets a deadline, how often
// Frank's own reply came before his Done (the ceiling for auto-close), how long items stay open, and
// how many are left at 18:00. Read-only: it never touches the files, it only sees the events.

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** The lanes counted per day. "Needs you" is now, today and failed (CK-3.8). */
export const BASELINE_LANES = ['now', 'today', 'file', 'else', 'failed'] as const;
type CountedLane = (typeof BASELINE_LANES)[number];
const NEEDS_YOU: ReadonlySet<Lane> = new Set(['now', 'today', 'failed']);

export interface BaselineOptions {
  /** The end of the window. */
  now: Date;
  /** The window's length in days. */
  days: number;
  /** Settings › Schedule work hours, "Mon–Fri 08:00–18:30": only its days are used. */
  workHours: string;
}

export interface Spread {
  n: number;
  medianMinutes: number | null;
  p90Minutes: number | null;
}

export interface Share {
  of: number;
  withDue: number;
  pct: number | null;
}

export interface BaselineReport {
  window: { from: string; to: string; days: number };
  /** 1. Items entering each lane, per London day, and the Needs you items Frank marked done. */
  perDay: { date: string; entered: Record<CountedLane, number>; needsYouDoneByFrank: number }[];
  /** 2. Needs you decisions (now or today) that set next.dueAt. */
  deadlineCoverage: { all: Share; bySource: Record<string, Share>; byNeed: Record<string, Share> };
  /** 3. Of Frank's Dones on Needs you items, those his own reply came before: the ceiling for C1. */
  autoClosePotential: { frankDones: number; afterOwnReply: number; pct: number | null; gap: Spread };
  /** 4. From an item's first appearance to its Done, by the lane it was in when done. */
  timeToDone: Record<string, Spread>;
  /** 5. Needs you at 18:00 on each working day (the C3 baseline). */
  endOfDay: { date: string; needsYou: number }[];
  /** Dones by who closed them, for context. */
  dones: { byFrank: number; bySource: number };
}

/** Per-item facts the projection doesn't keep. */
interface Seen {
  firstAt: string;
  lastOtherAt?: string; // the last revision with someone else's message
  lastMineAt?: string; // the last revision with only Frank's own messages
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** The weekdays of a work-hours spec. Falls back to Mon–Fri, as isWorkHours does. */
export function workDays(spec: string): Set<string> {
  const m = /^(\w{3})\s*[–-]\s*(\w{3})\s/.exec(spec.trim());
  const a = DAYS.indexOf(m?.[1] ?? 'Mon');
  const b = DAYS.indexOf(m?.[2] ?? 'Fri');
  if (a < 0 || b < 0) return new Set(DAYS.slice(0, 5));
  return new Set(DAYS.filter((_, i) => (a <= b ? i >= a && i <= b : i >= a || i <= b)));
}

/** The value at fraction q of the sorted values, nearest rank. */
function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

function spread(minutes: number[]): Spread {
  const s = [...minutes].sort((a, b) => a - b);
  const round = (v: number | null) => (v === null ? null : Math.round(v));
  return { n: s.length, medianMinutes: round(quantile(s, 0.5)), p90Minutes: round(quantile(s, 0.9)) };
}

const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const share = (s: { of: number; withDue: number }): Share => ({ ...s, pct: pct(s.withDue, s.of) });
const emptyLanes = (): Record<CountedLane, number> => ({ now: 0, today: 0, file: 0, else: 0, failed: 0 });
const isCounted = (l: Lane): l is CountedLane => (BASELINE_LANES as readonly string[]).includes(l);

/** An item shown on its own in the inbox: not a part of another item's topic. */
const shown = (it: ItemState) => !it.topicOf;

export class BaselineAnalyser {
  private readonly p: Projection = emptyProjection();
  private readonly seen = new Map<string, Seen>();
  private readonly from: number;
  private readonly to: number;
  private readonly boundaries: { date: string; at: number }[];
  private nextBoundary = 0;

  private readonly perDay = new Map<string, { entered: Record<CountedLane, number>; needsYouDoneByFrank: number; counted: Set<string> }>();
  private readonly coverage = { all: { of: 0, withDue: 0 }, bySource: new Map<string, { of: number; withDue: number }>(), byNeed: new Map<string, { of: number; withDue: number }>() };
  private frankDones = 0;
  private sourceDones = 0;
  private afterOwnReply = 0;
  private readonly replyGaps: number[] = [];
  private readonly toDone = new Map<string, number[]>();
  private readonly endOfDay: { date: string; needsYou: number }[] = [];

  constructor(private readonly opts: BaselineOptions) {
    this.to = opts.now.getTime();
    this.from = this.to - opts.days * DAY;
    const days = workDays(opts.workHours);
    this.boundaries = [];
    for (let d = 0; d <= opts.days; d++) {
      const day = new Date(this.from + d * DAY);
      const at = Date.parse(londonAt(day, '18:00'));
      const { dateKey, weekday } = londonParts(new Date(at));
      if (at <= this.from || at > this.to || !days.has(weekday) || this.boundaries.some((b) => b.date === dateKey)) continue;
      this.boundaries.push({ date: dateKey, at });
    }
  }

  /** Feeds one event, in seq order. */
  add(e: WorkEvent) {
    const t = Date.parse(e.at);
    this.takeEndOfDay(t);
    if (e.seq > this.p.lastSeq + 1) this.p.lastSeq = e.seq - 1; // the reader reports gaps; keep going
    const inWindow = t > this.from && t <= this.to;
    const id = e.itemId;
    const before = id ? this.p.items[id] : undefined;
    const laneBefore = before ? laneFor(before) : undefined;

    if (e.type === 'item.upserted' && id) this.noteRevision(id, e, before);
    if (inWindow && e.type === 'triage.decided' && before) this.noteDecision(e, before);
    if (inWindow && e.type === 'item.done' && before && laneBefore && shown(before)) this.noteDone(e, before, laneBefore);

    reduce(this.p, e);

    if (inWindow && id) {
      const after = this.p.items[id];
      if (after && shown(after)) {
        const lane = laneFor(after);
        if (lane !== laneBefore && isCounted(lane)) this.enter(e.at, id, lane);
      }
    }
  }

  /** The report, with the 18:00 counts up to the end of the window. */
  report(): BaselineReport {
    this.takeEndOfDay(this.to + 1);
    // Every London day in the window, quiet days included.
    for (let t = this.from + 1; t <= this.to; t += DAY / 2) this.day(new Date(t).toISOString());
    this.day(new Date(this.to).toISOString());
    const days = [...this.perDay.entries()].filter(([date]) => date >= londonParts(new Date(this.from + 1)).dateKey).sort(([a], [b]) => a.localeCompare(b));
    const byKey = (m: Map<string, { of: number; withDue: number }>) => Object.fromEntries([...m.entries()].sort().map(([k, v]) => [k, share(v)]));
    return {
      window: { from: new Date(this.from).toISOString(), to: new Date(this.to).toISOString(), days: this.opts.days },
      perDay: days.map(([date, d]) => ({ date, entered: d.entered, needsYouDoneByFrank: d.needsYouDoneByFrank })),
      deadlineCoverage: { all: share(this.coverage.all), bySource: byKey(this.coverage.bySource), byNeed: byKey(this.coverage.byNeed) },
      autoClosePotential: { frankDones: this.frankDones, afterOwnReply: this.afterOwnReply, pct: pct(this.afterOwnReply, this.frankDones), gap: spread(this.replyGaps) },
      timeToDone: Object.fromEntries([...this.toDone.entries()].sort().map(([lane, mins]) => [lane, spread(mins)])),
      endOfDay: this.endOfDay,
      dones: { byFrank: this.frankDones, bySource: this.sourceDones },
    };
  }

  private day(at: string) {
    const key = londonParts(at).dateKey;
    let d = this.perDay.get(key);
    if (!d) this.perDay.set(key, (d = { entered: emptyLanes(), needsYouDoneByFrank: 0, counted: new Set() }));
    return d;
  }

  private enter(at: string, id: string, lane: CountedLane) {
    const d = this.day(at);
    const key = `${lane}:${id}`;
    if (d.counted.has(key)) return; // an item counts once per lane per day
    d.counted.add(key);
    d.entered[lane] += 1;
  }

  /** Revisions belong to the topic shown in the inbox: a part's reply counts for its anchor. */
  private noteRevision(id: string, e: Extract<WorkEvent, { type: 'item.upserted' }>, before: ItemState | undefined) {
    if (!before) {
      this.seen.set(id, { firstAt: e.at, lastOtherAt: e.data.fromMeOnly ? undefined : e.at });
      return;
    }
    if (e.data.revision <= before.revision) return; // a replayed poll
    const owner = before.topicOf ?? id;
    const s = this.seen.get(owner) ?? { firstAt: e.at };
    if (e.data.fromMeOnly) s.lastMineAt = e.at;
    else s.lastOtherAt = e.at;
    this.seen.set(owner, s);
  }

  private noteDecision(e: Extract<WorkEvent, { type: 'triage.decided' }>, item: ItemState) {
    const d = e.data.decision;
    if (d.attention !== 'now' && d.attention !== 'today') return;
    const due = d.next?.dueAt ? 1 : 0;
    const bump = (m: Map<string, { of: number; withDue: number }>, k: string) => {
      const v = m.get(k) ?? { of: 0, withDue: 0 };
      v.of += 1;
      v.withDue += due;
      m.set(k, v);
    };
    this.coverage.all.of += 1;
    this.coverage.all.withDue += due;
    bump(this.coverage.bySource, item.source as SourceId);
    bump(this.coverage.byNeed, d.next?.need ?? 'none');
  }

  private noteDone(e: Extract<WorkEvent, { type: 'item.done' }>, item: ItemState, lane: Lane) {
    if (item.status === 'done') return; // already done: a repeat changes nothing
    const s = this.seen.get(item.id);
    if (s) {
      const list = this.toDone.get(lane) ?? [];
      list.push((Date.parse(e.at) - Date.parse(s.firstAt)) / MIN);
      this.toDone.set(lane, list);
    }
    if (e.data) {
      this.sourceDones += 1;
      return;
    }
    if (!NEEDS_YOU.has(lane)) return;
    this.frankDones += 1;
    this.day(e.at).needsYouDoneByFrank += 1;
    // Frank answered before pressing Done: his own message came after everyone else's.
    if (s?.lastMineAt && (!s.lastOtherAt || s.lastMineAt > s.lastOtherAt) && s.lastMineAt <= e.at) {
      this.afterOwnReply += 1;
      this.replyGaps.push((Date.parse(e.at) - Date.parse(s.lastMineAt)) / MIN);
    }
  }

  /** Counts Needs you at each 18:00 the log has passed. */
  private takeEndOfDay(t: number) {
    while (this.nextBoundary < this.boundaries.length && this.boundaries[this.nextBoundary].at < t) {
      const { date } = this.boundaries[this.nextBoundary++];
      const needsYou = Object.values(this.p.items).filter((it) => shown(it) && NEEDS_YOU.has(laneFor(it))).length;
      this.endOfDay.push({ date, needsYou });
    }
  }
}

/** Plain-text summary for the console. */
export function describeBaseline(r: BaselineReport): string {
  const v = (n: number | null, unit = '') => (n === null ? 'n/a' : `${n}${unit}`);
  const lines = [
    `Cockpit baseline, ${r.window.from.slice(0, 10)} to ${r.window.to.slice(0, 10)} (${r.window.days} days)`,
    '',
    'Items entering each lane per day (now / today / file / else / failed), and Needs you done by Frank:',
    ...r.perDay.map((d) => `  ${d.date}  ${BASELINE_LANES.map((l) => String(d.entered[l]).padStart(3)).join(' ')}   done ${d.needsYouDoneByFrank}`),
    '',
    `Deadline coverage: ${r.deadlineCoverage.all.withDue} of ${r.deadlineCoverage.all.of} Needs you decisions set dueAt (${v(r.deadlineCoverage.all.pct, '%')})`,
    ...Object.entries(r.deadlineCoverage.bySource).map(([k, s]) => `  source ${k.padEnd(10)} ${s.withDue}/${s.of} (${v(s.pct, '%')})`),
    ...Object.entries(r.deadlineCoverage.byNeed).map(([k, s]) => `  need   ${k.padEnd(10)} ${s.withDue}/${s.of} (${v(s.pct, '%')})`),
    '',
    `Auto-close potential: ${r.autoClosePotential.afterOwnReply} of ${r.autoClosePotential.frankDones} Dones came after Frank's own reply (${v(r.autoClosePotential.pct, '%')}); ` +
      `median gap ${v(r.autoClosePotential.gap.medianMinutes, ' min')}. Gate to Stage 2: 20% or more.`,
    '',
    'Time to done, from first appearance (median / p90):',
    ...Object.entries(r.timeToDone).map(([lane, s]) => `  ${lane.padEnd(8)} n=${String(s.n).padStart(4)}  ${v(s.medianMinutes, ' min')} / ${v(s.p90Minutes, ' min')}`),
    '',
    'Needs you at 18:00:',
    ...r.endOfDay.map((d) => `  ${d.date}  ${d.needsYou}`),
    '',
    `Dones: ${r.dones.byFrank} by Frank on Needs you items, ${r.dones.bySource} by a source.`,
  ];
  return lines.join('\n');
}
