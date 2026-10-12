import { londonAt, londonParts, parseWorkHours } from './time';

// Free time for To Dos (E15, FR-16.8): code, not a model, finds each open To Do a slot in Frank's
// working hours, around his meetings, before it is due. Nothing is booked: the slot shows in Work
// OS only. Pure and shared, so the server's planner, its view and the mock all place alike.
//
// - Busy: a meeting not cancelled or declined, shown as anything but free or working elsewhere
//   (so tentative counts); an all-day event only when out of office. Each is widened by the
//   buffer on both sides.
// - Free: working hours per day, from now to two weeks on (or the end of the calendar snapshot),
//   less busy time and the slots already taken.
// - Order: soonest due first (the ideal date, else the deadline), those without one last.
// - A slot is the To Do's estimate (30 minutes without one) in quarter hours, never split: the first
//   free time it fits, ending by its ideal date if it can, else by its deadline. With no room
//   before its deadline, it has none, with the first time it would fit after. Once its deadline
//   has passed, the first free time it fits.
// - Stability: a slot already planned that still fits is kept, so a new meeting moves only the
//   slots it hits. Frank's own slots are never moved; they are marked when a meeting clashes or
//   the time has passed. A planned slot whose time passed with the To Do still open is placed again.

export const SLOT_HORIZON_DAYS = 14;
export const SLOT_DEFAULT_MINUTES = 30;
export const SLOT_BUFFER_MINUTES = 10;
/** A new slot starts at least this far ahead, on a quarter hour. */
export const SLOT_LEAD_MINUTES = 5;

const MIN = 60_000;
const Q = 15 * MIN;
const ceilQ = (ms: number) => Math.ceil(ms / Q) * Q;

export interface BusyEvent {
  start: string;
  end: string;
  allDay?: boolean;
  showAs?: string;
  cancelled?: boolean;
  response?: string;
}

export interface Slot {
  start: string;
  end: string;
  by: 'plan' | 'you';
}

export interface SlotTodo {
  id: string;
  createdAt: string;
  effortMinutes?: number;
  deadline?: string;
  ideal?: string;
  slot?: Slot;
}

export type NoSlot = 'no_fit_before_deadline' | 'too_long' | 'no_free_time' | 'no_calendar';

export type SlotResult =
  | { kind: 'slot'; start: string; end: string; by: Slot['by']; clash?: true; passed?: true }
  | { kind: 'none'; reason: NoSlot; firstAfter?: { start: string; end: string } };

type Span = [number, number];

/** Whether an event takes Frank's time. */
export function isBusy(e: BusyEvent): boolean {
  if (e.cancelled || e.response === 'declined') return false;
  const s = (e.showAs ?? 'busy').toLowerCase();
  if (s === 'free' || s === 'workingelsewhere') return false;
  return e.allDay ? s === 'oof' : true;
}

/** Working hours between two times, one span per working day. */
export function workWindows(workHours: string, from: number, to: number): Span[] {
  const w = parseWorkHours(workHours);
  const base = new Date(from);
  const out: Span[] = [];
  for (let i = -1; ; i++) {
    const noon = londonAt(base, '12:00', i);
    if (Date.parse(noon) - 86_400_000 > to) break;
    if (!w.days.includes(londonParts(noon).weekday)) continue;
    const s = Date.parse(londonAt(base, w.from, i));
    const e = Date.parse(londonAt(base, w.to, w.to > w.from ? i : i + 1));
    const span: Span = [Math.max(s, from), Math.min(e, to)];
    if (span[1] > span[0]) out.push(span);
  }
  return out;
}

/** The free spans less one taken span. */
const without = (free: Span[], [s, e]: Span): Span[] => free.flatMap(([a, b]): Span[] => (e <= a || s >= b ? [[a, b]] : ([s > a && [a, s], e < b && [e, b]].filter(Boolean) as Span[])));
const overlaps = (spans: Span[], [s, e]: Span) => spans.some(([a, b]) => s < b && e > a);
const inside = (free: Span[], [s, e]: Span) => free.some(([a, b]) => s >= a && e <= b);

/** The first span of `ms` that starts at or after `from` on a quarter hour and ends by `by`. */
function firstFit(free: Span[], ms: number, from: number, by = Infinity): Span | undefined {
  for (const [a, b] of free) {
    const s = ceilQ(Math.max(a, from));
    if (s + ms <= b && s + ms <= by) return [s, s + ms];
    if (s >= by) return undefined;
  }
  return undefined;
}

