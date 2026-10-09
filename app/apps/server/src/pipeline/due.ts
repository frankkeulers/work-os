import { isSnoozeDue, londonParts, type EventDraft } from '@work-os/shared';
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

/**
 * Calls `onNewDay` the first time it sees a new London date. The inbox's lanes depend on the day
 * (cockpit CK-3.10: This week items due today move into Needs you at midnight), so open tabs are
 * told to refetch.
 */
export function newDayWatcher(onNewDay: () => void): (now: Date) => void {
  let day: string | undefined;
  return (now) => {
    const today = londonParts(now).dateKey;
    if (day !== undefined && today !== day) onNewDay();
    day = today;
  };
}
