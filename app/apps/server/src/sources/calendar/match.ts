import type { SnapEvent } from './store';

// Which calendar event a Wispr Flow meeting was (R2.8). Wispr knows when the recording ran, its own
// title for it and who spoke; the calendar knows when the meeting was booked, its subject and who was
// invited. Each event that overlaps the recording is scored on the three, time weighing most, and
// the best is taken only when it is clearly the best: a double-booked hour links nothing.

export const MIN_SCORE = 0.5;
export const MIN_MARGIN = 0.1;
const WEIGHTS = { time: 0.6, title: 0.25, people: 0.15 };
/** Meetings start late and run over: an event counts as this much longer each side. */
const SLACK_MS = 10 * 60_000;

export interface MeetingFacts {
  title: string;
  start: string;
  end: string;
  /** Who was in it, by name, Frank left out. */
  people: string[];
}

const STOP = new Set(['the', 'and', 'for', 'with', 'of', 'to', 'on', 'in', 're', 'fw', 'fwd']);
/** Words of a title or a name, lower case, without punctuation or filler. */
export const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .split(' ')
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );

/** How much of the shorter set the other holds: "Pricing workshop" is all in "Voyage Insights pricing workshop". */
function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / Math.min(a.size, b.size);
}

/** How much of the shorter of the two runs the other covers, the event widened by SLACK_MS. */
function timeScore(m: MeetingFacts, e: SnapEvent): number {
  const [ms, me] = [Date.parse(m.start), Date.parse(m.end)];
  const [es, ee] = [Date.parse(e.start) - SLACK_MS, Date.parse(e.end) + SLACK_MS];
  const shared = Math.min(me, ee) - Math.max(ms, es);
  if (me <= ms) return ms >= es && ms <= ee ? 1 : 0; // no length: inside or not
  return shared <= 0 ? 0 : Math.min(1, shared / Math.min(me - ms, ee - es));
}

/** A person's name, or what an address says of it: "sam.okafor@…" is "sam okafor". */
const nameOf = (p: { name?: string; address?: string }) => p.name ?? (p.address ?? '').split('@')[0].replace(/[._-]+/g, ' ');

function peopleScore(m: MeetingFacts, e: SnapEvent): number {
  if (!m.people.length) return 0;
  const invited = e.attendees.filter((a) => a.type !== 'resource').map((a) => words(nameOf(a)));
  if (e.organizer) invited.push(words(nameOf(e.organizer)));
  const found = m.people.filter((p) => {
    const w = words(p);
    return invited.some((i) => [...w].every((x) => i.has(x)) || [...w][0] === [...i][0]);
  });
  return found.length / m.people.length;
}

export function scoreEvent(m: MeetingFacts, e: SnapEvent): number {
  const time = timeScore(m, e);
  if (!time) return 0;
  return WEIGHTS.time * time + WEIGHTS.title * overlap(words(m.title), words(e.subject)) + WEIGHTS.people * peopleScore(m, e);
}

/** The event the meeting was, when one is clearly it: not cancelled, declined or all day. */
export function bestEvent(m: MeetingFacts, events: readonly SnapEvent[]): SnapEvent | undefined {
  const scored = events
    .filter((e) => !e.cancelled && !e.allDay && e.response !== 'declined')
    .map((e) => ({ e, score: scoreEvent(m, e) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  const [best, next] = scored;
  if (!best || best.score < MIN_SCORE) return undefined;
  return next && best.score - next.score < MIN_MARGIN ? undefined : best.e;
}
