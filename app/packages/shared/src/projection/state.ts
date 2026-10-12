import type { LoggedDecision, MirrorFailure, TodoBy } from '../events';
import type { DeadlineFrom } from '../todo';
import type { ItemStatus, TriageState } from '../lanes';
import type { FilingStages } from '../policy';
import type { Action, Attention, ItemKind, Participant, SourceId, TriageCorrection } from '../schemas';

// The inbox state that the event log projects to (PLAN.md §4.3). The server keeps it in memory
// and in snapshot.json; the mock keeps the same flags on its own records. Bump PROJECTION_VERSION
// whenever reduce() changes, so the server replays the whole log instead of trusting the snapshot.
export const PROJECTION_VERSION = 9; // 9: To Dos (todo.created, todo.done, todo.reopened, FR-16.1–16.3; todo.mirrored, todo.mirrorFailed, todo.timed, FR-16.4–16.5); 8: Frank's word on a filing's stage (filing.staged, FR-15.7); 7: Retry write (a failed write approved again), failedWhile only once approved; 6: events that arrive too late change nothing (action status guards, stale failures and checks); 4: Frank's own piece joining a topic, and Looks finished (CK-2.1, CK-2.10); 5: the bell's dismissals, back-from-snooze times, failedWhile (FR-11.3–11.5)

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
  todoDismissed?: number; // E14 (FR-15.6): the revision whose suggested to-do Frank dismissed
  staged?: FilingStages; // E14 (FR-15.7): Frank's word on a filing's stage, from the Filing… menu
  snoozedUntil?: string;
  doneAt?: string;
  newReplies: boolean; // new messages since the last triage, not yet seen
  backFromSnooze: boolean;
  backAt?: string; // when the snooze last ended: names that occurrence in the bell (FR-11.4)
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
  // Cockpit CK-2.10: a topic that waited on Frank was re-triaged to None after others wrote. A
  // check of whether their messages settled his asks follows; if so, it looks finished.
  finishPending?: string; // the decision's time, until the check runs
  looksFinished?: string; // when the check found every ask settled, until Done, a correction or new messages
}

/** Who closed an item: Frank pressing Done, his reply settling it, or its source (an answered invite). */
export type DoneBy = 'you' | 'reply' | 'source';

export interface ReplyCheck {
  at: string;
  revision: number;
  allSettled: boolean;
  settled: number; // asks it found settled
  handedOn?: true; // he passed it on but still owns the outcome: it moved to Waiting on others
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

/**
 * A To Do (E15, FR-16.1): one line a to-do action wrote to the Tasks note, tracked by Work OS. Its
 * words live in todos/<id>.json; the log keeps when it is due and whether it is done.
 */
export interface TodoState {
  id: string;
  itemId: string;
  actionId: string;
  /** The line's 🆔 in the Tasks note; absent for a line written before To Dos had ids. */
  lineId?: string;
  createdAt: string;
  status: 'open' | 'done';
  deadline?: string;
  deadlineFrom: DeadlineFrom;
  doneAt?: string;
  doneBy?: TodoBy;
  /** Made at start from a to-do written before Work OS tracked To Dos. */
  backfilled?: true;
  /**
   * FR-16.4: Frank's Done or reopen, still to be mirrored to the line in the Tasks note; `failed`
   * says why the last try didn't. Absent once the line matches, or when the note made the change.
   */
  mirror?: { want: 'ticked' | 'open'; failed?: MirrorFailure; failedAt?: string };
  /** FR-16.5: how long it took, in minutes, as Frank said on Done. */
  actualMinutes?: number;
}

export interface Projection {
  lastSeq: number;
  items: Record<string, ItemState>;
  actions: Record<string, ActionState>;
  /** E15 (FR-16.1): To Dos by id. Absent in a snapshot written before it existed. */
  todos?: Record<string, TodoState>;
  sources: Partial<Record<SourceId, SourceState>>;
  /** By London date, the last 30 days. Absent in a snapshot written before it existed. */
  closes?: Record<string, CloseStats>;
  /** The bell's dismissed entries (FR-11.5): key → when. Kept DISMISSED_DAYS. Absent in a snapshot written before it existed. */
  dismissed?: Record<string, string>;
}

/** How long a dismissal is remembered: longer than anything in the bell lasts. */
export const DISMISSED_DAYS = 90;

export const emptyProjection = (): Projection => ({ lastSeq: 0, items: {}, actions: {}, sources: {} });
