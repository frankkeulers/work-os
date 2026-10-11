import { z } from 'zod';
import { ActionTarget, ActionType, FailureReason, ItemKind, NextStep, Participant, PromptFileId, SourceId, TriageCorrection, TriageDecision } from './schemas';

// The event log (PLAN.md §4.3, §4.4). It is the source of truth: every event carries a gap-free
// `seq` and a typed payload, so the inbox can be rebuilt from the log alone. Events never carry
// message bodies (CLAUDE.md, file storage rules); bodies live only in items/.

const isoDate = z.iso.datetime();
const revision = z.number().int().positive();
const none = z.object({}).strict().optional();

export const PollReason = z.enum(['manual', 'scheduled', 'wake', 'reconnect', 'first']);
export type PollReason = z.infer<typeof PollReason>;

// Dependencies whose health the server tracks (FR-14.3, FR-14.6). wisprMcp is Wispr Flow's MCP server
// (R2.7); wisprDb is its local database, kept for the fallback reader (R2.6); ms365 is the claude.ai
// Microsoft 365 connector the Outlook sources read through (R2.5), apart from Claude itself.
export const DepId = z.enum(['network', 'slack', 'claude', 'confluence', 'keychain', 'storage', 'wisprDb', 'wisprMcp', 'ms365']);
export type DepId = z.infer<typeof DepId>;

export const DepState = z.enum(['ok', 'unknown', 'offline', 'degraded', 'rate_limited', 'auth_failed', 'paused']);
export type DepState = z.infer<typeof DepState>;

// A decision as the log keeps it: without its free text (summary, reason, the wording of the next
// step). That text paraphrases the messages, so it lives with the raw content in items/ and expires
// with it (retention, §4.3). Strict, so text can't slip back in.
export const LoggedDecision = TriageDecision.omit({ summary: true, reason: true, next: true })
  .extend({ next: NextStep.pick({ need: true, dueAt: true }).strict().optional() })
  .strict();
export type LoggedDecision = z.infer<typeof LoggedDecision>;

export function toLoggedDecision(d: TriageDecision): LoggedDecision {
  const { summary: _summary, reason: _reason, next, ...rest } = d;
  return { ...rest, ...(next && { next: { need: next.need, ...(next.dueAt && { dueAt: next.dueAt }) } }) };
}

