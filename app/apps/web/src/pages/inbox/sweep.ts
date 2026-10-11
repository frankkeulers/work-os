// The end-of-day sweep (BACKLOG UX-10): Needs you, one item at a time, each dealt with by one key
// (e done, s snooze, r reply, f or v file, → skip), with a tally at the end. Aimed at C3, Needs you
// empty at 18:00.

export type SweepOutcome = 'done' | 'snoozed' | 'replied' | 'filed' | 'skipped';

export interface Sweep {
  /** The Needs you items as they showed when the sweep began. */
  ids: string[];
  counts: Record<SweepOutcome, number>;
  /** Items already counted, so one that is both filed and then closed counts once. */
  counted: string[];
  /** Stopped or past the last item: the panel shows the tally until Esc. */
  finished: boolean;
  /** Just counted as done or snoozed by its own keys: move on from it. */
  from?: string;
}

/** The first item from `from` on that is still open: the sweep passes over any closed meanwhile. */
export const nextInSweep = (s: Sweep, from: number, items: readonly { id: string; status: string }[]) => s.ids.slice(from).find((id) => items.some((i) => i.id === id && i.status === 'open'));

export const newSweep = (ids: string[]): Sweep => ({ ids, counts: { done: 0, snoozed: 0, replied: 0, filed: 0, skipped: 0 }, counted: [], finished: false });

/** The sweep with `id` counted as `outcome`. */
export const counted = (s: Sweep, id: string, outcome: SweepOutcome): Sweep => ({ ...s, counts: { ...s.counts, [outcome]: s.counts[outcome] + 1 }, counted: [...s.counted, id] });

const ORDER: SweepOutcome[] = ['done', 'snoozed', 'replied', 'filed', 'skipped'];

/** "3 done · 1 snoozed · 2 skipped", or "Nothing changed". */
export const sweepTally = (s: Sweep) =>
  ORDER.filter((o) => s.counts[o])
    .map((o) => `${s.counts[o]} ${o}`)
    .join(' · ') || 'Nothing changed';
