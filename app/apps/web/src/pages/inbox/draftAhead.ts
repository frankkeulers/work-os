import { useEffect, useRef } from 'react';
import type { ActionType, BudgetState } from '@work-os/shared';
import type { ItemSummary } from '../../api';
import { draftState } from '../../lib/lanes';
import { requestQuietDraft } from '../../store/quietDrafts';
import { batchable, filingFor } from './batch';

// Draft ahead (BACKLOG UX-3): the suggested draft for a To file item starts before Frank opens it,
// so review is instant. It starts when an item enters To file, or when j/k (or a click) lands on
// one, one draft at a time, and never eats into the last few drafts of the day: those are kept for
// the ones Frank asks for. What was in To file on load waits until he lands on it.

/** Drafts left today at or below which nothing is drafted ahead. */
export const SPARE_DRAFTS = 3;

/** Whether drafting ahead may spend a draft now. */
export const canDraftAhead = (b: BudgetState) => !b.drafts.hit && !b.cost.hit && b.drafts.limit - b.drafts.used > SPARE_DRAFTS;

const drafting = (items: readonly ItemSummary[]) => items.some((i) => Object.values(i.actions).some((a) => a?.status === 'drafting'));

/**
 * The draft to start now, if any: the first in `queue` that is in To file with a suggested filing
 * not yet drafted, and not drafted ahead before (a discarded one isn't drafted again).
 */
export function pickDraftAhead(items: readonly ItemSummary[], queue: readonly string[], tried: ReadonlySet<string>, budgets: BudgetState): { item: ItemSummary; type: ActionType } | undefined {
  if (!canDraftAhead(budgets) || drafting(items)) return undefined;
  for (const id of queue) {
    const item = items.find((i) => i.id === id);
    if (!batchable(item)) continue;
    const type = filingFor(item);
    if (type && draftState(item, type) === 'none' && !tried.has(`${id}:${type}`)) return { item, type };
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
    const pick = pickDraftAhead(items, [...(selected ? [selected] : []), ...entered.current], tried.current, budgets);
    if (!pick) return;
    const { item, type } = pick;
    tried.current.add(`${item.id}:${type}`);
    entered.current = entered.current.filter((id) => id !== item.id);
    inFlight.current = { id: item.id, type };
    requestQuietDraft(item.id, type).catch(() => {
      if (inFlight.current?.id === item.id) inFlight.current = null;
    });
  }, [items, selected, budgets]);
}
