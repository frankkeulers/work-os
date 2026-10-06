import type { LoggedDecision } from '../events';
import type { ItemStatus, TriageState } from '../lanes';
import type { Action, Attention, ItemKind, Participant, SourceId, TriageCorrection } from '../schemas';

// The inbox state that the event log projects to (PLAN.md §4.3). The server keeps it in memory
// and in snapshot.json; the mock keeps the same flags on its own records. Bump PROJECTION_VERSION
// whenever reduce() changes, so the server replays the whole log instead of trusting the snapshot.
export const PROJECTION_VERSION = 1;

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
  snoozedUntil?: string;
  doneAt?: string;
  newReplies: boolean; // new messages since the last triage, not yet seen
  backFromSnooze: boolean;
  failCount: number; // triage attempts that returned invalid output (CL-7)
  notified: boolean; // at most one notification per item (FR-11.2)
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

export interface Projection {
  lastSeq: number;
  items: Record<string, ItemState>;
  actions: Record<string, ActionState>;
  sources: Partial<Record<SourceId, SourceState>>;
}

export const emptyProjection = (): Projection => ({ lastSeq: 0, items: {}, actions: {}, sources: {} });
