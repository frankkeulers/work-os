import type { Attention, TriageCorrection, TriageDecision } from './schemas';

// Inbox lanes (FR-8.1) plus the off-lane places an item can be.
export type Lane = 'now' | 'today' | 'file' | 'else' | 'failed' | 'waiting' | 'snoozed' | 'done';

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
  return eff.confluence || eff.vault ? 'file' : 'else';
}
