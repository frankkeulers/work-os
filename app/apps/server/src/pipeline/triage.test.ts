import { describe, expect, it } from 'vitest';
import type { SnapEvent } from '../sources/calendar/store';
import { meetingsToday, renderBatch } from './triage';

// Fri 9 Oct 2026, 13:48 London (BST).
const now = new Date('2026-10-09T12:48:00.000Z');
const ev = (subject: string, start: string, over: Partial<SnapEvent> = {}): SnapEvent => ({
  id: subject,
  uri: `u:${subject}`,
  subject,
  attendees: [],
  start,
  end: start,
  allDay: false,
  cancelled: false,
  isOrganizer: false,
  ...over,
});

describe('meetingsToday (cockpit CK-3.9)', () => {
  it('lists today’s timed meetings in order, by title and start only', () => {
    const events = [
      ev('Renewal call', '2026-10-09T13:00:00Z'),
      ev('Exec sync', '2026-10-09T08:00:00Z', { attendees: [{ name: 'Matt M.' }], organizer: { name: 'Matt M.' } }),
      ev('Tomorrow', '2026-10-10T08:00:00Z'),
      ev('Last night', '2026-10-08T22:30:00Z'), // 23:30 Thursday in London
      ev('Just after midnight', '2026-10-08T23:10:00Z'), // 00:10 Friday in London
      ev('Cancelled', '2026-10-09T09:00:00Z', { cancelled: true }),
      ev('Declined', '2026-10-09T09:00:00Z', { response: 'declined' }),
      ev('Holiday', '2026-10-09T00:00:00Z', { allDay: true }),
      ev('Focus time', '2026-10-09T10:00:00Z', { showAs: 'free' }),
      ev('', '2026-10-09T15:00:00Z'),
    ];
    expect(meetingsToday(events, now)).toEqual([
      { title: 'Just after midnight', start: '2026-10-08T23:10:00Z' },
      { title: 'Exec sync', start: '2026-10-09T08:00:00Z' },
      { title: 'Renewal call', start: '2026-10-09T13:00:00Z' },
      { title: '(no title)', start: '2026-10-09T15:00:00Z' },
    ]);
  });
});

describe('renderBatch', () => {
  it('gives the time in London, and today’s meetings when there are any', () => {
    const text = renderBatch([], now, [{ title: 'Exec sync', start: '2026-10-09T13:00:00Z' }]);
    expect(text.split('\n').slice(0, 4)).toEqual([
      'Now: 2026-10-09T12:48:00.000Z (Fri 13:48 in London)',
      '<calendar>',
      '[{"title":"Exec sync","start":"2026-10-09T13:00:00Z","london":"14:00"}]',
      '</calendar>',
    ]);
    expect(renderBatch([], now)).not.toContain('<calendar>');
  });
});
