import { z } from 'zod';

// Shared contract between the web app and the future server (PLAN.md §4.4).
// Additions beyond §4.4 are marked "amendment" and listed in JOURNEYS.md.

const isoDate = z.iso.datetime();

export const SourceId = z.enum(['slack', 'outlook', 'teams', 'plaud', 'wispr']);
export type SourceId = z.infer<typeof SourceId>;

export const ItemKind = z.enum(['thread', 'dm', 'email', 'meeting', 'chat']);
export type ItemKind = z.infer<typeof ItemKind>;

export const Participant = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});
export type Participant = z.infer<typeof Participant>;

export const Message = z.object({
  id: z.string().min(1),
  authorId: z.string().min(1),
  ts: isoDate,
  text: z.string(),
});
export type Message = z.infer<typeof Message>;

export const Item = z.object({
  id: z.string().min(1), // e.g. "slack:C123:1728031234.000100"
  source: SourceId,
  kind: ItemKind,
  title: z.string().min(1), // channel name or DM partner
  permalink: z.url(),
  participants: z.array(Participant).min(1),
  mentioned: z.array(Participant).optional(), // amendment: names for users @-mentioned in the text, to render <@id>
  messages: z.array(Message),
  messageCount: z.number().int().nonnegative(), // full thread length; messages may be truncated
  lastActivityAt: isoDate,
  revision: z.number().int().positive(),
  contentExpired: z.boolean().optional(), // amendment: raw content removed by retention (FR-12.1)
  schemaVersion: z.literal(1),
});
export type Item = z.infer<typeof Item>;

export const Attention = z.enum(['now', 'today', 'none']);
export type Attention = z.infer<typeof Attention>;

const FilingSuggestion = z.object({
  suggested: z.boolean(),
  targetHint: z.string().optional(),
});

// amendment: what the triage thinks Frank has to do next (Inbox redesign). Optional, so a
// decision without it still drives the lanes; the UI then falls back to the lane defaults.
export const Need = z.enum(['reply', 'approve', 'decide', 'prepare', 'review', 'actions', 'file']);
export type Need = z.infer<typeof Need>;

export const NextStep = z.object({
  need: Need,
  step: z.string().min(1), // "Choose wording A or B in the thread"
  why: z.string().min(1),
  dueAt: isoDate.optional(),
  dueLabel: z.string().optional(), // "planning", or "this week" when there's no exact time
  blocks: z.string().optional(), // who or what is waiting: "Marketing waiting"
  actionItems: z.array(z.string()).optional(), // meeting action items assigned to Frank
});
export type NextStep = z.infer<typeof NextStep>;

export const TriageDecision = z.object({
  itemId: z.string().min(1),
  itemRevision: z.number().int().positive(),
  attention: Attention,
  confluence: FilingSuggestion,
  vault: FilingSuggestion,
  containsPeopleObservations: z.boolean(),
  summary: z.string().min(1),
  reason: z.string().min(1),
  next: NextStep.optional(), // amendment
  decidedBy: z.enum(['rule', 'model']),
  ruleId: z.string().optional(),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
  batchId: z.string().optional(),
  decidedAt: isoDate,
});
export type TriageDecision = z.infer<typeof TriageDecision>;

// A correction from the UI (FR-6.2). Appended to labels/triage.jsonl and emitted as triage.corrected.
export const TriageCorrection = z.object({
  itemId: z.string().min(1),
  itemRevision: z.number().int().positive(),
  attention: Attention,
  confluence: z.boolean(),
  vault: z.boolean(),
  correctedAt: isoDate,
});
export type TriageCorrection = z.infer<typeof TriageCorrection>;

export const ActionType = z.enum(['vault_note', 'confluence_entry']);
export type ActionType = z.infer<typeof ActionType>;

export const ActionStatus = z.enum(['drafting', 'ready', 'approved', 'executing', 'done', 'failed', 'discarded']);
export type ActionStatus = z.infer<typeof ActionStatus>;

// amendment: why an action failed, so the UI can offer the right recovery.
// unreachable: the outbox gave up after repeated transient failures; draft_missing: the draft file was lost (FR-14.5, FR-14.7).
export const FailureReason = z.enum(['conflict', 'people_check', 'allow_list', 'model_error', 'unreachable', 'draft_missing']);
export type FailureReason = z.infer<typeof FailureReason>;

export const ActionTarget = z.object({
  path: z.string().optional(),
  pageId: z.string().optional(),
  baseVersion: z.number().int().optional(),
});
export type ActionTarget = z.infer<typeof ActionTarget>;

export const Action = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1),
  itemRevision: z.number().int().positive(), // revision the draft was made from
  type: ActionType,
  status: ActionStatus,
  target: ActionTarget,
  draftRef: z.string().min(1),
  error: z.string().optional(),
  failureReason: FailureReason.optional(),
  supersedes: z.string().optional(), // previous action, when re-drafted after a conflict
  createdAt: isoDate,
  updatedAt: isoDate,
});
export type Action = z.infer<typeof Action>;

