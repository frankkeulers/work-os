import type { AgendaEvent } from '@work-os/shared';
import { describe, expect, it } from 'vitest';
import { dayEvents, phaseOf, wantsAnswer } from './agenda';

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
