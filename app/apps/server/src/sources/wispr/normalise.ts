import type { Item, Message, Participant } from '@work-os/shared';
import type { WisprMeeting, WisprMeetingRow, WisprParticipants } from './types';

// One Wispr Flow meeting as one inbox item (R2.3, R2.7). The item holds what triage reads: Wispr's
// summary (its "Next Steps" section holds the action items) and Frank's own notes. The transcript
// is never stored; the drafters fetch it when asked (fullContent).
//
// Message IDs are fixed ("summary", "notes", "todos"), so a summary Wispr rewrites replaces the
// stored text without counting as new content: a meeting is triaged once, when it is finalised.

export const ITEM_PREFIX = 'wispr:';
/** Frank in Wispr Flow items: the author of his own notes. */
export const ME_ID = 'wispr:me';
/** Shown as the summary's author. Not a participant: it's Wispr Flow, not a person. */
export const SUMMARY_AUTHOR = 'Wispr Flow summary';
/** A meeting with no notes page yet: the app's own URL scheme opens Wispr Flow (P0-11). */
export const APP_LINK = 'wispr-flow://';

export const itemId = (meetingId: string) => `${ITEM_PREFIX}${meetingId}`;
export const meetingIdOf = (itemId: string) => (itemId.startsWith(ITEM_PREFIX) ? itemId.slice(ITEM_PREFIX.length) : undefined);

/** A UTC timestamp with exactly six fraction digits, so timestamps sort as text. */
export function fixedTs(t: string): string {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(?:Z|\+00:00)$/.exec(t);
  return m ? `${m[1]}.${(m[2] ?? '').padEnd(6, '0').slice(0, 6)}Z` : t;
}

/** The cursor key: modified_at, then id. It sorts as text (amendment R2.7). */
export const cursorKey = (m: Pick<WisprMeetingRow, 'modified_at' | 'id'>) => `${fixedTs(m.modified_at)}|${m.id}`;

const iso = (t: string | null | undefined, fallback: string) => {
  const ms = t ? Date.parse(t) : NaN;
  return new Date(Number.isNaN(ms) ? Date.parse(fallback) : ms).toISOString();
};

/** A to-do as text, whatever shape Wispr gives it (the list has been empty so far, P0-11). */
function todoText(t: unknown): string | undefined {
  if (typeof t === 'string') return t.trim() || undefined;
  if (t && typeof t === 'object') {
    const o = t as Record<string, unknown>;
    const v = [o.text, o.title, o.content, o.description].find((x) => typeof x === 'string' && x.trim());
    return typeof v === 'string' ? v.trim() : undefined;
  }
  return undefined;
}

export function participantsOf(p: WisprParticipants | undefined, me: string | undefined): Participant[] {
  const out: Participant[] = [{ id: ME_ID, name: p?.user?.name || me || 'Me' }];
  for (const x of p?.participants ?? []) {
    if (x.is_self) continue;
    const id = `${ITEM_PREFIX}${x.contact_id ? `contact:${x.contact_id}` : `name:${x.name.trim().toLowerCase()}`}`;
    if (x.name.trim() && !out.some((q) => q.id === id)) out.push({ id, name: x.name.trim() });
  }
  return out;
}

/** Whether a meeting has anything to triage yet: finalised, with a summary or notes. */
export const ready = (m: WisprMeeting) => m.finalized && !!(m.summary?.trim() || m.content?.trim() || m.todos?.length);

export function buildItem(m: WisprMeeting, participants: Participant[]): Item {
  const at = iso(m.end ?? m.modified_at, m.modified_at);
  const later = (n: number) => new Date(Date.parse(at) + n).toISOString();
  const messages: Message[] = [];
  if (m.summary?.trim()) messages.push({ id: 'summary', authorId: SUMMARY_AUTHOR, ts: at, text: m.summary.trim() });
  if (m.content?.trim()) messages.push({ id: 'notes', authorId: ME_ID, ts: later(1), text: m.content.trim() });
  const todos = (m.todos ?? []).map(todoText).filter((t): t is string => !!t);
  if (todos.length) messages.push({ id: 'todos', authorId: SUMMARY_AUTHOR, ts: later(2), text: `Action items:\n${todos.map((t) => `- ${t}`).join('\n')}` });
  return {
    id: itemId(m.id),
    source: 'wispr',
    kind: 'meeting',
    title: m.title?.trim() || 'Untitled meeting',
    permalink: m.share_link || APP_LINK,
    participants,
    messages,
    messageCount: messages.length,
    lastActivityAt: iso(m.modified_at, at),
    revision: 1,
    schemaVersion: 1,
  };
}
