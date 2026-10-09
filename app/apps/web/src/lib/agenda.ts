import { londonAt, type AgendaEvent } from '@work-os/shared';

// The agenda strip on the inbox (R2.8): today's or tomorrow's meetings from Outlook Calendar, all-day
// ones first, then by start; where each one is against the clock; and whether it wants an answer.

export type AgendaDay = 'today' | 'tomorrow';

/** The day's meetings: those overlapping it, all-day ones first, then by start. */
export function dayEvents(events: readonly AgendaEvent[], now: Date, day: AgendaDay): AgendaEvent[] {
  const from = londonAt(now, '00:00', day === 'today' ? 0 : 1);
  const to = londonAt(now, '00:00', day === 'today' ? 1 : 2);
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

/** Meetings that show as next before they start: timed, not Free, and accepted, tentative or Frank's own. */
const GOING = new Set(['accepted', 'tentativelyAccepted', 'organizer']);
export const headsUp = (e: AgendaEvent) => !e.allDay && e.showAs !== 'free' && GOING.has(e.response ?? '');

/** At this many minutes or fewer, the countdown turns amber. */
export const IMMINENT_MINUTES = 2;

export interface NextUp {
  event: AgendaEvent;
  /** Others that start at the same time. */
  more: number;
  /** Whole minutes to go, rounded up, as fmtIn shows them. */
  minutes: number;
  imminent: boolean;
}

/** The next meeting, once it is within `leadMinutes` of its start and until it starts (R2.8). */
export function nextUp(events: readonly AgendaEvent[], now: Date, leadMinutes: number): NextUp | undefined {
  const t = now.getTime();
  const soon = events.filter((e) => headsUp(e) && Date.parse(e.start) > t && Date.parse(e.start) - t <= leadMinutes * 60_000).sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const [event] = soon;
  if (!event) return undefined;
  const minutes = Math.ceil((Date.parse(event.start) - t) / 60_000);
  return { event, more: soon.filter((e) => e !== event && e.start === event.start).length, minutes, imminent: minutes <= IMMINENT_MINUTES };
}
