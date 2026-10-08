import { createHash } from 'node:crypto';
import type { Item, Message, Participant } from '@work-os/shared';
import type { EventDetail, EventRow } from '../ms365/types';
import { emailText } from '../outlook/html';
import { cleanSubject, person, type MeInfo } from '../outlook/normalise';
import type { SnapEvent, SnapPerson } from './store';
import { wallToUtc, whenText } from './time';

// Calendar events as the snapshot keeps them, and invites as inbox items (R2.8). An invite item is
// one per organiser and subject, so a weekly series or a meeting sent again is one item, not one per
// occurrence (search has no series ID, P0-12). Its messages are what happened: the invite, and each
// time an event in it moved. The body keeps the agenda the organiser wrote; the Teams block under it
// (join link, meeting ID, passcode) is cut, here and everywhere else.

export const ITEM_PREFIX = 'calendar:';
const FALLBACK_LINK = 'https://outlook.office.com/calendar/';
export const INVITE_MAX_CHARS = 4000;

/** Where the Teams or Zoom block in an invite starts: everything after it is joining details. */
const JOIN_BLOCK_RE = /^.*(?:_{20,}|Microsoft Teams (?:meeting|Need help)|Join (?:on your computer|the meeting now|Zoom Meeting)|Meeting ID:|Passcode:).*$/im;