const DraftMeta = z.object({
  model: z.string(),
  promptVersion: z.string(),
  durationMs: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
  edited: z.boolean(),
});

export const VaultNewDraft = DraftMeta.extend({
  kind: z.literal('vault_new'),
  path: z.string().min(1),
  content: z.string(),
});
export const VaultAppendDraft = DraftMeta.extend({
  kind: z.literal('vault_append'),
  path: z.string().min(1),
  heading: z.string().min(1),
  context: z.array(z.string()), // existing lines shown above the insertion point
  content: z.string(),
});
export const ConfluenceDraft = DraftMeta.extend({
  kind: z.literal('confluence'),
  pageId: z.string().min(1),
  pageTitle: z.string().min(1),
  section: z.string().min(1),
  baseVersion: z.number().int().positive(),
  title: z.string().min(1),
  content: z.string(),
});
export const Draft = z.discriminatedUnion('kind', [VaultNewDraft, VaultAppendDraft, ConfluenceDraft]);
export type Draft = z.infer<typeof Draft>;
export type VaultNewDraft = z.infer<typeof VaultNewDraft>;
export type VaultAppendDraft = z.infer<typeof VaultAppendDraft>;
export type ConfluenceDraft = z.infer<typeof ConfluenceDraft>;

// The event log (EventType, WorkEvent and their payloads) lives in events.ts.

// ---------- Rules (FR-4.x) ----------

export const NamedList = z.enum(['vips', 'includeChannels', 'excludeChannels', 'customerChannels']);
export type NamedList = z.infer<typeof NamedList>;

export const isValidRegex = (source: string): boolean => {
  const m = /^\/(.+)\/([a-z]*)$/.exec(source);
  try {
    if (m) new RegExp(m[1], m[2]);
    else new RegExp(source);
    return true;
  } catch {
    return false;
  }
};

export const RuleCondition = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sender_in'), list: NamedList.optional(), values: z.array(z.string()).default([]) }),
  z.object({ type: z.literal('channel_in'), list: NamedList.optional(), values: z.array(z.string()).default([]) }),
  z.object({ type: z.literal('mentions_me') }),
  z.object({ type: z.literal('is_dm') }),
  z.object({
    type: z.literal('keyword'),
    pattern: z.string().min(1, 'Enter a pattern').refine(isValidRegex, 'Not a valid regular expression'),
  }),
]);
export type RuleCondition = z.infer<typeof RuleCondition>;

export const RuleOutcome = z.discriminatedUnion('type', [
  z.object({ type: z.literal('now') }),
  z.object({ type: z.literal('today') }),
  z.object({ type: z.literal('drop') }),
  z.object({ type: z.literal('model'), min: z.enum(['today', 'now']).optional() }),
]);
export type RuleOutcome = z.infer<typeof RuleOutcome>;

export const Rule = z.object({
  id: z
    .string()
    .min(1, 'Give the rule an id')
    .regex(/^[a-z0-9-]+$/, 'Use lower-case letters, digits and hyphens'),
  enabled: z.boolean(),
  conditions: z.array(RuleCondition).min(1, 'Add at least one condition'),
  outcome: RuleOutcome,
});
export type Rule = z.infer<typeof Rule>;

export const Rules = z.array(Rule).superRefine((rules, ctx) => {
  const seen = new Set<string>();
  rules.forEach((r, i) => {
    if (seen.has(r.id)) ctx.addIssue({ code: 'custom', path: [i, 'id'], message: `Duplicate rule id "${r.id}"` });
    seen.add(r.id);
  });
});

// ---------- Settings (FR-1.3) ----------

export const ModelId = z.enum(['haiku-4.5', 'sonnet-5.5', 'opus-5.5']);
export type ModelId = z.infer<typeof ModelId>;

