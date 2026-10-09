import type { Item, ItemMeeting } from '@work-os/shared';
import type { Logger } from '../log';
import { bestEvent } from '../sources/calendar/match';
import { peopleOf } from '../sources/calendar/normalise';
import type { CalendarSnapshot, SnapEvent } from '../sources/calendar/store';
import type { MeInfo } from '../sources/outlook/normalise';
import { ME_ID as WISPR_ME } from '../sources/wispr/normalise';
import type { ItemFiles } from '../store/items';
import type { Store } from '../store/store';

// Wispr Flow meetings joined to the calendar (R2.8): the event's title, organiser and invitees go on
// the meeting's item, for triage and the item panel. A meeting is joined when Wispr's poll reads it,
// and, when the calendar didn't have it yet then, after the next calendar poll. That later join
// changes the item file only: no new revision, so the meeting isn't triaged again for it.

/** The calendar side of a meeting, as the item keeps it. */
export function calendarOf(e: SnapEvent, me: MeInfo): NonNullable<ItemMeeting['calendar']> {
  const { organizer, required, optional } = peopleOf(e, me);
  return { eventId: e.id, title: e.subject || '(no title)', ...(organizer && { organizer }), invitees: [...required, ...optional], ...(e.link && /^https:\/\//.test(e.link) && { link: e.link }), ...(e.categories && { categories: e.categories }) };
}

/** The meeting with its calendar event, when the calendar clearly has it; otherwise as it was. */
export function withCalendar(item: Item, snap: CalendarSnapshot, me: MeInfo): Item {
  if (item.source !== 'wispr' || !item.meeting || item.meeting.calendar) return item;
  const people = item.participants.filter((p) => p.id !== WISPR_ME).map((p) => p.name);
  const e = bestEvent({ title: item.title, start: item.meeting.start, end: item.meeting.end, people }, snap.events);
  return e ? { ...item, meeting: { ...item.meeting, calendar: calendarOf(e, me) } } : item;
}

/**
 * After a calendar poll: joins the stored Wispr meetings from the snapshot's window that have no
 * event yet. Returns how many were joined.
 */
export async function relinkMeetings(d: { store: Store; items: ItemFiles; logger?: Logger }, snap: CalendarSnapshot, me: MeInfo): Promise<number> {
  let joined = 0;
  for (const it of Object.values(d.store.projection.items)) {
    if (it.source !== 'wispr' || it.lastActivityAt < snap.from) continue;
    const done = await d.items.update(it.source, it.id, (stored) => {
      if (!stored?.item.meeting || stored.item.meeting.calendar) return undefined;
      const item = withCalendar(stored.item, snap, me);
      return item === stored.item ? undefined : { ...stored, item };
    });
    if (done) joined++;
  }
  if (joined) d.logger?.info({ joined }, 'Wispr Flow meetings joined to the calendar');
  return joined;
}
