import type { Attention, NextStep, TriageCorrection, TriageDecision } from './schemas';
import { londonAt, londonParts } from './time';

// Inbox lanes (FR-8.1) plus the off-lane places an item can be. `week` is a view of Today: Today
// items due after today (cockpit CK-3.10). `follow` is Waiting on others: Frank owns the outcome,
// someone else has the next move (FR-8.1, amended). `waiting` is the quiet window, not that.
export type Lane = 'now' | 'today' | 'week' | 'follow' | 'file' | 'else' | 'failed' | 'waiting' | 'snoozed' | 'done';

export type ItemStatus = 'open' | 'done' | 'snoozed';
export type TriageState = 'pending' | 'triaged' | 'failed';

/** The parts of a decision lanes need. A full TriageDecision and a LoggedDecision both fit. */
export type DecisionLike = Pick<TriageDecision, 'itemRevision' | 'attention' | 'confluence' | 'vault' | 'decidedBy'>;

export interface EffectiveTriage {
  attention: Attention;
  confluence: boolean;
  vault: boolean;
  by: 'rule' | 'model' | 'user';
}

/**
 * The triage the inbox acts on. A correction wins over the decision for the same or an
 * older revision; a model or rule decision on a newer revision wins over the correction.
 */
export function effectiveTriage(
  decision: DecisionLike | undefined,
  correction: TriageCorrection | undefined,
): EffectiveTriage | undefined {
  if (correction && (!decision || correction.itemRevision >= decision.itemRevision)) {
    return { attention: correction.attention, confluence: correction.confluence, vault: correction.vault, by: 'user' };
  }
  if (!decision) return undefined;
  return {
    attention: decision.attention,
    confluence: decision.confluence.suggested,
    vault: decision.vault.suggested,
    by: decision.decidedBy,
  };
}

export function laneFor(input: {
  status: ItemStatus;
  triageState: TriageState;
  decision?: DecisionLike;
  correction?: TriageCorrection;
}): Lane {
  if (input.status === 'done') return 'done';
  if (input.status === 'snoozed') return 'snoozed';
  const eff = effectiveTriage(input.decision, input.correction);
  // An item keeps its previous lane while a re-triage is pending.
  if (!eff) return input.triageState === 'failed' ? 'failed' : 'waiting';
  if (eff.attention === 'now') return 'now';
  if (eff.attention === 'today') return 'today';
  if (eff.attention === 'follow') return 'follow'; // attention wins over filing, as Now and Today do
  return eff.confluence || eff.vault ? 'file' : 'else';
}

/**
 * Later › This week (cockpit CK-3.10): a next step due after the end of today, London time. With no
 * `dueAt` (decisions from before triage v7), a label saying so: "next week" always; "this week" or
 * "by Friday" from Monday to Thursday, as on Friday it means today.
 */
export function dueAfterToday(next: Pick<NextStep, 'dueAt' | 'dueLabel'> | undefined, now: Date | string): boolean {
  if (!next) return false;
  if (next.dueAt) return Date.parse(next.dueAt) >= Date.parse(londonAt(new Date(now), '00:00', 1));
  const label = next.dueLabel ?? '';
  if (/\bnext week\b/i.test(label)) return true;
  return /\b(this week|by friday)\b/i.test(label) && !['Fri', 'Sat', 'Sun'].includes(londonParts(now).weekday);
}

/** The lane the inbox shows: a Today item due after today moves to This week. A correction to Now wins, as it is Now. */
export function viewLane(lane: Lane, next: Pick<NextStep, 'dueAt' | 'dueLabel'> | undefined, now: Date | string): Lane {
  return lane === 'today' && dueAfterToday(next, now) ? 'week' : lane;
}
