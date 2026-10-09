import { describe, expect, it } from 'vitest';
import { ALL_IN_VIEW, settleGroup, type GroupOrder } from './stableOrder';

const rows = (spec: string) => spec.split(' ').map((s) => ({ id: s.slice(0, -2), lane: s.endsWith(':n') ? 'now' : 'today' }));
const shown = (spec: string): GroupOrder => {
  const r = rows(spec);
  return { order: r.map((i) => i.id), lanes: Object.fromEntries(r.map((i) => [i.id, i.lane])) };
};
const open = { frozen: false, view: ALL_IN_VIEW };

describe('settleGroup (CK-1.2)', () => {
  it('shows the sorted order on first sight', () => {
    const s = settleGroup(undefined, rows('a:n b:t c:t'), open);
    expect(s.next.order).toEqual(['a', 'b', 'c']);
    expect(s.placed).toEqual([]);
  });

  it('never moves a row whose item only updated, even when its sort position changed', () => {
    const s = settleGroup(shown('a:n b:t c:t'), rows('a:n c:t b:t'), open);
    expect(s.next.order).toEqual(['a', 'b', 'c']);
    expect(s.placed).toEqual([]);
  });

  it('puts a new item in at its sorted position, after its nearest neighbour already on screen', () => {
    const s = settleGroup(shown('a:n b:t c:t'), rows('a:n x:n c:t b:t'), open);
    expect(s.next.order).toEqual(['a', 'x', 'b', 'c']);
    expect(s.placed).toEqual([{ id: 'x', index: 1, above: false, entered: true }]);
  });

  it('moves an item whose lane changed, and doesn’t mark it as new to the group', () => {
    const s = settleGroup(shown('a:n b:t c:t'), rows('c:n a:n b:t'), open);
    expect(s.next.order).toEqual(['c', 'a', 'b']);
    expect(s.placed).toEqual([{ id: 'c', index: 0, above: false, entered: false }]);
    expect(s.next.lanes.c).toBe('now');
  });

  it('drops an item that left, remembering the row before it', () => {
    const s = settleGroup(shown('a:n b:t c:t'), rows('a:n c:t'), open);
    expect(s.next.order).toEqual(['a', 'c']);
    expect(s.left).toEqual([{ id: 'b', after: 'a', above: false }]);
  });

  it('flags a row placed above the rows in view, once scrolled down', () => {
    const view = { start: 2, end: 5, atTop: false };
    const s = settleGroup(shown('a:n b:t c:t d:t e:t'), rows('x:n a:n b:t c:t d:t e:t'), { frozen: false, view });
    expect(s.placed).toEqual([{ id: 'x', index: 0, above: true, entered: true }]);
    // Below the view it's no news.
    const t = settleGroup(shown('a:n b:t c:t d:t e:t'), rows('a:n b:t c:t d:t e:t z:t'), { frozen: false, view });
    expect(t.placed[0]).toMatchObject({ id: 'z', above: false });
  });

  it('at the top of the list, a new first row is seen arriving rather than flagged', () => {
    const s = settleGroup(shown('a:n b:t'), rows('x:n a:n b:t'), { frozen: false, view: { start: 0, end: 2, atTop: true } });
    expect(s.placed[0]).toMatchObject({ id: 'x', index: 0, above: false });
  });

  it('while the panel is open, holds anything that would land in or above the view', () => {
    const view = { start: 0, end: 3, atTop: true };
    const prev = shown('a:n b:t c:t d:t e:t');
    const s = settleGroup(prev, rows('x:n a:n b:t c:t d:t e:t z:t'), { frozen: true, view });
    expect(s.next.order).toEqual(['a', 'b', 'c', 'd', 'e', 'z']); // z lands below the view
    expect(s.pending).toEqual([{ id: 'x', above: false }]);
    // The panel closes: x lands at its place.
    const t = settleGroup(s.next, rows('x:n a:n b:t c:t d:t e:t z:t'), { frozen: false, view });
    expect(t.next.order).toEqual(['x', 'a', 'b', 'c', 'd', 'e', 'z']);
    expect(t.placed).toEqual([{ id: 'x', index: 0, above: false, entered: true }]);
  });

  it('while the panel is open, a row whose lane changed stays put, then moves once it closes', () => {
    const prev = shown('a:n b:t c:t');
    const s = settleGroup(prev, rows('c:n a:n b:t'), { frozen: true, view: ALL_IN_VIEW });
    expect(s.next.order).toEqual(['a', 'b', 'c']);
    expect(s.next.lanes.c).toBe('today'); // still placed as Today
    const t = settleGroup(s.next, rows('c:n a:n b:t'), open);
    expect(t.next.order).toEqual(['c', 'a', 'b']);
  });

  it('while the panel is open, lands at once what Frank moved himself (Undo, a correction)', () => {
    const prev = shown('a:n b:t c:t');
    const exempt = (id: string) => id === 'x' || id === 'c';
    const s = settleGroup(prev, rows('x:n c:n a:n b:t'), { frozen: true, view: ALL_IN_VIEW, exempt });
    expect(s.next.order).toEqual(['x', 'c', 'a', 'b']);
    expect(s.pending).toEqual([]);
  });

  it('says whether a held row would land above the view', () => {
    const s = settleGroup(shown('a:n b:t c:t d:t'), rows('x:n a:n b:t c:t d:t'), { frozen: true, view: { start: 2, end: 4, atTop: false } });
    expect(s.pending).toEqual([{ id: 'x', above: true }]);
  });

  it('counts rows that left above the view when deciding what is above', () => {
    // b (index 1) leaves from above the view starting at d (index 3); x goes in before c.
    const view = { start: 3, end: 5, atTop: false };
    const s = settleGroup(shown('a:n b:t c:t d:t e:t'), rows('a:n x:t c:t d:t e:t'), { frozen: false, view });
    expect(s.left).toEqual([{ id: 'b', after: 'a', above: true }]);
    expect(s.placed).toEqual([{ id: 'x', index: 1, above: true, entered: true }]);
  });

  it('places several new items in sorted order, keeping their indexes current', () => {
    const s = settleGroup(shown('b:t d:t'), rows('a:n b:t c:t d:t e:t'), open);
    expect(s.next.order).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(Object.fromEntries(s.placed.map((p) => [p.id, p.index]))).toEqual({ a: 0, c: 2, e: 4 });
  });
});
