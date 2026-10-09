import type { AgendaEvent } from '@work-os/shared';
import { describe, expect, it } from 'vitest';
import { dayEvents, meetingCues, phaseOf, wantsAnswer } from './agenda';

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

describe('meetings now and next (R2.8)', () => {
  const at = (mins: number) => new Date(NOW.getTime() + mins * 60_000).toISOString();
  const meeting = (id: string, mins: number, over: Partial<AgendaEvent> = {}, length = 30) => ev(id, at(mins), at(mins + length), { response: 'accepted', ...over });
  const cues = (es: AgendaEvent[], lead = 5) => meetingCues(es, NOW, lead).map((c) => [c.event.id, c.phase]);

  it('is next from five minutes before a meeting starts until it starts', () => {
    expect(meetingCues([meeting('a', 5)], NOW, 5)).toMatchObject([{ event: { id: 'a' }, phase: 'next', minutes: 5, imminent: false }]);
    expect(meetingCues([meeting('a', 5.02)], NOW, 5)).toEqual([]);
    expect(meetingCues([meeting('a', 9)], NOW, 10)[0]?.minutes).toBe(9); // a longer lead from Settings
  });

  it('is now from its start for the whole meeting, and gone once it ends', () => {
    expect(cues([meeting('a', 0)])).toEqual([['a', 'now']]);
    expect(cues([meeting('a', -29)])).toEqual([['a', 'now']]);
    expect(cues([meeting('a', -90, {}, 120)])).toEqual([['a', 'now']]); // a long one, to its end
    expect(cues([meeting('a', -30)])).toEqual([]); // ended this minute
  });

  it('turns amber at two minutes, the countdown rounded up as fmtIn shows it', () => {
    expect(meetingCues([meeting('a', 2.5)], NOW, 5)[0]).toMatchObject({ minutes: 3, imminent: false });
    expect(meetingCues([meeting('a', 2)], NOW, 5)[0]).toMatchObject({ minutes: 2, imminent: true });
  });

  it('only for meetings Frank is going to: accepted, tentative or his own; timed and not Free', () => {
    const going = ['accepted', 'tentativelyAccepted', 'organizer'].map((r) => meeting(r, 3, { response: r }));
    expect(going.map((e) => cues([e])[0]?.[0])).toEqual(['accepted', 'tentativelyAccepted', 'organizer']);
    for (const over of [{ response: 'none' }, { response: 'notResponded' }, { response: 'declined' }, { response: undefined }, { showAs: 'free' }, { allDay: true }]) {
      expect(cues([meeting('x', 3, over)])).toEqual([]);
      expect(cues([meeting('x', -10, over)])).toEqual([]);
    }
  });

  it('shows overlapping meetings each on their own: those on now first, then those to come, each soonest first', () => {
    const es = [meeting('later', 4), meeting('long', -60, {}, 120), meeting('soonest', 2), meeting('also', 2), meeting('declined', 2, { response: 'declined' }), meeting('short', -10, {}, 15), meeting('over', -40)];
    expect(cues(es)).toEqual([
      ['long', 'now'],
      ['short', 'now'],
      ['also', 'next'],
      ['soonest', 'next'],
      ['later', 'next'],
    ]);
  });
});
