import type { SourceRow, WeekEvent } from '@work-os/shared';

// The state filter on a source's history (cockpit CK-5.8): Done is hidden until Frank shows it, and
// every other state shows until he hides it.
// Each row or meeting is in exactly one state, so the counts add up to the whole.

export type RowState = 'needs' | 'week' | 'follow' | 'file' | 'else' | 'waiting' | 'snoozed' | 'done';
export type MeetingState = 'going' | 'unanswered' | 'declined' | 'cancelled';
export type FilterState = RowState | MeetingState;

export const ROW_STATES: { id: RowState; label: string; dot: string }[] = [
  { id: 'needs', label: 'Needs you', dot: 'var(--orange)' },
  { id: 'week', label: 'This week', dot: 'var(--accent-light)' },
  { id: 'follow', label: 'Waiting on others', dot: 'var(--gray-solid)' },
  { id: 'file', label: 'To file', dot: 'var(--teal-solid)' },
  { id: 'else', label: 'Low priority', dot: 'var(--gray-mid)' },
  { id: 'waiting', label: 'Waiting', dot: 'var(--gray-mid)' },
  { id: 'snoozed', label: 'Snoozed', dot: 'var(--gray-mid)' },
  { id: 'done', label: 'Done', dot: 'var(--green)' },
];

export const MEETING_STATES: { id: MeetingState; label: string; dot: string }[] = [
  { id: 'going', label: 'Going', dot: 'var(--accent-bg)' },
  { id: 'unanswered', label: 'Not answered', dot: 'var(--amber)' },
  { id: 'declined', label: 'Declined', dot: 'var(--gray-mid)' },
  { id: 'cancelled', label: 'Cancelled', dot: 'var(--gray-mid)' },
];

/** What a source hides before Frank has chosen: Done, on the lists; nothing, on the calendar. */
export const defaultHidden = (calendar: boolean): string[] => (calendar ? [] : ['done']);

/** Where triage put a row, as the filter names it: Now, Today and failed triage are all Needs you. */
export function rowState(i: Pick<SourceRow, 'lane'>): RowState {
  if (i.lane === 'now' || i.lane === 'today' || i.lane === 'failed') return 'needs';
  return i.lane;
}

/** A meeting's state: cancelled first, then Frank's answer. His own meetings are ones he's going to. */
export function meetingState(e: Pick<WeekEvent, 'cancelled' | 'response'>): MeetingState {
  if (e.cancelled) return 'cancelled';
  if (e.response === 'declined') return 'declined';
  if (e.response === 'none' || e.response === 'notResponded') return 'unanswered';
  return 'going';
}

/** How many of each state there are, for the chips. */
export function countBy<T, S extends string>(xs: readonly T[], stateOf: (x: T) => S): Partial<Record<S, number>> {
  const counts: Partial<Record<S, number>> = {};
  for (const x of xs) {
    const s = stateOf(x);
    counts[s] = (counts[s] ?? 0) + 1;
  }
  return counts;
}