/** The text of an invite's body, without its joining details. */
export function inviteBody(body: EventDetail['body']): string {
  const text = emailText(body, []);
  const at = text.search(JOIN_BLOCK_RE);
  const cut = (at < 0 ? text : text.slice(0, at)).trim();
  return cut.length > INVITE_MAX_CHARS ? `${cut.slice(0, INVITE_MAX_CHARS - 1)}…` : cut;
}

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const isoOf = (t: string | null | undefined) => {
  if (!t) return undefined;
  const ms = Date.parse(/Z$|[+-]\d\d:\d\d$/.test(t) ? t : `${t}Z`);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
};
const https = (link: string | null | undefined) => (link && /^https:\/\//.test(link) ? link : undefined);

/** What search says about an event, hashed: when it changes, the event is read again. */
export function rowHash(r: EventRow): string {
  const fields = [r.subject ?? '', lower(r.organizer), [...(r.attendees ?? [])].map(lower).sort(), r.start.dateTime, r.start.timeZone ?? '', r.end.dateTime, r.end.timeZone ?? '', !!r.isAllDay, !!r.isCancelled];
  return createHash('sha1').update(JSON.stringify(fields)).digest('hex').slice(0, 16);
}

/** A search row as the snapshot keeps it, or undefined when its times don't parse. */
export function snapFromRow(r: EventRow, me: MeInfo): SnapEvent | undefined {
  const start = wallToUtc(r.start);
  const end = wallToUtc(r.end);
  if (!start || !end) return undefined;
  const organizer = r.organizer ? { address: lower(r.organizer) } : undefined;
  return {
    id: r.id,
    uri: r.uri,
    subject: r.subject?.trim() ?? '',
    ...(organizer && { organizer }),
    attendees: (r.attendees ?? []).filter(Boolean).map((a) => ({ address: lower(a) })),
    start,
    end,
    allDay: !!r.isAllDay,
    cancelled: !!r.isCancelled,
    isOrganizer: !!r.isOrganizer || (!!organizer?.address && me.aliases.includes(organizer.address)),
    ...(r.showAs && { showAs: r.showAs }),
    ...(https(r.webLink) && { link: r.webLink! }),
  };
}

/** Frank's answer to an event: his own attendee entry, or "notListed" when he isn't one by address. */
export function responseOf(e: EventDetail, me: MeInfo): string {
  const mine = (e.attendees ?? []).find((a) => me.aliases.includes(lower(a.address)));
  return mine ? mine.responseStatus || 'none' : 'notListed';
}

/** An event read whole, laid over what search gave (or what the snapshot had). */
export function snapFromDetail(e: EventDetail, base: SnapEvent | undefined, me: MeInfo): SnapEvent | undefined {
  const start = wallToUtc(e.start);
  const end = wallToUtc(e.end);
  if (!start || !end) return base;
  const organizer: SnapPerson | undefined = e.organizer ? { ...(e.organizer.name && { name: e.organizer.name }), ...(e.organizer.address && { address: lower(e.organizer.address) }) } : base?.organizer;
  return {
    ...base,
    id: e.id,
    uri: base?.uri ?? `calendar:///events/${encodeURIComponent(e.id)}`,
    subject: e.subject?.trim() ?? base?.subject ?? '',
    ...(organizer && { organizer }),
    attendees: (e.attendees ?? []).map((a) => ({ ...(a.name && { name: a.name }), ...(a.address && { address: lower(a.address) }), ...(a.type && { type: a.type }) })),
    start,
    end,
    allDay: !!e.isAllDay,
    cancelled: !!e.isCancelled,
    isOrganizer: base?.isOrganizer || (!!organizer?.address && me.aliases.includes(organizer.address)),
    ...(https(e.webLink) && { link: e.webLink! }),
    response: responseOf(e, me),
    ...(isoOf(e.createdDateTime) && { created: isoOf(e.createdDateTime) }),
  };
}

/** Frank still has to answer it: invited by someone else, not cancelled, not started, unanswered. */
export const wantsAnswer = (e: SnapEvent, now: Date) => !e.isOrganizer && !e.cancelled && Date.parse(e.start) > now.getTime() && (e.response === 'none' || e.response === 'notResponded');

/** Worth reading to learn Frank's answer: someone else's meeting with people on it, still to come. */
export const isCandidate = (e: SnapEvent, now: Date) => !e.isOrganizer && !e.cancelled && e.attendees.length > 0 && Date.parse(e.start) > now.getTime();

/** The invite item an event belongs to: one per organiser and subject. */
export function inviteItemId(e: SnapEvent): string {
  const key = `${lower(e.organizer?.address ?? e.organizer?.name)}|${lower(cleanSubject(e.subject))}`;
  return `${ITEM_PREFIX}${createHash('sha1').update(key).digest('hex').slice(0, 20)}`;
}

const asAddress = (p: SnapPerson | undefined) => (p ? { name: p.name ?? null, address: p.address ?? null } : undefined);

/** The organiser and invitees as people; rooms and other resources are left out. */
export function peopleOf(e: SnapEvent, me: MeInfo): { organizer?: Participant; required: Participant[]; optional: Participant[] } {
  const organizer = person(asAddress(e.organizer), me);
  const required: Participant[] = [];
  const optional: Participant[] = [];
  for (const a of e.attendees) {
    if (a.type === 'resource') continue;
    const p = person(asAddress(a), me);
    if (!p || p.id === organizer?.id) continue;
    (a.type === 'optional' ? optional : required).push(p);
  }
  return { organizer, required, optional };
}

const names = (ps: Participant[], me: MeInfo) => ps.map((p) => (p.id === me.id ? 'you' : p.name)).join(', ');

/** The invite as a message: when, who, and what the organiser wrote. */
export function inviteText(e: SnapEvent, body: string, others: SnapEvent[], me: MeInfo): string {
  const { organizer, required, optional } = peopleOf(e, me);
  const lines = [`Invitation: ${e.subject || '(no title)'}`, `When: ${whenText(e.start, e.end, e.allDay)}`];
  if (others.length) lines.push(`Also: ${others.map((o) => whenText(o.start, o.end, o.allDay)).join('; ')}`);
  if (organizer) lines.push(`Organiser: ${organizer.name}`);
  if (required.length) lines.push(`Required: ${names(required, me)}`);
  if (optional.length) lines.push(`Optional: ${names(optional, me)}`);
  return body ? `${lines.join('\n')}\n\n${body}` : lines.join('\n');
}

/**
 * An invite item. `events` are the events in it that still want an answer, soonest first; the
 * first is the one the item shows. `messages` are only what is new: the poll adds them to the
 * messages the item already has.
 */
export function inviteItem(itemId: string, events: SnapEvent[], messages: Message[], me: MeInfo): Item {
  const first = events[0];
  const { organizer, required, optional } = peopleOf(first, me);
  const participants: Participant[] = [{ id: me.id, name: me.name }];
  for (const p of [organizer, ...required, ...optional]) if (p && !participants.some((q) => q.id === p.id)) participants.push(p);
  const invitees = [...required, ...optional];
  return {
    id: itemId,
    source: 'calendar',
    kind: 'event',
    title: cleanSubject(first.subject) === '(no subject)' ? '(no title)' : cleanSubject(first.subject),
    permalink: https(first.link) ?? FALLBACK_LINK,
    participants,
    messages,
    messageCount: messages.length,
    lastActivityAt: messages.map((m) => m.ts).sort().at(-1)!,
    revision: 1,
    schemaVersion: 1,
    meeting: {
      start: first.start,
      end: first.end,
      calendar: { eventId: first.id, title: first.subject || '(no title)', ...(organizer && { organizer }), invitees, ...(https(first.link) && { link: first.link }) },
    },
  };
}

/** The message for a new invite. Its ID carries the start, so the same event sent again later is new. */
export function inviteMessage(e: SnapEvent, body: string, others: SnapEvent[], me: MeInfo, now: Date): Message {
  const by = peopleOf(e, me).organizer;
  const ts = e.created && e.created <= now.toISOString() ? e.created : now.toISOString();
  return { id: `invite:${e.id}:${e.start}`, authorId: by?.id ?? 'unknown', ts, text: inviteText(e, body, others, me) };
}

/** The message for an event in an open invite that moved. */
export function movedMessage(e: SnapEvent, was: SnapEvent, me: MeInfo, now: Date): Message {
  const by = peopleOf(e, me).organizer;
  return { id: `moved:${e.id}:${e.start}`, authorId: by?.id ?? 'unknown', ts: now.toISOString(), text: `Moved to ${whenText(e.start, e.end, e.allDay)} (was ${whenText(was.start, was.end, was.allDay)}).` };
}
