import type { AgendaEvent } from '@work-os/shared';
import { describe, expect, it } from 'vitest';
import { dayEvents, nextUp, phaseOf, wantsAnswer } from './agenda';

// Thursday 8 October 2026, 13:00 in London (BST).
const NOW = new Date('2026-10-08T12:00:00.000Z');
const ev = (id: string, start: string, end: string, over: Partial<AgendaEvent> = {}): AgendaEvent => ({ id, title: id, start, end, allDay: false, ...over });

const events = [
  ev('Lunch', '2026-10-08T11:00:00.000Z', '2026-10-08T12:30:00.000Z'),
  ev('Stand-up', '2026-10-08T08:00:00.000Z', '2026-10-08T08:15:00.000Z'),
  ev('Away', '2026-10-07T23:00:00.000Z', '2026-10-08T23:00:00.000Z', { allDay: true }),
  ev('Review', '2026-10-09T13:00:00.000Z', '2026-10-09T14:00:00.000Z', { response: 'none' }),
  ev('Late', '2026-10-08T22:30:00.000Z', '2026-10-08T23:30:00.000Z'), // 23:30 London, into tomorrow
];

describe('the agenda', () => {
  it('lists a day’s meetings in London time, all-day ones first', () => {
    expect(dayEvents(events, NOW, 'today').map((e) => e.id)).toEqual(['Away', 'Stand-up', 'Lunch', 'Late']);
    expect(dayEvents(events, NOW, 'tomorrow').map((e) => e.id)).toEqual(['Late', 'Review']);
  });

  it('knows what is over, what is on now, and what is to come', () => {
    expect(events.map((e) => phaseOf(e, NOW))).toEqual(['now', 'past', 'later', 'later', 'later']);
  });

  it('wants an answer only for an unanswered invite', () => {
    expect(events.filter(wantsAnswer).map((e) => e.id)).toEqual(['Review']);
    expect(wantsAnswer(ev('x', '', '', { response: 'organizer' }))).toBe(false);
  });
});

describe('the next meeting (R2.8)', () => {
  const at = (mins: number) => new Date(NOW.getTime() + mins * 60_000).toISOString();
  const meeting = (id: string, mins: number, over: Partial<AgendaEvent> = {}) => ev(id, at(mins), at(mins + 30), { response: 'accepted', ...over });

  it('is a meeting from five minutes before it starts until it starts', () => {
    expect(nextUp([meeting('a', 5)], NOW, 5)).toMatchObject({ event: { id: 'a' }, minutes: 5, more: 0, imminent: false });
    expect(nextUp([meeting('a', 5.02)], NOW, 5)).toBeUndefined();
    expect(nextUp([meeting('a', 0)], NOW, 5)).toBeUndefined(); // started: the agenda says Now
    expect(nextUp([meeting('a', 9)], NOW, 10)?.minutes).toBe(9); // a longer lead from Settings
  });

  it('turns amber at two minutes, the countdown rounded up as fmtIn shows it', () => {
    expect(nextUp([meeting('a', 2.5)], NOW, 5)).toMatchObject({ minutes: 3, imminent: false });
    expect(nextUp([meeting('a', 2)], NOW, 5)).toMatchObject({ minutes: 2, imminent: true });
  });

  it('only for meetings Frank is going to: accepted, tentative or his own; timed and not Free', () => {
    const going = ['accepted', 'tentativelyAccepted', 'organizer'].map((r) => meeting(r, 3, { response: r }));
    expect(going.map((e) => nextUp([e], NOW, 5)?.event.id)).toEqual(['accepted', 'tentativelyAccepted', 'organizer']);
    for (const over of [{ response: 'none' }, { response: 'notResponded' }, { response: 'declined' }, { response: undefined }, { showAs: 'free' }, { allDay: true }]) expect(nextUp([meeting('x', 3, over)], NOW, 5)).toBeUndefined();
  });

  it('takes the soonest, and counts others starting at the same time', () => {
    expect(nextUp([meeting('later', 4), meeting('soonest', 2), meeting('also', 2), meeting('declined', 2, { response: 'declined' })], NOW, 5)).toMatchObject({ event: { id: 'soonest' }, more: 1 });
  });
});
