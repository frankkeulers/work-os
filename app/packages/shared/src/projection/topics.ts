import type { LoggedDecision } from '../events';
import type { ItemFlags } from './state';
import { receiveMessages } from './transitions';

// Topics (amendment). Ingestion cuts a conversation into pieces: a Slack thread, a DM window after
// 30 minutes of quiet, a channel post. Routing puts the pieces that share a subject into one topic,
// anchored on one of them. The anchor's ID is the topic's ID: it is shown, triaged and acted on;
// its parts are hidden and follow it. Each change works in place on a map of records, so the
// server's reducer and the mock run exactly the same rules.

type TopicRec<D extends LoggedDecision> = ItemFlags<D> & { lastActivityAt: string };
type Recs<D extends LoggedDecision, R extends TopicRec<D>> = Record<string, R>;

/** The topic a piece shows in: its anchor's ID, or its own. */
export const anchorOf = (items: Record<string, { topicOf?: string } | undefined>, id: string): string => items[id]?.topicOf ?? id;

/** A part is shown and triaged through its anchor, never on its own. */
export const isPart = (s: { topicOf?: string }): boolean => !!s.topicOf;

/** The topic's pieces: the anchor, then its parts. */
export const topicPieces = (s: { parts?: string[] }, id: string): string[] => [id, ...(s.parts ?? [])];

const latest = (...isos: (string | undefined)[]) => isos.filter((x): x is string => !!x).sort().at(-1)!;

/** Parts take their anchor's status, so they expire with it (retention) and reopen with it. */
export function followAnchor<D extends LoggedDecision, R extends TopicRec<D>>(items: Recs<D, R>, anchorId: string) {
  const a = items[anchorId];
  for (const id of a?.parts ?? []) {
    const part = items[id];
    if (!part) continue;
    part.status = a.status;
    part.doneAt = a.doneAt;
    part.snoozedUntil = a.snoozedUntil;
  }
}

/**
 * A piece was placed: into the topic `into` belongs to, or (no `into`) its own. Joining brings the
 * piece's own parts along, so two topics can merge (regroup). `by: 'user'` is Frank splitting it
 * out: it never rejoins that topic.
 */
export function routeTopic<D extends LoggedDecision, R extends TopicRec<D>>(items: Recs<D, R>, pieceId: string, into: string | undefined, by: 'model' | 'user' | 'regroup') {
  const piece = items[pieceId];
  if (!piece) return;
  piece.routed = true;
  const target = into === undefined ? undefined : anchorOf(items, into);
  const from = piece.topicOf;
  if (from && from === target) return;
  if (from) leave(items, pieceId, from, by === 'user');
  if (target && target !== pieceId && items[target] && !items[target].topicOf) join(items, pieceId, target, by);
}

function leave<D extends LoggedDecision, R extends TopicRec<D>>(items: Recs<D, R>, pieceId: string, anchorId: string, split: boolean) {
  const piece = items[pieceId];
  piece.topicOf = undefined;
  const anchor = items[anchorId];
  if (anchor) {
    anchor.parts = anchor.parts?.filter((id) => id !== pieceId);
    if (!anchor.parts?.length) anchor.parts = undefined;
    anchor.topicVersion++;
    anchor.triageState = 'pending'; // what is left needs a fresh summary
  }
  if (split) piece.notWith = [...new Set([...(piece.notWith ?? []), anchorId])];
  // On its own again: its decision from before it joined describes nothing current.
  piece.decision = undefined;
  piece.correction = undefined;
  piece.correctedFrom = undefined;
  piece.triageState = 'pending';
  piece.newReplies = false;
  piece.status = 'open';
  piece.doneAt = undefined;
  piece.snoozedUntil = undefined;
}

function join<D extends LoggedDecision, R extends TopicRec<D>>(items: Recs<D, R>, pieceId: string, anchorId: string, by: 'model' | 'user' | 'regroup') {
  const piece = items[pieceId];
  const anchor = items[anchorId];
  const moving = topicPieces(piece, pieceId).filter((id) => id !== anchorId);
  piece.parts = undefined;
  piece.asksDone = undefined;
  const parts = anchor.parts ?? [];
  for (const id of moving) {
    const m = items[id];
    if (!m) continue;
    m.topicOf = anchorId;
    if (!parts.includes(id)) parts.push(id);
    anchor.lastActivityAt = latest(anchor.lastActivityAt, m.lastActivityAt);
  }
  anchor.parts = parts;
  anchor.topicVersion++;
  // New messages for a topic Frank has seen show as new replies, and reopen it once triaged.
  // A regroup only rearranges what he has seen, and a topic never triaged has nothing to compare.
  if (by !== 'regroup' && anchor.decision) receiveMessages(anchor, false);
  else anchor.triageState = 'pending';
  followAnchor(items, anchorId);
}

/** New messages on a part are new messages on its topic. */
export function partGrew<D extends LoggedDecision, R extends TopicRec<D>>(items: Recs<D, R>, partId: string, fromMeOnly: boolean) {
  const part = items[partId];
  const anchor = part?.topicOf ? items[part.topicOf] : undefined;
  if (!anchor) return;
  anchor.lastActivityAt = latest(anchor.lastActivityAt, part.lastActivityAt);
  anchor.topicVersion++;
  receiveMessages(anchor, fromMeOnly);
}

export function markAskDone(s: { asksDone?: string[] }, askId: string) {
  if (!s.asksDone?.includes(askId)) s.asksDone = [...(s.asksDone ?? []), askId];
}

/**
 * An ask's ID: a short hash of its wording, so a tick survives a re-triage that repeats the ask
 * word for word. FNV-1a, as it runs the same in the browser and on the server.
 */
export function askId(step: string): string {
  let h = 0x811c9dc5;
  for (const ch of step.trim().toLowerCase().replace(/\s+/g, ' ')) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** The conversation a piece belongs to (a Slack channel or DM), which routing keeps topics within. */
export function conversationOf(i: { id: string; source: string }): string | undefined {
  return i.source === 'slack' ? i.id.split(':')[1] || undefined : undefined;
}
