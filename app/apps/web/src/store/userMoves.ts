import { create } from 'zustand';

// Items Frank just moved himself: Undo, Reopen, a correction, Retry, Split out (cockpit CK-1.2).
// While the item panel is open the Inbox holds new rows back so nothing moves under him, but a row
// he brought back himself lands at once. Each id is kept for half a minute, long enough for the
// change to come back from the server.

export const USER_MOVE_MS = 30_000;

interface UserMoves {
  ids: Record<string, true>;
  note: (ids: readonly string[]) => void;
}

export const useUserMoves = create<UserMoves>()((set) => ({
  ids: {},
  note: (ids) => {
    if (!ids.length) return;
    set((s) => ({ ids: { ...s.ids, ...Object.fromEntries(ids.map((id) => [id, true as const])) } }));
    setTimeout(
      () =>
        set((s) => {
          const next = { ...s.ids };
          for (const id of ids) delete next[id];
          return { ids: next };
        }),
      USER_MOVE_MS,
    );
  },
}));

export const noteUserMove = (ids: readonly string[]) => useUserMoves.getState().note(ids);
