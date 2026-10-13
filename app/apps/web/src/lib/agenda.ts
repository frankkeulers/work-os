import { londonAt, type AgendaEvent } from '@work-os/shared';

// The agenda strip on the inbox (R2.8): today's or tomorrow's meetings from Outlook Calendar, all-day
// ones first, then by start; where each one is against the clock; and whether it wants an answer.

export type AgendaDay = 'today' | 'tomorrow';

/** A day as days from today: 0 today, 1 tomorrow, -1 yesterday. The time column steps through any (CK-3.4). */
export const dayOffset = (day: AgendaDay | number) => (typeof day === 'number' ? day : day === 'today' ? 0 : 1);

/** The day's meetings: those overlapping it, all-day ones first, then by start. */
export function dayEvents(events: readonly AgendaEvent[], now: Date, day: AgendaDay | number): AgendaEvent[] {
  const from = londonAt(now, '00:00', dayOffset(day));
  const to = londonAt(now, '00:00', dayOffset(day) + 1);
  return events.filter((e) => e.end > from && e.start < to).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
}

/** Where a meeting is against the clock. An all-day one is never "now": it would always be. */
export function phaseOf(e: AgendaEvent, now: Date): 'past' | 'now' | 'later' {
  const t = now.toISOString();
  if (e.end <= t) return 'past';
  return !e.allDay && e.start <= t ? 'now' : 'later';
}

/** Someone else's meeting Frank hasn't answered. */
export const wantsAnswer = (e: AgendaEvent) => e.response === 'none' || e.response === 'notResponded';

/** Meetings the sidebar and agenda count down to and show while on: timed, not Free, and accepted, tentative or Frank's own. */
const GOING = new Set(['accepted', 'tentativelyAccepted', 'organizer']);
export const headsUp = (e: AgendaEvent) => !e.allDay && e.showAs !== 'free' && GOING.has(e.response ?? '');

/** At this many minutes or fewer, the countdown turns amber. */
export const IMMINENT_MINUTES = 2;

export interface MeetingCue {
  event: AgendaEvent;
  /** On now, or starting within the lead time. */
  phase: 'now' | 'next';
  /** For one about to start: whole minutes to go, rounded up, as fmtIn shows them. */
  minutes: number;
  /** About to start, within IMMINENT_MINUTES. */
  imminent: boolean;
}

const byTime = (a: AgendaEvent, b: AgendaEvent) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.id.localeCompare(b.id);

/**
 * The meetings Frank is going to that are on now, for as long as they last, then those starting
 * within `leadMinutes`, each soonest first (R2.8). Overlapping meetings are each one cue.
 */
export function meetingCues(events: readonly AgendaEvent[], now: Date, leadMinutes: number): MeetingCue[] {
  const t = now.getTime();
  const going = events.filter(headsUp).sort(byTime);
  const on = going.filter((e) => Date.parse(e.start) <= t && t < Date.parse(e.end));
  const soon = going.filter((e) => Date.parse(e.start) > t && Date.parse(e.start) - t <= leadMinutes * 60_000);
  return [
    ...on.map((event) => ({ event, phase: 'now' as const, minutes: 0, imminent: false })),
    ...soon.map((event) => {
      const minutes = Math.ceil((Date.parse(event.start) - t) / 60_000);
      return { event, phase: 'next' as const, minutes, imminent: minutes <= IMMINENT_MINUTES };
    }),
  ];
}
