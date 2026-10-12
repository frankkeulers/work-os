import type { TodoBy } from './events';
import type { SourceId } from './schemas';
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
  status: 'open' | 'done';
  deadline?: string;
  deadlineFrom: DeadlineFrom;
  createdAt: string;
  doneAt?: string;
  doneBy?: TodoBy;
  /** False once the Tasks note was read and its line wasn't there; absent while unknown. */
  inNote?: boolean;
}

export type TodoGroup = 'overdue' | 'today' | 'upcoming' | 'done';
export const TODO_GROUPS: readonly TodoGroup[] = ['overdue', 'today', 'upcoming', 'done'];

/**
 * Where a To Do sits: done (today; older ones aren't shown), overdue once its deadline has passed,
 * today when it is due today in London, else upcoming, with To Dos that have no deadline.
 */
export function todoGroup(t: Pick<TodoSummary, 'status' | 'deadline'>, now: Date): TodoGroup {
  if (t.status === 'done') return 'done';
  if (!t.deadline) return 'upcoming';
  if (t.deadline < now.toISOString()) return 'overdue';
  return londonParts(t.deadline).dateKey === londonParts(now).dateKey ? 'today' : 'upcoming';
}

/** Soonest deadline first, those without one last; then the oldest. Done ones: the latest done first. */
const byDue = (a: TodoSummary, b: TodoSummary) => Number(!a.deadline) - Number(!b.deadline) || (a.deadline ?? '').localeCompare(b.deadline ?? '') || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** To Dos by group, each in the order it shows. Done ones are those done today. */
export function todoGroups(todos: readonly TodoSummary[], now: Date): Record<TodoGroup, TodoSummary[]> {
  const today = londonParts(now).dateKey;
  const out: Record<TodoGroup, TodoSummary[]> = { overdue: [], today: [], upcoming: [], done: [] };
  for (const t of todos) {
    const g = todoGroup(t, now);
    if (g === 'done' && (!t.doneAt || londonParts(t.doneAt).dateKey !== today)) continue;
    out[g].push(t);
  }
  for (const g of ['overdue', 'today', 'upcoming'] as const) out[g].sort(byDue);
  out.done.sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
  return out;
}

/** The To Dos the inbox shows: every open one, and those done today. */
export const shownTodos = <T extends Pick<TodoSummary, 'status' | 'doneAt'>>(todos: readonly T[], now: Date): T[] => {
  const today = londonParts(now).dateKey;
  return todos.filter((t) => t.status === 'open' || (t.doneAt && londonParts(t.doneAt).dateKey === today));
};