export const EventPayloads = {
  // Item metadata only, enough to show and rebuild the inbox after retention removes the raw content.
  'item.upserted': z.object({
    source: SourceId,
    kind: ItemKind,
    title: z.string().min(1),
    permalink: z.url(),
    participants: z.array(Participant),
    lastActivityAt: isoDate,
    revision,
    messageCount: z.number().int().nonnegative(),
    fromMeOnly: z.boolean(), // the new messages are all the user's own: no re-triage (§5.3)
  }),
  // Amendment (R2.8): a source can close an item itself, e.g. an invite Frank answered in Outlook.
  // Cockpit (CK-2.3): Frank's reply settled every ask; `check` is the settle batch that said so.
  // No data: Frank pressed Done.
  'item.done': z
    .union([
      z.object({ by: z.literal('source'), reason: z.string().min(1).max(200) }).strict(),
      z.object({ by: z.literal('reply'), source: SourceId, messageId: z.string().min(1), check: z.string().min(1) }).strict(),
    ])
    .optional(),
  'item.reopened': none,
  'item.snoozed': z.object({ until: isoDate }),
  'item.unsnoozed': none, // the snooze time passed (FR-8.3)
  'item.seen': none, // opened while flagged as new replies or back from snooze; clears the flags
  // At most one per item (FR-11.2). Logged even when quiet hours or the setting held it back,
  // so the item is never notified later.
  'item.notified': z.object({ kind: z.enum(['now', 'summary']), suppressed: z.enum(['quiet_hours', 'disabled']).optional() }),
  // Topics (amendment). On a piece: routing put it in another piece's topic (into), or in its own.
  // A piece Frank splits out is routed by 'user' with no into, and never rejoins that topic (from).
  // fromMeOnly: every message in the joining piece is Frank's, so it is his reply to the topic (cockpit CK-2.1).
  'topic.routed': z.object({ into: z.string().min(1).optional(), from: z.string().min(1).optional(), by: z.enum(['model', 'user', 'regroup']), fromMeOnly: z.boolean().optional() }),
  'topic.askDone': z.object({ askId: z.string().min(1), by: z.enum(['user', 'reply']).optional() }), // on an anchor: Frank ticked off one ask, or his reply settled it (cockpit CK-2.3)
  // finishCheck (cockpit CK-2.10): the topic waited on Frank and now needs nothing from him, after
  // messages from others: a check of whether they settled what it asked of him follows.
  'triage.decided': z.object({ decision: LoggedDecision, finishCheck: z.literal(true).optional() }),
  'triage.corrected': z.object({ correction: TriageCorrection }),
  // Frank said the decision for this revision was right; the labelled set gains it as a label.
  'triage.confirmed': z.object({ revision }),
  'triage.failed': z.object({ revision, attempts: z.number().int().positive(), reason: z.string().min(1) }),
  // Cockpit (CK-2.2): a settle check ran on Frank's reply. `through` is the latest activity it saw;
  // `settled` the asks it found settled, by askId. The reasons stay with the item's content.
  // handedOn (FR-8.1, amended): he passed it on but still owns the outcome, so it waits on others.
  'settle.checked': z.object({ revision, through: isoDate, batchId: z.string().min(1), allSettled: z.boolean(), settled: z.array(z.string().min(1)), handedOn: z.literal(true).optional() }),
  'settle.failed': z.object({ revision, attempts: z.number().int().positive(), reason: z.string().min(1) }),
  // Cockpit (CK-2.10): the check after finishCheck ran. allSettled: the topic looks finished, and is
  // suggested as Done. A failed check suggests nothing. The reasons stay with the item's content.
  'finish.checked': z.object({ revision, batchId: z.string().min(1), allSettled: z.boolean() }),
  'finish.failed': z.object({ revision, reason: z.string().min(1) }),
  // quiet: drafted ahead while filing in a batch, so no macOS notification when it's ready (FR-11.6).
  'action.requested': z.object({ type: ActionType, revision, supersedes: z.string().optional(), quiet: z.literal(true).optional() }),
  'action.drafted': z.object({
    type: ActionType,
    revision,
    draftRef: z.string().min(1),
    tokens: z.number().int().nonnegative(),
    target: ActionTarget, // where the approved write goes, checked again before it runs
  }),
  'action.edited': none,
  // Approved while filing in a batch (cockpit CK-4.4): the item is marked done once every filing it suggests is written.
  'action.approved': z.object({ markDoneWhenFiled: z.literal(true).optional() }).strict().optional(),
  // Synced before every write attempt, so a write interrupted by sleep or a crash is reconciled, not repeated (FR-14.5).
  'action.executing': z.object({ attempt: z.number().int().positive(), expectedHash: z.string().optional(), expectedHashes: z.record(z.string(), z.string()).optional() }),
  'action.executed': z.object({
    dryRun: z.boolean(),
    path: z.string().optional(),
    paths: z.array(z.string()).optional(), // every note written, when a draft files into several (FR-9.7)
    pageId: z.string().optional(),
    pageVersion: z.number().int().positive().optional(),
    // FR-9.6, FR-10.7: approved as already filed, so nothing was written.
    unchanged: z.literal(true).optional(),
  }),
  'action.failed': z.object({ reason: FailureReason, pageId: z.string().optional(), detail: z.string().optional() }),
  'action.discarded': z.object({ reason: z.enum(['cancelled', 'redraft', 'discarded']) }),
  'source.polled': z.object({
    source: SourceId,
    reason: PollReason,
    fetched: z.number().int().nonnegative(),
    cursor: z.string().optional(), // also kept here so cursors can be rebuilt from the log
    durationMs: z.number().int().nonnegative().optional(),
  }),
  'source.failed': z.object({ source: SourceId, error: z.string().min(1), retryAfterSeconds: z.number().nonnegative().optional() }),
  'settings.changed': z.object({ dryRun: z.boolean() }),
  'rules.changed': z.object({ count: z.number().int().nonnegative() }),
  'prompt.changed': z.object({ id: PromptFileId, version: z.string().min(1), reset: z.boolean() }),
  'system.started': z.object({ version: z.string().min(1), instance: z.enum(['prod', 'dev']) }),
  'system.stopped': z.object({ reason: z.string().min(1) }),
  'system.woke': z.object({ sleptSeconds: z.number().nonnegative() }),
  'health.changed': z.object({ dep: DepId, state: DepState, reason: z.string().optional() }),
  // Frank dismissed an entry in the bell (FR-11.5). The key names the occurrence, so a new one shows again.
  'attention.dismissed': z.object({ key: z.string().min(1).max(300) }),
} as const;

export type EventType = keyof typeof EventPayloads;
export const EventType = z.enum(Object.keys(EventPayloads) as [EventType, ...EventType[]]);

const base = {
  seq: z.number().int().positive(),
  id: z.string().min(1),
  at: isoDate,
  itemId: z.string().optional(),
  actionId: z.string().optional(),
  schemaVersion: z.literal(1),
};

const variant = <T extends EventType>(type: T) => z.object({ ...base, type: z.literal(type), data: EventPayloads[type] });

export const WorkEvent = z.discriminatedUnion(
  'type',
  (Object.keys(EventPayloads) as EventType[]).map((t) => variant(t)) as unknown as [
    ReturnType<typeof variant<EventType>>,
    ...ReturnType<typeof variant<EventType>>[],
  ],
);

export type EventData<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;
export type WorkEvent = { [T in EventType]: { seq: number; id: string; type: T; at: string; itemId?: string; actionId?: string; data: EventData<T>; schemaVersion: 1 } }[EventType];

/** An event before the log assigns its seq, id and time. */
export type EventDraft = { [T in EventType]: { type: T; data: EventData<T>; itemId?: string; actionId?: string } }[EventType];