const iso = (ms: number) => new Date(ms).toISOString();
/** A To Do's length in quarter hours. */
export const slotMinutes = (effortMinutes?: number) => Math.max(15, Math.ceil((effortMinutes ?? SLOT_DEFAULT_MINUTES) / 15) * 15);
/** When it is due: its ideal date, which is always before its deadline, else its deadline. */
const dueOf = (t: SlotTodo) => t.ideal ?? t.deadline;

export function planSlots(a: { now: Date; workHours: string; events?: readonly BusyEvent[]; calendarTo?: string; todos: readonly SlotTodo[]; bufferMinutes?: number }): Record<string, SlotResult> {
  const now = a.now.getTime();
  // A date already gone by bounds nothing: late either way, it goes in as soon as it fits.
  const bound = (iso?: string) => (iso && Date.parse(iso) > now ? Date.parse(iso) : undefined);
  const out: Record<string, SlotResult> = {};
  const pinned = a.todos.filter((t) => t.slot?.by === 'you');
  const busy: Span[] = (a.events ?? []).filter(isBusy).map((e) => [Date.parse(e.start), Date.parse(e.end)]);
  for (const t of pinned) {
    const s: Span = [Date.parse(t.slot!.start), Date.parse(t.slot!.end)];
    out[t.id] = { kind: 'slot', start: t.slot!.start, end: t.slot!.end, by: 'you', ...(overlaps(busy, s) && { clash: true as const }), ...(s[1] <= now && { passed: true as const }) };
  }
  const rest = a.todos.filter((t) => t.slot?.by !== 'you');
  if (!a.events) {
    for (const t of rest) out[t.id] = { kind: 'none', reason: 'no_calendar' };
    return out;
  }

  const buffer = (a.bufferMinutes ?? SLOT_BUFFER_MINUTES) * MIN;
  const end = Math.min(now + SLOT_HORIZON_DAYS * 86_400_000, a.calendarTo ? Date.parse(a.calendarTo) : Infinity);
  const dayStart = Date.parse(londonAt(a.now, '00:00'));
  const windows = workWindows(a.workHours, dayStart, end);
  let free = windows;
  for (const [s, e] of busy) free = without(free, [s - buffer, e + buffer]);
  for (const t of pinned) free = without(free, [Date.parse(t.slot!.start), Date.parse(t.slot!.end)]);
  const longest = Math.max(0, ...windows.map(([s, e]) => e - s));

  // Planned slots that still fit, unfinished and before the deadline, stay where they are.
  const placed = new Set<string>();
  for (const t of [...rest].filter((x) => x.slot).sort((x, y) => x.slot!.start.localeCompare(y.slot!.start))) {
    const s: Span = [Date.parse(t.slot!.start), Date.parse(t.slot!.end)];
    const deadline = bound(t.deadline);
    const ok = s[1] > now && s[1] - s[0] === slotMinutes(t.effortMinutes) * MIN && inside(free, s) && (deadline === undefined || s[1] <= deadline);
    if (!ok) continue;
    free = without(free, s);
    placed.add(t.id);
    out[t.id] = { kind: 'slot', start: t.slot!.start, end: t.slot!.end, by: 'plan' };
  }

  const from = now + SLOT_LEAD_MINUTES * MIN;
  const order = rest
    .filter((t) => !placed.has(t.id))
    .sort((x, y) => {
      const [dx, dy] = [dueOf(x), dueOf(y)];
      return Number(!dx) - Number(!dy) || (dx ?? '').localeCompare(dy ?? '') || x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id);
    });
  for (const t of order) {
    const ms = slotMinutes(t.effortMinutes) * MIN;
    if (ms > longest) {
      out[t.id] = { kind: 'none', reason: 'too_long' };
      continue;
    }
    const ideal = bound(t.ideal);
    const deadline = bound(t.deadline);
    const fit = (ideal !== undefined && firstFit(free, ms, from, ideal)) || firstFit(free, ms, from, deadline);
    if (!fit) {
      const after = firstFit(free, ms, from);
      out[t.id] = deadline !== undefined ? { kind: 'none', reason: 'no_fit_before_deadline', ...(after && { firstAfter: { start: iso(after[0]), end: iso(after[1]) } }) } : { kind: 'none', reason: 'no_free_time' };
      continue;
    }
    free = without(free, fit);
    out[t.id] = { kind: 'slot', start: iso(fit[0]), end: iso(fit[1]), by: 'plan' };
  }
  return out;
}
