import { describe, expect, it } from 'vitest';
import { isBusy, planSlots, slotMinutes, workWindows, type BusyEvent, type SlotTodo } from './slots';

// Mon 12 Oct 2026, London on BST (UTC+1) until Sun 25 Oct.
const HOURS = 'Mon–Fri 08:00–18:30';
const NOW = new Date('2026-10-12T08:02:00.000Z'); // 09:02 London
const todo = (id: string, extra: Partial<SlotTodo> = {}): SlotTodo => ({ id, createdAt: '2026-10-12T07:00:00.000Z', ...extra });
const meet = (start: string, end: string, extra: Partial<BusyEvent> = {}): BusyEvent => ({ start, end, ...extra });
const plan = (todos: SlotTodo[], events: BusyEvent[] = [], extra: Partial<Parameters<typeof planSlots>[0]> = {}) => planSlots({ now: NOW, workHours: HOURS, events, todos, ...extra });
const at = (start: string, end: string, by: 'plan' | 'you' = 'plan') => ({ kind: 'slot', start, end, by });

describe('free time for To Dos (FR-16.8)', () => {
  it('counts a meeting as busy unless it is cancelled, declined, free or elsewhere; a whole day only when out of office', () => {
    const cases: [Partial<BusyEvent>, boolean][] = [
      [{}, true],
      [{ showAs: 'tentative' }, true],
      [{ showAs: 'busy' }, true],
      [{ showAs: 'free' }, false],
      [{ showAs: 'workingElsewhere' }, false],
      [{ response: 'declined' }, false],
      [{ cancelled: true }, false],
      [{ allDay: true, showAs: 'busy' }, false],
      [{ allDay: true, showAs: 'oof' }, true],
    ];
    for (const [e, busy] of cases) expect(isBusy(meet('a', 'b', e)), JSON.stringify(e)).toBe(busy);
  });

  it('rounds a length up to quarter hours, 30 minutes when there is no estimate', () => {
    expect([slotMinutes(), slotMinutes(5), slotMinutes(15), slotMinutes(20), slotMinutes(61)]).toEqual([30, 15, 15, 30, 75]);
  });

  it('works in working hours only, skipping the weekend, across the clock change', () => {
    const from = Date.parse('2026-10-23T00:00:00.000Z');
    const to = Date.parse('2026-10-27T00:00:00.000Z');
    const days = workWindows(HOURS, from, to).map(([a, b]) => [new Date(a).toISOString(), new Date(b).toISOString()]);
    expect(days).toEqual([
      ['2026-10-23T07:00:00.000Z', '2026-10-23T17:30:00.000Z'], // Fri, BST
      ['2026-10-26T08:00:00.000Z', '2026-10-26T18:30:00.000Z'], // Mon, GMT
    ]);
  });

  it('takes the next quarter hour at least five minutes ahead', () => {
    expect(plan([todo('a')]).a).toEqual(at('2026-10-12T08:15:00.000Z', '2026-10-12T08:45:00.000Z'));
  });

  it('keeps the buffer clear either side of a meeting, tentative ones too', () => {
    const r = plan([todo('a', { effortMinutes: 60 })], [meet('2026-10-12T08:00:00.000Z', '2026-10-12T09:00:00.000Z', { showAs: 'tentative' }), meet('2026-10-12T10:00:00.000Z', '2026-10-12T11:00:00.000Z')]);
    // 09:10–09:50 free is too short for an hour; next is after 11:10 → 11:15.
    expect(r.a).toEqual(at('2026-10-12T11:15:00.000Z', '2026-10-12T12:15:00.000Z'));
    const tight = plan([todo('a', { effortMinutes: 30 })], [meet('2026-10-12T08:00:00.000Z', '2026-10-12T09:00:00.000Z'), meet('2026-10-12T09:45:00.000Z', '2026-10-12T10:00:00.000Z')], { bufferMinutes: 0 });
    expect(tight.a).toEqual(at('2026-10-12T09:00:00.000Z', '2026-10-12T09:30:00.000Z'));
  });

  it('ignores free, declined and cancelled meetings, and a whole day only blocks when out of office', () => {
    const ignored = [
      meet('2026-10-12T08:00:00.000Z', '2026-10-12T17:00:00.000Z', { showAs: 'free' }),
      meet('2026-10-12T08:00:00.000Z', '2026-10-12T17:00:00.000Z', { response: 'declined' }),
      meet('2026-10-12T08:00:00.000Z', '2026-10-12T17:00:00.000Z', { cancelled: true }),
      meet('2026-10-11T23:00:00.000Z', '2026-10-12T23:00:00.000Z', { allDay: true }),
    ];
    expect(plan([todo('a')], ignored).a).toEqual(at('2026-10-12T08:15:00.000Z', '2026-10-12T08:45:00.000Z'));
    const away = meet('2026-10-11T23:00:00.000Z', '2026-10-12T23:00:00.000Z', { allDay: true, showAs: 'oof' });
    expect(plan([todo('a')], [away], { bufferMinutes: 0 }).a).toEqual(at('2026-10-13T07:00:00.000Z', '2026-10-13T07:30:00.000Z'));
  });

  it('places the soonest due first, by ideal date else deadline, and those without one last', () => {
    const r = plan(
      [
        todo('none', { createdAt: '2026-10-12T06:00:00.000Z' }),
        todo('late', { deadline: '2026-10-16T16:00:00.000Z' }),
        todo('soon', { ideal: '2026-10-13T12:00:00.000Z', deadline: '2026-10-20T16:00:00.000Z', createdAt: '2026-10-12T07:30:00.000Z' }),
      ],
      [],
      { bufferMinutes: 0 },
    );
    expect(r.soon).toEqual(at('2026-10-12T08:15:00.000Z', '2026-10-12T08:45:00.000Z'));
    expect(r.late).toEqual(at('2026-10-12T08:45:00.000Z', '2026-10-12T09:15:00.000Z'));
    expect(r.none).toEqual(at('2026-10-12T09:15:00.000Z', '2026-10-12T09:45:00.000Z'));
  });

  it('falls back from the ideal date to the deadline when nothing fits before it', () => {
    const r = plan([todo('a', { ideal: '2026-10-12T08:30:00.000Z', deadline: '2026-10-13T16:00:00.000Z' })], [], { bufferMinutes: 0 });
    expect(r.a).toEqual(at('2026-10-12T08:15:00.000Z', '2026-10-12T08:45:00.000Z'));
  });

  it('has no slot before a deadline it cannot meet, and says when it would first fit', () => {
    const r = plan([todo('a', { effortMinutes: 60, deadline: '2026-10-12T09:00:00.000Z' })], [], { bufferMinutes: 0 });
    expect(r.a).toEqual({ kind: 'none', reason: 'no_fit_before_deadline', firstAfter: { start: '2026-10-12T08:15:00.000Z', end: '2026-10-12T09:15:00.000Z' } });
  });

  it('never splits a To Do longer than a working day', () => {
    expect(plan([todo('a', { effortMinutes: 660 })]).a).toEqual({ kind: 'none', reason: 'too_long' });
  });

  it('has nothing to plan around without the calendar, but still shows Frank’s own slots', () => {
    const mine = { start: '2026-10-12T13:00:00.000Z', end: '2026-10-12T13:30:00.000Z', by: 'you' as const };
    const r = planSlots({ now: NOW, workHours: HOURS, todos: [todo('a'), todo('b', { slot: mine })] });
    expect(r.a).toEqual({ kind: 'none', reason: 'no_calendar' });
    expect(r.b).toEqual(at(mine.start, mine.end, 'you'));
  });

  it('has no free time past the end of the calendar it knows', () => {
    const r = plan([todo('a', { effortMinutes: 60 })], [meet('2026-10-12T08:00:00.000Z', '2026-10-12T17:30:00.000Z')], { calendarTo: '2026-10-13T00:00:00.000Z' });
    expect(r.a).toEqual({ kind: 'none', reason: 'no_free_time' });
  });

  it('never moves Frank’s own slot: it marks a clash or a slot gone by, and others plan around it', () => {
    const mine = { start: '2026-10-12T08:15:00.000Z', end: '2026-10-12T08:45:00.000Z', by: 'you' as const };
    const gone = { start: '2026-10-12T06:00:00.000Z', end: '2026-10-12T06:30:00.000Z', by: 'you' as const };
    const r = plan([todo('mine', { slot: mine }), todo('gone', { slot: gone }), todo('a')], [meet('2026-10-12T08:30:00.000Z', '2026-10-12T08:40:00.000Z')], { bufferMinutes: 0 });
    expect(r.mine).toEqual({ ...at(mine.start, mine.end, 'you'), clash: true });
    expect(r.gone).toEqual({ ...at(gone.start, gone.end, 'you'), passed: true });
    expect(r.a).toEqual(at('2026-10-12T08:45:00.000Z', '2026-10-12T09:15:00.000Z'));
  });

  it('keeps planned slots that still fit, so a new meeting moves only the slot it hits', () => {
    const todos = [todo('a'), todo('b'), todo('c')];
    const first = plan(todos, [], { bufferMinutes: 0 });
    const slotted = todos.map((t) => {
      const s = first[t.id];
      return s.kind === 'slot' ? { ...t, slot: { start: s.start, end: s.end, by: s.by } } : t;
    });
    const again = plan(slotted, [meet('2026-10-12T08:45:00.000Z', '2026-10-12T09:15:00.000Z')], { bufferMinutes: 0 });
    expect(again.a).toEqual(first.a);
    expect(again.c).toEqual(first.c);
    expect(again.b).toEqual(at('2026-10-12T09:45:00.000Z', '2026-10-12T10:15:00.000Z'));
  });

  it('places again a planned slot gone by, one past its deadline, or one whose length changed', () => {
    const r = plan(
      [
        todo('gone', { slot: { start: '2026-10-12T07:00:00.000Z', end: '2026-10-12T07:30:00.000Z', by: 'plan' } }),
        todo('late', { deadline: '2026-10-12T12:00:00.000Z', slot: { start: '2026-10-12T13:00:00.000Z', end: '2026-10-12T13:30:00.000Z', by: 'plan' } }),
        todo('longer', { effortMinutes: 60, slot: { start: '2026-10-12T15:00:00.000Z', end: '2026-10-12T15:30:00.000Z', by: 'plan' } }),
      ],
      [],
      { bufferMinutes: 0 },
    );
    expect(r.late).toEqual(at('2026-10-12T08:15:00.000Z', '2026-10-12T08:45:00.000Z'));
    expect(r.gone).toEqual(at('2026-10-12T08:45:00.000Z', '2026-10-12T09:15:00.000Z'));
    expect(r.longer).toEqual(at('2026-10-12T09:15:00.000Z', '2026-10-12T10:15:00.000Z'));
  });

  it('after hours on a Friday, plans Monday morning, after the clock change', () => {
    const r = planSlots({ now: new Date('2026-10-23T17:20:00.000Z'), workHours: HOURS, events: [], todos: [todo('a')] });
    expect(r.a).toEqual(at('2026-10-26T08:00:00.000Z', '2026-10-26T08:30:00.000Z'));
  });

  it('places the same way every time', () => {
    const todos = [todo('b'), todo('a'), todo('c', { deadline: '2026-10-14T12:00:00.000Z' })];
    expect(plan(todos)).toEqual(plan([...todos].reverse()));
  });
});
