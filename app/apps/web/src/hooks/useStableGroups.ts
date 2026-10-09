import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ItemSummary } from '../api';
import { ALL_IN_VIEW, settleGroup, type GroupOrder, type Viewport } from '../lib/stableOrder';

// Rows hold their place (cockpit CK-1.2): the Inbox's groups in a stable order, the rows in view kept
// still when rows land above them, rows that leave collapsing where they were, and the rows that
// landed above the view, for the "1 new Now item above" pill.

export const LEAVE_MS = 200;

export interface ShownRow {
  item: ItemSummary;
  leaving?: boolean;
}

interface Leaving {
  item: ItemSummary;
  after?: string;
}

interface State<G extends string> {
  input: Record<G, ItemSummary[]>;
  key: string;
  frozen: boolean;
  exempt: ReadonlySet<string>;
  view: Record<G, Viewport> | undefined;
  orders: Record<G, GroupOrder> | undefined;
  items: Record<string, ItemSummary>;
  leaving: Record<G, Leaving[]>;
  above: Record<G, string[]>;
  pending: Record<G, { id: string; above: boolean }[]>;
  entered: { seq: number; ids: string[] };
}

export interface StableOptions {
  resetKey: string;
  /** The item panel is open: hold new rows back where they'd move what's in view. */
  frozen: boolean;
  /** Rows to land at once even so: what Frank moved himself, and what he asked to see. */
  exempt: ReadonlySet<string>;
}

const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const map = <G extends string, A, B>(r: Record<G, A>, f: (a: A, g: G) => B) => Object.fromEntries(Object.entries(r).map(([g, a]) => [g, f(a as A, g as G)])) as Record<G, B>;
const sameView = (a: Viewport, b: Viewport) => a.start === b.start && a.end === b.end && a.atTop === b.atTop;

export function useStableGroups<G extends string>(groups: Record<G, ItemSummary[]>, scrollerRef: RefObject<HTMLElement | null>, opts: StableOptions) {
  const ids = Object.keys(groups) as G[];
  const empty = <T,>(v: () => T) => Object.fromEntries(ids.map((g) => [g, v()])) as Record<G, T>;
  const [view, setView] = useState<Record<G, Viewport> | undefined>(undefined);
  const [st, setSt] = useState<State<G>>(() => ({
    input: groups,
    key: opts.resetKey,
    frozen: opts.frozen,
    exempt: opts.exempt,
    view,
    orders: undefined,
    items: {},
    leaving: empty(() => []),
    above: empty(() => []),
    pending: empty(() => []),
    entered: { seq: 0, ids: [] },
  }));

  // Settle the order whenever the data, the panel or the view changes (derived state, in render).
  const stale = !st.orders || st.input !== groups || st.key !== opts.resetKey || st.frozen !== opts.frozen || st.exempt !== opts.exempt || st.view !== view;
  const cur = stale ? settleAll(st, groups, view, opts, ids) : st;
  if (cur !== st) setSt(cur);

  // Leaving rows collapse, then go.
  const anyLeaving = ids.some((g) => cur.leaving[g].length > 0);
  useEffect(() => {
    if (!anyLeaving) return;
    const t = setTimeout(() => setSt((s) => ({ ...s, leaving: map(s.leaving, () => []) })), LEAVE_MS);
    return () => clearTimeout(t);
  }, [anyLeaving, cur.leaving]);

  // What's on screen: the rows in view per group, and the first of them, to keep still.
  const anchor = useRef<{ id: string; offset: number } | undefined>(undefined);
  const groupsKey = ids.join(',');
  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    const atTop = el.scrollTop <= 0;
    const next = {} as Record<G, Viewport>;
    let first: { id: string; offset: number } | undefined;
    for (const g of groupsKey.split(',') as G[]) {
      const rows = [...el.querySelectorAll<HTMLElement>(`[data-group="${g}"] [data-row]:not([data-leaving])`)];
      let start = rows.length;
      let end = rows.length;
      for (const [n, r] of rows.entries()) {
        const rect = r.getBoundingClientRect();
        if (start === rows.length && rect.bottom > box.top) {
          start = n;
          if (!first) first = { id: r.dataset.row!, offset: rect.top - box.top };
        }
        if (rect.top >= box.bottom) {
          end = n;
          break;
        }
      }
      next[g] = { start: Math.min(start, end), end, atTop };
    }
    anchor.current = atTop ? undefined : first;
    setView((prev) => (prev && (Object.keys(next) as G[]).every((g) => prev[g] && sameView(prev[g], next[g])) ? prev : next));
  }, [scrollerRef, groupsKey]);

  // Measure on scroll and resize. The list may not exist yet on the first render (the Inbox shows
  // "Loading…" first), so attach whenever the element appears or changes.
  const attached = useRef<{ el: HTMLElement; off: () => void } | undefined>(undefined);
  useEffect(() => {
    const el = scrollerRef.current;
    if (attached.current?.el === el) return;
    attached.current?.off();
    attached.current = undefined;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(onScroll);
    ro.observe(el);
    attached.current = {
      el,
      off: () => {
        cancelAnimationFrame(frame);
        el.removeEventListener('scroll', onScroll);
        ro.disconnect();
      },
    };
  });
  useEffect(() => () => attached.current?.off(), []);

  // After each change of order, put the row that was first in view back where it was, then measure.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    const a = anchor.current;
    if (el && a) {
      const row = el.querySelector<HTMLElement>(`[data-row="${CSS.escape(a.id)}"]`);
      if (row) {
        const delta = row.getBoundingClientRect().top - el.getBoundingClientRect().top - a.offset;
        if (Math.abs(delta) >= 1) el.scrollTop += delta;
      }
    }
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [cur.orders, scrollerRef, measure]);

  // The rows, in order, with leaving ones where they were.
  const rows = {} as Record<G, ShownRow[]>;
  for (const g of ids) {
    const list: ShownRow[] = cur.orders![g].order.flatMap((id) => {
      const item = cur.items[id];
      return item ? [{ item }] : [];
    });
    for (const l of cur.leaving[g]) {
      const at = l.after ? list.findIndex((r) => r.item.id === l.after) + 1 : 0;
      list.splice(at, 0, { item: l.item, leaving: true });
    }
    rows[g] = list;
  }

  // Rows that landed above the view and haven't been scrolled to yet.
  const above = map(cur.above, (list, g) => {
    const v = view?.[g];
    if (!v || v.atTop) return [];
    const order = cur.orders![g].order;
    return list.filter((id) => order.indexOf(id) < v.start);
  });

  return { rows, above, pending: cur.pending, entered: cur.entered };
}