const minutes = z.number({ error: 'Enter a number' }).int('Whole minutes only').positive('Must be more than 0');
const timeRange = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d[–-]([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM–HH:MM');

// Per-source polling (FR-1.3). Every field is optional and falls back to the defaults in
// sourceSchedule(), so settings written before sources existed stay valid at schemaVersion 1.
export const SourceSchedule = z.object({
  enabled: z.boolean(),
  intervalWorkMinutes: minutes,
  intervalOffMinutes: minutes.nullable(), // null: polled in work hours only
});
export type SourceSchedule = z.infer<typeof SourceSchedule>;

export const ConfluencePage = z.object({
  title: z.string().min(1, 'Enter a page title'),
  id: z.string().regex(/^\d{5,12}$/, 'Page IDs are 5–12 digits'),
});
export type ConfluencePage = z.infer<typeof ConfluencePage>;

export const Settings = z.object({
  dataDir: z.string().min(1),
  slack: z.object({
    fetchMode: z.enum(['search', 'history']),
    includeChannels: z.array(z.string()),
    excludeChannels: z.array(z.string()),
    customerChannels: z.array(z.string()),
    vips: z.array(z.string()),
  }),
  schedule: z.object({
    workHours: z.string().min(1, 'Enter work hours'),
    intervalWorkMinutes: minutes,
    intervalOffMinutes: minutes,
  }),
  triage: z.object({
    quietMinutes: minutes,
    maxThreadsPerCall: z.number().int().min(1, 'At least 1').max(100, 'At most 100'),
    maxInputTokens: z.number().int().min(1000, 'At least 1,000'),
    keepLastMessages: z.number().int().min(1, 'At least 1').max(20, 'At most 20'),
  }),
  models: z.object({
    triage: ModelId,
    draftVault: ModelId,
    draftConfluence: ModelId,
  }),
  claudeBackend: z.enum(['subscription', 'api_key', 'bedrock']),
  budgets: z.object({
    triageCallsPerDay: z.number().int().positive('Must be more than 0'),
    draftsPerDay: z.number().int().positive('Must be more than 0'),
    costEquivalentPerDay: z.number().positive('Must be more than 0'),
  }),
  baselineCostPerDay: z.number().positive().nullable(), // from Phase 0, P0-3
  retentionDays: z.number().int().min(1, 'At least 1 day').max(365, 'At most 365 days'),
  vaultPath: z.string().min(1, 'Enter the vault path'),
  confluence: z.object({
    siteUrl: z.url({ protocol: /^https$/, error: 'Enter the https:// address of your Confluence site' }), // amendment: links to pages
    spaceKey: z.string().min(1),
    pages: z.array(ConfluencePage),
  }),
  notifications: z.object({
    enabled: z.boolean(),
    quietHours: timeRange,
  }),
  dryRun: z.boolean(),
  sources: z.partialRecord(SourceId, SourceSchedule.partial()).optional(),
  schemaVersion: z.literal(1),
});
export type Settings = z.infer<typeof Settings>;

const SOURCE_DEFAULTS: Record<SourceId, SourceSchedule> = {
  slack: { enabled: true, intervalWorkMinutes: 10, intervalOffMinutes: 60 },
  outlook: { enabled: false, intervalWorkMinutes: 30, intervalOffMinutes: 120 },
  teams: { enabled: false, intervalWorkMinutes: 30, intervalOffMinutes: 120 },
  plaud: { enabled: false, intervalWorkMinutes: 180, intervalOffMinutes: null },
  wispr: { enabled: false, intervalWorkMinutes: 180, intervalOffMinutes: null },
};

/** A source's schedule with defaults filled in. Slack's defaults are the global schedule. */
export function sourceSchedule(settings: Pick<Settings, 'schedule' | 'sources'>, id: SourceId): SourceSchedule {
  const base =
    id === 'slack'
      ? { enabled: true, intervalWorkMinutes: settings.schedule.intervalWorkMinutes, intervalOffMinutes: settings.schedule.intervalOffMinutes }
      : SOURCE_DEFAULTS[id];
  return { ...base, ...settings.sources?.[id] };
}

// ---------- Usage (CL-5) and eval (FR-6.x) ----------

export const UsagePurpose = z.enum(['triage', 'draft_vault', 'draft_confluence', 'people_check', 'eval', 'startup_check', 'fetch']); // fetch: connector relay (CL-9)
export type UsagePurpose = z.infer<typeof UsagePurpose>;

export const UsageRecord = z.object({
  id: z.string().min(1),
  at: isoDate,
  purpose: UsagePurpose,
  model: ModelId,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheTokens: z.number().int().nonnegative(),
  costEquivalent: z.number().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  itemIds: z.array(z.string()),
  promptVersion: z.string(),
});
export type UsageRecord = z.infer<typeof UsageRecord>;

const PR = z.object({ precision: z.number().min(0).max(1), recall: z.number().min(0).max(1), support: z.number().int() });

export const EvalReport = z.object({
  id: z.string().min(1),
  at: isoDate,
  labelCount: z.number().int().positive(),
  promptVersion: z.string(),
  model: ModelId,
  categories: z.object({
    now: PR,
    today: PR,
    none: PR,
    confluence: PR,
    vault: PR,
  }),
  // rows = labelled (now, today, none), columns = predicted (now, today, none)
  confusion: z.array(z.array(z.number().int().nonnegative()).length(3)).length(3),
  tokens: z.number().int().nonnegative(),
  costEquivalent: z.number().nonnegative(),
  /** Labelled threads the model gave no usable answer for; not in the scores. */
  failed: z.number().int().nonnegative().optional(),
});
export type EvalReport = z.infer<typeof EvalReport>;
