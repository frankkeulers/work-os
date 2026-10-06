import { isSnoozeDue, type EventDraft } from '@work-os/shared';
import type { Store } from '../store/store';

// Work that falls due by the wall clock, checked on every tick (PLAN.md robustness §3): never a
// long timer, which would stop while the Mac sleeps. Snoozed items return here (FR-8.3); the
// quiet window and retention join in M2 and M4.

export async function returnSnoozed(store: Store, now: Date): Promise<number> {
  const at = now.toISOString();
  const due: EventDraft[] = Object.values(store.projection.items)
    .filter((i) => isSnoozeDue(i, at))
    .map((i) => ({ type: 'item.unsnoozed', itemId: i.id, data: undefined }));
  if (due.length) await store.append(...due);
  return due.length;
}
