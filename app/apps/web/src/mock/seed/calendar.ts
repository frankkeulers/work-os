import type { AgendaEvent } from '@work-os/shared';

// Outlook Calendar (R2.8) in the seed week, as the agenda strip shows it once the calendar is on.
// Day 5 is Mon 5 Oct; the seed clock is 09:45, so the stand-up is over and the launch check is on.

/** A London wall-clock time in the seed week (BST, UTC+1). */
const london = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, h - 1, m)).toISOString();
};
const link = (id: string) => `https://outlook.office365.com/owa/?itemid=${id}&exvsurl=1&path=/calendar/item`;
const event = (id: string, title: string, day: number, from: string, to: string, over: Partial<AgendaEvent> = {}): AgendaEvent => ({
  id,
  title,
  start: london(day, from),
  end: london(day, to),
  allDay: false,
  showAs: 'busy',
  link: link(id),
  response: 'accepted',
  ...over,
});

export const CALENDAR: AgendaEvent[] = [
  event('AAMkMOCKPRICING', 'Voyage Insights pricing workshop', 5, '06:45', '07:15', { organizer: 'Head of Sales' }),
  event('AAMkMOCKSTANDUP', 'Product stand-up', 5, '09:00', '09:15', { organizer: 'Delivery manager' }),
  event('AAMkMOCKLAUNCH', 'MVI V2 launch readiness', 5, '09:30', '10:15', { organizer: 'Release manager' }),
  event('AAMkMOCKRENEWAL', '[Customer] renewal call', 5, '14:00', '15:00', { organizer: 'Account lead, [Customer]' }),
  event('AAMkMOCKWEEKLY', 'Product weekly', 5, '16:00', '16:30', { response: 'organizer' }),
  event('AAMkMOCKKICKOFF', 'Sales kick-off', 6, '00:00', '24:00', { allDay: true, showAs: 'free', organizer: 'Head of Sales' }),
  event('AAMkMOCKQ4', 'Q4 roadmap review', 6, '10:00', '11:00', { organizer: 'Matt M.', response: 'none', showAs: 'tentative' }),
  event('AAMkMOCKAPIS', 'Insights APIs sync', 6, '15:00', '15:30', { organizer: 'Backend lead', response: 'tentativelyAccepted', showAs: 'tentative' }),
];
