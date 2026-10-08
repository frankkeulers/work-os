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
