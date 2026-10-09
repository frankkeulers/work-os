import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeJsonAtomic } from '../../store/atomic';

// state/calendar.json (R2.8): the calendar as the last poll saw it, from yesterday to two weeks
// ahead. It is the agenda, and what the next poll compares against to see what moved, was
// cancelled or was answered. It is not the event log: nothing here is history. Subjects, times,
// names and addresses and category names only: never an event's body, its Teams text or its join link.

const Person = z.object({ name: z.string().optional(), address: z.string().optional(), type: z.string().optional() });
export type SnapPerson = z.infer<typeof Person>;

export const SnapEvent = z.object({
  id: z.string().min(1),
  uri: z.string().min(1),
  /** Of the fields search gives: when it changes, the event is read again. Unset until it is read. */
  hash: z.string().optional(),
  subject: z.string(),
  organizer: Person.optional(),
  /** Who is invited, with names once the event has been read; addresses only before. */
  attendees: z.array(Person),
  start: z.string(), // UTC ISO
  end: z.string(),
  allDay: z.boolean(),
  cancelled: z.boolean(),
  isOrganizer: z.boolean(),
  showAs: z.string().optional(),
  link: z.string().optional(),
  /** Frank's answer, from his own attendee entry; unset until read, "notListed" when he isn't one. */
  response: z.string().optional(),
  created: z.string().optional(),
  /** Outlook category names, from search (R2.8). */
  categories: z.array(z.string()).optional(),
});
export type SnapEvent = z.infer<typeof SnapEvent>;

/** An open invite item and the events in it that still want an answer. */
export const InviteGroup = z.object({ itemId: z.string().min(1), eventIds: z.array(z.string().min(1)).min(1) });
export type InviteGroup = z.infer<typeof InviteGroup>;

export const CalendarSnapshot = z.object({
  schemaVersion: z.literal(1),
  polledAt: z.string(),
  from: z.string(),
  to: z.string(),
  events: z.array(SnapEvent),
  invites: z.array(InviteGroup),
});
export type CalendarSnapshot = z.infer<typeof CalendarSnapshot>;

export class CalendarStore {
  private current?: CalendarSnapshot;
  private listeners: ((s: CalendarSnapshot) => void | Promise<void>)[] = [];

  private constructor(private readonly file?: string) {}

  /** Reads the file; a missing or unreadable one starts afresh (the next poll only adds invites). */
  static async open(file: string): Promise<CalendarStore> {
    const s = new CalendarStore(file);
    try {
      const parsed = CalendarSnapshot.safeParse(JSON.parse(await readFile(file, 'utf8')));
      if (parsed.success) s.current = parsed.data;
    } catch {
      // Missing or torn.
    }
    return s;
  }

  /** In memory only, for tests and the fakes. */
  static memory(initial?: CalendarSnapshot): CalendarStore {
    const s = new CalendarStore();
    s.current = initial;
    return s;
  }

  get snapshot(): CalendarSnapshot | undefined {
    return this.current;
  }

  /** Saves a poll's picture; called only once the poll's items and cursor are saved. */
  async publish(next: CalendarSnapshot) {
    if (this.file) await writeJsonAtomic(this.file, next);
    this.current = next;
    for (const fn of this.listeners) await fn(next);
  }

  /** Runs after each published snapshot, e.g. to join Wispr Flow meetings to it. */
  onPublish(fn: (s: CalendarSnapshot) => void | Promise<void>) {
    this.listeners.push(fn);
  }
}
