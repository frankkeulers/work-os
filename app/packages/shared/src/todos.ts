import type { MirrorFailure, TodoBy } from './events';
import type { TodoState } from './projection/state';
import { SCHEDULE_MAX_ATTEMPTS, type Confidence } from './schedule';
import type { SourceId } from './schemas';
import { planSlots, type BusyEvent, type NoSlot, type Slot, type SlotResult } from './slots';
import { FOLLOWUP_MAX_ATTEMPTS, FOLLOWUP_WINDOW_HOURS, type Followup, type FollowupAnswered } from './followup';
import { londonParts } from './time';
import type { DeadlineFrom } from './todo';

// To Dos on the inbox (E15, FR-16.2): what a row shows, and which group it sits in. Shared by the
// server's view, the mock and the web app, so all three group alike.

export interface TodoSummary {
  id: string;
  itemId: string;
  /** The task's own words, as written to the Tasks note. */
  step: string;
  source: SourceId;
  sourceTitle: string;
  /** The conversation it came from, to reply in (FR-16.11). */
  permalink?: string;
  status: 'open' | 'done';
  deadline?: string;
  deadlineFrom: DeadlineFrom;
  createdAt: string;
  doneAt?: string;
  doneBy?: TodoBy;
  /** False once the Tasks note was read and its line wasn't there; absent while unknown. */
  inNote?: boolean;
  /** FR-16.4: Done or reopen not yet mirrored to the line; `failed` once a try didn't. */
  mirror?: { want: 'ticked' | 'open'; failed?: MirrorFailure };
  /** FR-16.5: minutes it took, as Frank said on Done. */
  actualMinutes?: number;
  /** FR-16.6: how long it should take, the model's estimate or Frank's (effortBy), and why. */
  effortMinutes?: number;
  effortBy?: 'model' | 'you';
  confidence?: Confidence;
  estimateWhy?: string;
  /** When it would ideally be done, before its deadline, and why. */
  ideal?: string;
  idealWhy?: string;
  /** Waiting for its plan: open, unplanned, and not yet given up on. */
  planning?: boolean;
  /**
   * FR-16.8–16.9: when Frank will do it, in Work OS only: free time the plan found, or his own
   * (by 'you'), marked when a meeting clashes with it or its time has gone by.
   */
  slot?: Slot & { clash?: true; passed?: true };
  /** Open with no slot: why, and when it would first fit after its deadline. */
  noSlot?: { reason: NoSlot; firstAfter?: { start: string; end: string } };
  /** FR-16.11–16.12: once done, what usually comes next, each with Frank's answer once given. */
  followups?: (Followup & { answer?: FollowupAnswered })[];
  /** Done, and its follow-ups still to come. */
  followupsPending?: boolean;
}

/** Why an open To Do has no slot, in words (FR-16.8). */
export const NO_SLOT: Record<NoSlot, string> = {
  no_fit_before_deadline: 'No free time before it is due',
  too_long: 'Longer than a working day: split it, or set a time',
  no_free_time: 'No free time in the next two weeks',
  no_calendar: 'Turn on Outlook Calendar to plan a time',
};

/** A tick that couldn't be mirrored, in words (FR-16.4). */
export const MIRROR_FAILURE: Record<MirrorFailure, string> = {
  path_refused: 'the Tasks note path is refused; check Settings › Write targets',
  no_note: 'the Tasks note isn’t there',
  no_line: 'its line isn’t in the Tasks note',
  write_failed: 'writing the Tasks note failed; trying again',
};

export type TodoGroup = 'overdue' | 'today' | 'upcoming' | 'done';
export const TODO_GROUPS: readonly TodoGroup[] = ['overdue', 'today', 'upcoming', 'done'];

/**
 * Where a To Do sits: done (today; older ones aren't shown), overdue once its deadline has passed,
 * today when it is due today in London (ideally, or by its deadline), else upcoming, with To Dos
 * that have no date. A slot (FR-16.8) orders today's, but moves none between groups.
 */
export function todoGroup(t: Pick<TodoSummary, 'status' | 'deadline' | 'ideal'>, now: Date): TodoGroup {
  if (t.status === 'done') return 'done';
  if (t.deadline && t.deadline < now.toISOString()) return 'overdue';
  // Ideally done by today, or already: today. Past an ideal date is not overdue.
  const due = todoDue(t);
  if (!due) return 'upcoming';
  return due < now.toISOString() || londonParts(due).dateKey === londonParts(now).dateKey ? 'today' : 'upcoming';
}

/** When a To Do is due: its ideal date when it has one (always before its deadline), else its deadline. */
export const todoDue = (t: Pick<TodoSummary, 'deadline' | 'ideal'>) => t.ideal ?? t.deadline;

