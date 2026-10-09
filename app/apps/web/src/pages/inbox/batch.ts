import type { ActionType } from '@work-os/shared';
import type { ItemSummary } from '../../api';
import { draftState, suggestedTypes } from '../../lib/lanes';

// File in a batch (cockpit CK-4.1–4.4): the To file items in a row, one panel at a time, each on
// its suggested filing. Drafts run one item ahead; approving moves on, and the server marks the
// item done once all its filings are written.

export interface Batch {
  /** The To file items as they showed when the batch began. */
  ids: string[];
  filed: number;
  skipped: number;
  /** Past the last item: the panel shows the tally until Esc. */
  done: boolean;
}

/** The suggested filings still to approve, Confluence first; none for people observations' Confluence (FR-10.1). */
export function openFilings(item: ItemSummary): ActionType[] {
  return suggestedTypes(item).filter((t) => !(t === 'confluence_entry' && item.containsPeopleObservations) && draftState(item, t) !== 'done' && draftState(item, t) !== 'writing');
}

/** An item the batch can take: open, in To file, with a filing still to approve. */
export const batchable = (item: ItemSummary | undefined): item is ItemSummary => !!item && item.status === 'open' && item.lane === 'file' && openFilings(item).length > 0;

/** The filing a batch opens an item on, or moves to after `approved`. */
export const filingFor = (item: ItemSummary, approved?: ActionType): ActionType | undefined => openFilings(item).find((t) => t !== approved);

/** Whether to start this filing's draft now: nothing drafted yet, and the budget allows it. */
export const needsDraft = (item: ItemSummary, type: ActionType, budgetHit: boolean) => !budgetHit && draftState(item, type) === 'none';

/** "4 filed · 1 skipped". */
export const tally = (b: Pick<Batch, 'filed' | 'skipped'>) => [`${b.filed} filed`, b.skipped ? `${b.skipped} skipped` : ''].filter(Boolean).join(' · ');