/** The groups' next orders, from the last ones on screen. */
function settleAll<G extends string>(st: State<G>, groups: Record<G, ItemSummary[]>, view: Record<G, Viewport> | undefined, opts: StableOptions, ids: G[]): State<G> {
  const reset = !st.orders || st.key !== opts.resetKey;
  const instant = reducedMotion();
  const items: Record<string, ItemSummary> = {};
  for (const g of ids) for (const i of groups[g]) items[i.id] = i;
  const entered: string[] = [];
  const orders = {} as Record<G, GroupOrder>;
  const leaving = {} as Record<G, Leaving[]>;
  const above = {} as Record<G, string[]>;
  const pending = {} as Record<G, { id: string; above: boolean }[]>;
  const exempt = (id: string) => opts.exempt.has(id);
  for (const g of ids) {
    const s = settleGroup(reset ? undefined : st.orders![g], groups[g], { frozen: opts.frozen, view: view?.[g] ?? ALL_IN_VIEW, exempt });
    pending[g] = s.pending;
    orders[g] = s.next;
    const gone = new Set(s.placed.map((p) => p.id));
    // A row that left in view collapses; one above the view goes at once, so nothing in view moves.
    leaving[g] = reset
      ? []
      : [...st.leaving[g].filter((l) => !gone.has(l.item.id) && !items[l.item.id]), ...(instant ? [] : s.left.filter((l) => !l.above && st.items[l.id]).map((l) => ({ item: st.items[l.id], after: l.after })))];
    above[g] = reset ? [] : [...st.above[g].filter((id) => s.next.order.includes(id)), ...s.placed.filter((p) => p.above).map((p) => p.id)];
    if (!reset) entered.push(...s.placed.filter((p) => p.entered).map((p) => p.id));
  }
  return {
    input: groups,
    key: opts.resetKey,
    frozen: opts.frozen,
    exempt: opts.exempt,
    view,
    orders,
    items: { ...Object.fromEntries(Object.values(st.leaving).flatMap((ls) => (ls as Leaving[]).map((l) => [l.item.id, l.item]))), ...items },
    leaving,
    above,
    pending,
    entered: entered.length ? { seq: st.entered.seq + 1, ids: entered } : st.entered,
  };
}
