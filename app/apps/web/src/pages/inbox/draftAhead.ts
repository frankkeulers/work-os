import { useEffect, useRef } from 'react';
import type { ActionType, BudgetState } from '@work-os/shared';
import type { ItemSummary } from '../../api';
import { draftState, isReady } from '../../lib/lanes';
import { requestQuietDraft } from '../../store/quietDrafts';
import { batchable, openFilings } from './batch';

// Draft ahead (BACKLOG UX-3): the suggested draft for a To file item starts before Frank opens it,
// so review is instant. It starts when an item enters To file, or when j/k (or a click) lands on
// one, one draft at a time, and never eats into the last few drafts of the day: those are kept for
// the ones Frank asks for. What was in To file on load waits until he lands on it.
//
// Only what the filing policy says to pre-draft is drafted ahead (FR-15.3), and what is ready to
// approve goes first (FR-15.5). The rest waits for Frank's f or v.

/** Drafts left today at or below which nothing is drafted ahead. */
export const SPARE_DRAFTS = 3;

/** Whether drafting ahead may spend a draft now. */
export const canDraftAhead = (b: BudgetState) => !b.drafts.hit && !b.cost.hit && b.drafts.limit - b.drafts.used > SPARE_DRAFTS;

const drafting = (items: readonly ItemSummary[]) => items.some((i) => Object.values(i.actions).some((a) => a?.status === 'drafting'));

/** Whether the policy pre-drafts this filing. A row without a plan is from before the policy, which pre-drafted every one. */
export const predrafted = (item: ItemSummary, type: ActionType) => (item.filing ? !!(type !== 'todo' && item.filing[type]?.predraft) : true);

/** The order to look in: the item Frank landed on, then those that entered To file, ready ones first. */
export function aheadQueue(items: readonly ItemSummary[], selected: string | null, entered: readonly string[]): string[] {
  const ready = (id: string) => isReady(items.find((i) => i.id === id));
  return [...(selected ? [selected] : []), ...entered.filter(ready), ...entered.filter((id) => !ready(id))];
}

/**
 * The draft to start now, if any: the first in `queue` that is in To file with a suggested filing
 * the policy pre-drafts, not yet drafted, and not drafted ahead before (a discarded one isn't
 * drafted again).
 */
export function pickDraftAhead(items: readonly ItemSummary[], queue: readonly string[], tried: ReadonlySet<string>, budgets: BudgetState): { item: ItemSummary; type: ActionType } | undefined {
  if (!canDraftAhead(budgets) || drafting(items)) return undefined;
  for (const id of queue) {
    const item = items.find((i) => i.id === id);
    if (!batchable(item)) continue;
    const type = openFilings(item).find((t) => predrafted(item, t) && draftState(item, t) === 'none' && !tried.has(`${id}:${t}`));
    if (type) return { item, type };
  }
  return undefined;
}

export function useDraftAhead(items: readonly ItemSummary[] | undefined, selected: string | null, budgets: BudgetState | undefined) {
  const seen = useRef<Set<string> | null>(null);
  const entered = useRef<string[]>([]);
  const tried = useRef(new Set<string>());
  // Asked for, and not yet showing as drafting in the inbox: holds the next one back.
  const inFlight = useRef<{ id: string; type: ActionType } | null>(null);
  useEffect(() => {
    if (!items || !budgets) return;
    const inFile = items.filter((i) => i.status === 'open' && i.lane === 'file').map((i) => i.id);
    if (!seen.current) seen.current = new Set(inFile);
    else
      for (const id of inFile)
        if (!seen.current.has(id)) {
          seen.current.add(id);
          entered.current.push(id);
        }
    entered.current = entered.current.filter((id) => batchable(items.find((i) => i.id === id)));
    const f = inFlight.current;
    if (f) {
      const item = items.find((i) => i.id === f.id);
      if (item && draftState(item, f.type) === 'none') return;
      inFlight.current = null;
    }
    const pick = pickDraftAhead(items, aheadQueue(items, selected, entered.current), tried.current, budgets);
    if (!pick) return;
    const { item, type } = pick;
    // Kept in the queue: an item may have a second filing to draft ahead once this one is done.
    tried.current.add(`${item.id}:${type}`);
    inFlight.current = { id: item.id, type };
    requestQuietDraft(item.id, type).catch(() => {
      if (inFlight.current?.id === item.id) inFlight.current = null;
    });
  }, [items, selected, budgets]);
}
