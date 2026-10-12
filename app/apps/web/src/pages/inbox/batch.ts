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
  /**
   * The filings approved on the current item. The inbox may not show them as writing yet, and the
   * batch must not go back to one.
   */
  approved: ActionType[];
  /** Past the last item: the panel shows the tally until Esc. */
  done: boolean;
  /** Approve ready (FR-15.5): only the filings in Ready to approve. */
  readyOnly?: boolean;
}

/** The suggested filings still to approve, Confluence first; `readyOnly`, those in Ready to approve (FR-15.5). */
export function openFilings(item: ItemSummary, readyOnly = false): ActionType[] {
  return suggestedTypes(item).filter((t) => draftState(item, t) !== 'done' && draftState(item, t) !== 'writing' && (!readyOnly || (t !== 'todo' && !!item.filing?.[t]?.ready)));
}

/** An item the batch can take: open, in To file, with a filing still to approve. */
export const batchable = (item: ItemSummary | undefined, readyOnly = false): item is ItemSummary => !!item && item.status === 'open' && item.lane === 'file' && openFilings(item, readyOnly).length > 0;

/** The filing a batch opens an item on, or moves to after those `approved`. */
export const filingFor = (item: ItemSummary, approved: readonly ActionType[] = [], readyOnly = false): ActionType | undefined => openFilings(item, readyOnly).find((t) => !approved.includes(t));

/** Whether to start this filing's draft now: nothing drafted yet, and the budget allows it. */
export const needsDraft = (item: ItemSummary, type: ActionType, budgetHit: boolean) => !budgetHit && draftState(item, type) === 'none';

/** "4 filed · 1 skipped". */
export const tally = (b: Pick<Batch, 'filed' | 'skipped'>) => [`${b.filed} filed`, b.skipped ? `${b.skipped} skipped` : ''].filter(Boolean).join(' · ');
