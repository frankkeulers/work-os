import type { LoggedDecision } from '../events';
import type { ItemStatus, TriageState } from '../lanes';
import type { Action, Attention, ItemKind, Participant, SourceId, TriageCorrection } from '../schemas';

// The inbox state that the event log projects to (PLAN.md §4.3). The server keeps it in memory
// and in snapshot.json; the mock keeps the same flags on its own records. Bump PROJECTION_VERSION
// whenever reduce() changes, so the server replays the whole log instead of trusting the snapshot.
export const PROJECTION_VERSION = 3; // 3: settle checks and who closed an item (cockpit Stage 2)

/**
 * What the inbox knows about an item beyond its content. `D` is the decision type: the server
 * keeps the logged decision (no free text); the mock keeps the full one.
 */
export interface ItemFlags<D extends LoggedDecision = LoggedDecision> {
  status: ItemStatus;
  triageState: TriageState;
  decision?: D;
  correction?: TriageCorrection;
  correctedFrom?: Attention; // shown when a re-triage replaced Frank's correction
  confirmed?: number; // the decision's revision Frank said was right ("Triage was right")
  snoozedUntil?: string;
  doneAt?: string;
  newReplies: boolean; // new messages since the last triage, not yet seen
  backFromSnooze: boolean;
  failCount: number; // triage attempts that returned invalid output (CL-7)
  notified: boolean; // at most one notification per item (FR-11.2)
  // Topics (amendment): pieces of a conversation (threads, DM windows) on the same subject are
  // shown and triaged as one topic, anchored on one of them. See topics.ts.
  routed: boolean; // routing has placed this piece in a topic, its own or another's
  topicOf?: string; // the anchor, when this piece is part of another piece's topic
  parts?: string[]; // on an anchor: the topic's other pieces, in the order they joined
  notWith?: string[]; // anchors Frank split this piece from: routing never puts it back
  topicVersion: number; // on an anchor: bumped whenever a part joins, leaves or grows
  asksDone?: string[]; // on an anchor: asks Frank ticked off, by askId
  // Cockpit Stage 2 (CK-2.1–2.3): Frank's own reply on an item that needs him waits for a check of
  // whether it settles the item.
  settlePending?: string; // when his reply came in, until a check sees it
  settleFailures?: number; // checks that failed on it; after SETTLE_MAX_ATTEMPTS it waits no more
  replyCheck?: ReplyCheck; // the last check's outcome, until someone else writes or the item reopens
  doneBy?: DoneBy; // who closed it
  doneSource?: SourceId; // doneBy reply: where the reply was
  doneReason?: string; // doneBy source: why the source closed it
}

/** Who closed an item: Frank pressing Done, his reply settling it, or its source (an answered invite). */
export type DoneBy = 'you' | 'reply' | 'source';

export interface ReplyCheck {
  at: string;
  revision: number;
  allSettled: boolean;
  settled: number; // asks it found settled
}

/** Item metadata from item.upserted. Message bodies live in items/, never here. */
export interface ItemMeta {
  id: string;
  source: SourceId;
  kind: ItemKind;
  title: string;
  permalink: string;
  participants: Participant[];
  lastActivityAt: string;
  revision: number;
  messageCount: number;
}

export type ItemState = ItemMeta & ItemFlags;

/** An action as the log records it. The error text is the server's own message and is kept beside the draft. */
export type ActionState = Omit<Action, 'error'>;

export interface SourceState {
  lastPollAt?: string;
  cursor?: string;
}

/** One London day's closes (cockpit C1, C2): Needs you exits, those closed by Frank's reply, and reply closes he undid within 24 h. */
export interface CloseStats {
  exits: number;
  byReply: number;
  undone: number;
}

export interface Projection {
  lastSeq: number;
  items: Record<string, ItemState>;
  actions: Record<string, ActionState>;
  sources: Partial<Record<SourceId, SourceState>>;
  /** By London date, the last 30 days. Absent in a snapshot written before it existed. */
  closes?: Record<string, CloseStats>;
}

export const emptyProjection = (): Projection => ({ lastSeq: 0, items: {}, actions: {}, sources: {} });
