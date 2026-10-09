// Rows hold their place (cockpit CK-1.2). A group's order on screen only changes where it must: an
// item that updates in place keeps its row; a new item, or one whose lane changed, goes in at its
// sorted position; an item that left is dropped. While the item panel is open, nothing lands where
// it would move what Frank can see: it waits until the panel closes, unless it lands below the view.

/** A group's rows as shown, and the lane each had when it was placed. */
export interface GroupOrder {
  order: string[];
  lanes: Record<string, string>;
}

/**
 * Which rows of the group are on screen, by index into its order: `start` is the first row in view,
 * `end` the first row below it (the order's length when none is). `atTop`: the list isn't scrolled,
 * so a row added at the top is seen arriving rather than slipped in above.
 */
export interface Viewport {
  start: number;
  end: number;
  atTop: boolean;
}

export const ALL_IN_VIEW: Viewport = { start: 0, end: Number.POSITIVE_INFINITY, atTop: true };

export interface Placed {
  id: string;
  index: number;
  /** It went in above the rows in view, which stay put: say so with a pill. */
  above: boolean;
  /** It is new to this group, not just moved within it (the New dot, CK-1.3). */
  entered: boolean;
}

export interface Settled {
  next: GroupOrder;
  placed: Placed[];
  /** Waiting for the panel to close; `above`: it would land above the rows in view. */
  pending: { id: string; above: boolean }[];
  /** Gone from the group, with the row before it, so it can collapse where it was. */
  left: { id: string; after?: string; above: boolean }[];
}

/**
 * The group's next order. `prev` is what's on screen (undefined: show `sorted` as it is); `sorted` is
 * the group in the chosen order now.
 */
export function settleGroup(
  prev: GroupOrder | undefined,
  sorted: readonly { id: string; lane: string }[],
  opts: { frozen: boolean; view: Viewport; exempt?: (id: string) => boolean },
): Settled {
  const exempt = opts.exempt ?? (() => false);
  if (!prev) return { next: { order: sorted.map((i) => i.id), lanes: Object.fromEntries(sorted.map((i) => [i.id, i.lane])) }, placed: [], pending: [], left: [] };

  const current = new Map(sorted.map((i) => [i.id, i]));
  const was = new Set(prev.order);
  const left: Settled['left'] = [];
  const kept: string[] = [];
  const lanes: Record<string, string> = {};
  const moving = new Set<string>();
  prev.order.forEach((id, n) => {
    const now = current.get(id);
    if (!now) {
      left.push({ id, after: prev.order[n - 1], above: !opts.view.atTop && n < opts.view.start });
      return;
    }
    // A lane change moves the row, but not while the panel is open: it moves once the panel closes.
    if (now.lane !== prev.lanes[id] && (!opts.frozen || exempt(id))) {
      moving.add(id);
      return;
    }
    kept.push(id);
    lanes[id] = prev.lanes[id];
  });

  // Rows that left above the view shift what's in view up by one each.
  let { start, end } = opts.view;
  for (const l of left) {
    const n = prev.order.indexOf(l.id);
    if (n < start) start--;
    if (n < end) end--;
  }
  for (const id of moving) {
    const n = prev.order.indexOf(id);
    if (n < start) start--;
    if (n < end) end--;
  }

  const order = [...kept];
  const placed: Placed[] = [];
  const pending: Settled['pending'] = [];
  sorted.forEach((item, k) => {
    if (!moving.has(item.id) && was.has(item.id)) return;
    // Just after the nearest item before it in sorted order that's already on screen.
    let pos = 0;
    for (let j = k - 1; j >= 0; j--) {
      const at = order.indexOf(sorted[j].id);
      if (at >= 0) {
        pos = at + 1;
        break;
      }
    }
    const above = !opts.view.atTop && pos <= start;
    if (opts.frozen && pos < end && !exempt(item.id)) {
      pending.push({ id: item.id, above });
      return;
    }
    order.splice(pos, 0, item.id);
    lanes[item.id] = item.lane;
    for (const p of placed) if (p.index >= pos) p.index++;
    placed.push({ id: item.id, index: pos, above, entered: !was.has(item.id) });
    if (pos <= start) start++;
    if (pos <= end) end++;
  });

  return { next: { order, lanes }, placed, pending, left };
}
