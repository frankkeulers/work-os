import type { TopicPiece } from '../api';
import type { LoggedDecision } from '../events';
import type { Item } from '../schemas';
import type { ItemFlags } from './state';
import { receiveMessages } from './transitions';

// Topics (amendment). Ingestion cuts a conversation into pieces: a Slack thread, a DM window after
// 30 minutes of quiet, a channel post. Routing puts the pieces that share a subject into one topic,
// anchored on one of them. The anchor's ID is the topic's ID: it is shown, triaged and acted on;
// its parts are hidden and follow it. Each change works in place on a map of records, so the
// server's reducer and the mock run exactly the same rules. `act` finds a record's activity time:
// the projection keeps it on the record, the mock on its item.

type TopicRec<D extends LoggedDecision> = ItemFlags<D>;
type Recs<D extends LoggedDecision, R extends TopicRec<D>> = Record<string, R>;
export type Activity<R> = (r: R) => { lastActivityAt: string };

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
export function routeTopic<D extends LoggedDecision, R extends TopicRec<D>>(items: Recs<D, R>, act: Activity<R>, pieceId: string, into: string | undefined, by: 'model' | 'user' | 'regroup') {
  const piece = items[pieceId];
  if (!piece) return;
  piece.routed = true;
  const target = into === undefined ? undefined : anchorOf(items, into);
  const from = piece.topicOf;
  if (from && from === target) return;
  if (from) leave(items, pieceId, from, by === 'user');
  if (target && target !== pieceId && items[target] && !items[target].topicOf) join(items, act, pieceId, target, by);
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

function join<D extends LoggedDecision, R extends TopicRec<D>>(items: Recs<D, R>, act: Activity<R>, pieceId: string, anchorId: string, by: 'model' | 'user' | 'regroup') {
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
    act(anchor).lastActivityAt = latest(act(anchor).lastActivityAt, act(m).lastActivityAt);
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
export function partGrew<D extends LoggedDecision, R extends TopicRec<D>>(items: Recs<D, R>, act: Activity<R>, partId: string, fromMeOnly: boolean) {
  const part = items[partId];
  const anchor = part?.topicOf ? items[part.topicOf] : undefined;
  if (!anchor) return;
  act(anchor).lastActivityAt = latest(act(anchor).lastActivityAt, act(part).lastActivityAt);
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

// ---------------------------------------------------------------- content

/**
 * One item holding a whole topic: every piece's messages in time order, under the anchor's ID and
 * revision. `inThread` names the messages that came from a Slack thread. `ends(n)` names each
 * piece's first message and its last n: what triage keeps of a topic, so an ask in an earlier piece
 * isn't trimmed away by the later ones.
 */
export function topicItem(anchor: Item, parts: Item[]): { item: Item; inThread: Set<string>; ends: (n: number) => Set<string> } {
  const inThread = new Set<string>();
  const pieces = [anchor, ...parts];
  for (const piece of pieces) if (piece.thread) for (const m of piece.messages) inThread.add(m.id);
  const ends = (n: number) => new Set(parts.length ? pieces.flatMap((piece) => [piece.messages[0], ...piece.messages.slice(-n)].filter((m) => !!m).map((m) => m.id)) : []);
  if (!parts.length) return { item: anchor, inThread, ends };
  const byId = new Map(pieces.flatMap((piece) => piece.messages.map((m): [string, Item['messages'][number]] => [m.id, m])));
  const messages = [...byId.values()].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id));
  const participants = [...new Map(pieces.flatMap((piece) => piece.participants.map((x): [string, typeof x] => [x.id, x]))).values()];
  const mentioned = [...new Map(pieces.flatMap((piece) => (piece.mentioned ?? []).map((x): [string, typeof x] => [x.id, x]))).values()];
  return {
    inThread,
    ends,
    item: {
      ...anchor,
      participants,
      ...(mentioned.length && { mentioned }),
      messages,
      messageCount: pieces.reduce((n, piece) => n + piece.messageCount, 0),
      lastActivityAt: pieces.map((piece) => piece.lastActivityAt).sort().at(-1)!,
    },
  };
}

/** A topic's pieces, oldest first, for the item panel. Undefined for an item that is its only piece. */
export function topicPiecesView(anchorId: string, pieces: Item[], openUrl: (p: Item, kind: TopicPiece['kind']) => string | undefined = () => undefined): TopicPiece[] | undefined {
  if (pieces.length < 2) return undefined;
  const start = (p: Item) => p.messages[0]?.ts ?? p.lastActivityAt;
  return [...pieces]
    .sort((a, b) => start(a).localeCompare(start(b)))
    .map((p): TopicPiece => {
      const kind = p.thread ? 'thread' : 'chat';
      return { id: p.id, kind, permalink: p.permalink, openUrl: openUrl(p, kind) ?? p.permalink, messageIds: p.messages.map((m) => m.id), messageCount: p.messageCount, anchor: p.id === anchorId };
    });
}

/** The conversation a piece belongs to (a Slack channel or DM), which routing keeps topics within. */
export function conversationOf(i: { id: string; source: string }): string | undefined {
  return i.source === 'slack' ? i.id.split(':')[1] || undefined : undefined;
}
