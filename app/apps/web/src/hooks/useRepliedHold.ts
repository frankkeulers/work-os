import { useEffect, useRef, useState } from 'react';
import { api, type ItemSummary } from '../api';
import { SOURCE_NAME } from '../lib/next';
import { errorToast, toast } from '../store/toasts';

// Closed by Frank's reply (cockpit CK-2.5): an item that leaves Needs you because his reply settled
// it stays in its row for 5 s as "You replied", then goes the way any row goes (CK-1.2). A toast
// says so, with Undo.

export const REPLIED_HOLD_MS = 5000;

/** In Needs you, or Later's This week: where a reply can close an item from. */
const AWAITS = new Set<ItemSummary['lane']>(['now', 'today', 'week']);
/** Held where they were: Needs you only. */
const HELD = new Set<ItemSummary['lane']>(['now', 'today']);

export const closedByReply = (i: ItemSummary) => i.status === 'done' && i.doneBy === 'reply';

interface State {
  input: readonly ItemSummary[];
  /** Open items a reply can close, by the lane each was in; unset until the first load. */
  open?: ReadonlyMap<string, ItemSummary['lane']>;
  held: ItemSummary[];
  fresh: ItemSummary[];
}

/** The items to hold in Needs you as "You replied": their latest state, in the lane they left. */
export function useRepliedHold(items: readonly ItemSummary[], loaded: boolean): ItemSummary[] {
  const [st, setSt] = useState<State>({ input: items, held: [], fresh: [] });
  if (st.input !== items) {
    const byId = new Map(items.map((i) => [i.id, i]));
    const was = st.open;
    const fresh = was ? items.filter((i) => closedByReply(i) && was.has(i.id)) : [];
    const freshIds = new Set(fresh.map((i) => i.id));
    // Undo brings it straight back: only what is still closed by reply stays held.
    const kept = st.held.flatMap((h) => {
      const now = byId.get(h.id);
      return now && closedByReply(now) && !freshIds.has(h.id) ? [{ ...now, lane: h.lane }] : [];
    });
    const held = fresh.flatMap((i) => {
      const lane = was?.get(i.id);
      return lane && HELD.has(lane) ? [{ ...i, lane }] : [];
    });
    setSt({ input: items, open: loaded ? new Map(items.filter((i) => i.status === 'open' && AWAITS.has(i.lane)).map((i) => [i.id, i.lane])) : undefined, held: [...kept, ...held], fresh });
  }

  // A toast for each, then the row goes after 5 s. Timers outlive the next update; only leaving the page clears them.
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const set = timers.current;
    return () => set.forEach(clearTimeout);
  }, []);
  useEffect(() => {
    if (!st.fresh.length) return;
    for (const i of st.fresh) {
      toast(`Closed: you replied in ${SOURCE_NAME[i.doneSource ?? i.source]}`, {
        key: `replied:${i.id}`, // StrictMode runs this twice in development: the second replaces the first
        description: `${i.title} · ${i.summary}`,
        tone: 'success',
        action: { label: 'Undo', run: () => void api.reopen(i.id).catch(errorToast) },
      });
    }
    const ids = new Set(st.fresh.map((i) => i.id));
    const t = setTimeout(() => {
      timers.current.delete(t);
      setSt((s) => ({ ...s, held: s.held.filter((h) => !ids.has(h.id)) }));
    }, REPLIED_HOLD_MS);
    timers.current.add(t);
  }, [st.fresh]);

  return st.held;
}