/** Soonest due first, those without a date last; then the oldest. */
const byDue = (a: TodoSummary, b: TodoSummary) => {
  const [x, y] = [todoDue(a), todoDue(b)];
  return Number(!x) - Number(!y) || (x ?? '').localeCompare(y ?? '') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
};

/** To Dos by group, each in the order it shows. Done ones are those done today. */
export function todoGroups(todos: readonly TodoSummary[], now: Date): Record<TodoGroup, TodoSummary[]> {
  const today = londonParts(now).dateKey;
  const out: Record<TodoGroup, TodoSummary[]> = { overdue: [], today: [], upcoming: [], done: [] };
  for (const t of todos) {
    const g = todoGroup(t, now);
    if (g === 'done' && (!t.doneAt || londonParts(t.doneAt).dateKey !== today)) continue;
    out[g].push(t);
  }
  for (const g of ['overdue', 'upcoming'] as const) out[g].sort(byDue);
  // Today runs in the order Frank will do them: by slot, then those without one.
  out.today.sort((a, b) => Number(!a.slot) - Number(!b.slot) || (a.slot?.start ?? '').localeCompare(b.slot?.start ?? '') || byDue(a, b));
  out.done.sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
  return out;
}

/** The To Dos the inbox shows: every open one, and those done today. */
export const shownTodos = <T extends Pick<TodoSummary, 'status' | 'doneAt'>>(todos: readonly T[], now: Date): T[] => {
  const today = londonParts(now).dateKey;
  return todos.filter((t) => t.status === 'open' || (t.doneAt && londonParts(t.doneAt).dateKey === today));
};

/** A To Do's plan as a row shows it (FR-16.6): the estimate and ideal deadline, with their whys. */
export function planOf(t: TodoState, words?: { estimateWhy: string; deadlineWhy?: string }): Pick<TodoSummary, 'effortMinutes' | 'effortBy' | 'confidence' | 'estimateWhy' | 'ideal' | 'idealWhy' | 'planning'> {
  return {
    ...(t.effortMinutes && { effortMinutes: t.effortMinutes, effortBy: t.effortBy ?? 'model' }),
    ...(t.confidence && t.effortBy !== 'you' && { confidence: t.confidence }),
    ...(words && t.effortBy !== 'you' && { estimateWhy: words.estimateWhy }),
    ...(t.ideal && { ideal: t.ideal, ...(words?.deadlineWhy && { idealWhy: words.deadlineWhy }) }),
    ...(t.status === 'open' && !t.planned && (t.planFailures ?? 0) < SCHEDULE_MAX_ATTEMPTS && { planning: true }),
  };
}

/**
 * Every open To Do's slot or why it has none (FR-16.8), from the slots already kept: placed again
 * the same way, it shows what the planner keeps or would write. Without events, the calendar is off.
 */
export function todoSlots(todos: readonly TodoState[], a: { now: Date; workHours: string; events?: readonly BusyEvent[]; calendarTo?: string; bufferMinutes?: number }): Record<string, SlotResult> {
  const open = todos.filter((t) => t.status === 'open');
  return planSlots({ ...a, todos: open.map((t) => ({ id: t.id, createdAt: t.createdAt, ...(t.effortMinutes && { effortMinutes: t.effortMinutes }), ...(t.deadline && { deadline: t.deadline }), ...(t.ideal && { ideal: t.ideal }), ...(t.slot && { slot: t.slot }) })) });
}

/** A slot result as a row shows it. */
export function slotOf(r: SlotResult | undefined): Pick<TodoSummary, 'slot' | 'noSlot'> {
  if (!r) return {};
  if (r.kind === 'none') return { noSlot: { reason: r.reason, ...(r.firstAfter && { firstAfter: r.firstAfter }) } };
  return { slot: { start: r.start, end: r.end, by: r.by, ...(r.clash && { clash: r.clash }), ...(r.passed && { passed: r.passed }) } };
}

/** Done within FOLLOWUP_WINDOW_HOURS, with no follow-ups yet and not given up on (FR-16.11). Not one made at start from an old to-do. */
export const followupWanted = (t: TodoState, now: Date) =>
  t.status === 'done' && !t.backfilled && !t.followups && (t.followupFailures ?? 0) < FOLLOWUP_MAX_ATTEMPTS && !!t.doneAt && now.getTime() - Date.parse(t.doneAt) < FOLLOWUP_WINDOW_HOURS * 3_600_000;

/** A done To Do's follow-ups as a row shows them, from their words in todos/ (FR-16.11). */
export function followupsOf(t: TodoState, words: readonly Followup[] | undefined, now: Date): Pick<TodoSummary, 'followups' | 'followupsPending'> {
  if (t.status !== 'done') return {};
  if (t.followups && words) return t.followups.kinds.length ? { followups: words.map((f, i) => ({ ...f, ...(t.followups?.answers?.[i] && { answer: t.followups.answers[i] }) })) } : {};
  return followupWanted(t, now) ? { followupsPending: true } : {};
}
