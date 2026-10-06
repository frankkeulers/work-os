import type { ItemState } from '@work-os/shared';

// Which items the model triages next (§5.3, FR-5.1): those waiting for triage whose thread has been
// quiet for `quietMinutes`, oldest first. Rules that fix attention have already decided at ingest,
// and Frank's own replies never put an item back in the queue, so neither appears here.

export interface TriageQueue {
  /** Quiet and waiting, oldest activity first. */
  ready: ItemState[];
  /** When the next waiting item goes quiet, so the runtime can triage it then. */
  nextReadyAt?: Date;
}

export function triageQueue(items: Iterable<ItemState>, now: Date, quietMinutes: number): TriageQueue {
  const quietMs = quietMinutes * 60_000;
  const ready: ItemState[] = [];
  let next: number | undefined;
  for (const it of items) {
    if (it.triageState !== 'pending') continue;
    const quietAt = Date.parse(it.lastActivityAt) + quietMs;
    if (quietAt <= now.getTime()) ready.push(it);
    else next = next === undefined ? quietAt : Math.min(next, quietAt);
  }
  ready.sort((a, b) => a.lastActivityAt.localeCompare(b.lastActivityAt));
  return { ready, ...(next !== undefined && { nextReadyAt: new Date(next) }) };
}
