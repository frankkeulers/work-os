import { z } from 'zod';
import { OutlookColor } from './categories';
import { isWorkHours } from './time';

// Shared contract between the web app and the future server (PLAN.md §4.4).
// Additions beyond §4.4 are marked "amendment" and listed in JOURNEYS.md.

const isoDate = z.iso.datetime();

export const SourceId = z.enum(['slack', 'outlook', 'teams', 'plaud', 'wispr', 'calendar']); // amendment (R2.8): calendar
export type SourceId = z.infer<typeof SourceId>;

export const ItemKind = z.enum(['thread', 'dm', 'email', 'meeting', 'chat', 'event']); // amendment (R2.8): event, an invite
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
  // Amendment (Outlook): who an email went to, as participant IDs. Chat messages have neither.
  to: z.array(z.string().min(1)).optional(),
  cc: z.array(z.string().min(1)).optional(),
});
export type Message = z.infer<typeof Message>;

/** Amendment (R2.8): when a meeting or invite takes place, and the calendar event it is, once matched. */
export const ItemMeeting = z.object({
  start: isoDate,
  end: isoDate,
  calendar: z
    .object({
      eventId: z.string().min(1),
      title: z.string(),
      organizer: Participant.optional(),
      invitees: z.array(Participant),
      link: z.url().optional(),
      categories: z.array(z.string()).optional(), // Outlook category names, as the event had them
      joinUrl: z.url().optional(), // amendment (Frank, 12 Oct 2026): a Teams meeting's join link; never sent to a model
    })
    .optional(),
});
export type ItemMeeting = z.infer<typeof ItemMeeting>;

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
  thread: z.boolean().optional(), // amendment (topics): a Slack thread with replies, not a stretch of chat or a lone post
  meeting: ItemMeeting.optional(), // amendment (R2.8): a meeting's or an invite's time, and its calendar event
  schemaVersion: z.literal(1),
});
export type Item = z.infer<typeof Item>;

// follow (amendment, FR-8.1): Frank owns the outcome, someone else has the next move.
export const Attention = z.enum(['now', 'today', 'follow', 'none']);
export type Attention = z.infer<typeof Attention>;

/** Attention levels in the order the eval's confusion matrix lists them. */
export const ATTENTION_ORDER: readonly Attention[] = ['now', 'today', 'follow', 'none'];

// E14 (FR-15.2): what the filing policy says about a suggested filing. Written by policy-era
// triage whenever a filing is suggested; absent on earlier decisions, which pre-draft every
// suggested filing (see filingPlan()).
export const FilingSuggestion = z.object({
  suggested: z.boolean(),
  targetHint: z.string().optional(),
  predraft: z.boolean().optional(),
  ready: z.boolean().optional(),
  rule: z.string().optional(), // the policy rule applied: "R1", "P2", "F1"
});
export type FilingSuggestion = z.infer<typeof FilingSuggestion>;

/** A policy rule ID as the filing policy writes them (FR-15.1): letters, then a number. */
export const POLICY_RULE_RE = /^[A-Z]{1,3}\d{1,3}$/;

/** E14 (FR-15.6): a step the policy suggests as a to-do. Suggest only: Frank adds it, or not. */
export const TodoSuggestion = z.object({
  step: z.string().min(1),
  dueAt: isoDate.optional(),
  rule: z.string().optional(),
});
export type TodoSuggestion = z.infer<typeof TodoSuggestion>;

// amendment: what the triage thinks Frank has to do next (Inbox redesign). Optional, so a
// decision without it still drives the lanes; the UI then falls back to the lane defaults.
export const Need = z.enum(['reply', 'approve', 'decide', 'prepare', 'review', 'actions', 'file']);
export type Need = z.infer<typeof Need>;

// amendment (topics): one thing Frank has to do in a topic. A topic can hold several; the
// decision's `next` is the most urgent of them.
export const Ask = z.object({
  need: Need,
  step: z.string().min(1),
  dueAt: isoDate.optional(),
  dueLabel: z.string().optional(),
});
export type Ask = z.infer<typeof Ask>;

export const NextStep = z.object({
  need: Need,
  step: z.string().min(1), // "Choose wording A or B in the thread"
  why: z.string().min(1),
  dueAt: isoDate.optional(),
  dueLabel: z.string().optional(), // "planning", or "this week" when there's no exact time
  blocks: z.string().optional(), // who or what is waiting: "Marketing waiting"
  actionItems: z.array(z.string()).optional(), // meeting action items assigned to Frank
  asks: z.array(Ask).optional(), // amendment (topics): every open ask in the topic, `next` among them
});
export type NextStep = z.infer<typeof NextStep>;

export const TriageDecision = z.object({
  itemId: z.string().min(1),
  itemRevision: z.number().int().positive(),
  topicVersion: z.number().int().nonnegative().optional(), // amendment (topics): the topic's parts as triaged
  attention: Attention,
  confluence: FilingSuggestion,
  vault: FilingSuggestion,
  containsPeopleObservations: z.boolean(),
  summary: z.string().min(1),
  reason: z.string().min(1),
  next: NextStep.optional(), // amendment
  todo: TodoSuggestion.optional(), // E14 (FR-15.6)
  decidedBy: z.enum(['rule', 'model']),
  ruleId: z.string().optional(),
  modelAttention: Attention.optional(), // the model's own answer, when a rule's floor or To file changed it
  model: z.string().optional(),
  promptVersion: z.string().optional(),
  policyVersion: z.string().optional(), // E14 (FR-15.1): the filing policy sent with the prompt
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

// todo (UX-5): lines for the Tasks note, built by code with no model call and no drafts budget.
export const ActionType = z.enum(['vault_note', 'confluence_entry', 'todo']);
export type ActionType = z.infer<typeof ActionType>;

export const ActionStatus = z.enum(['drafting', 'ready', 'approved', 'executing', 'done', 'failed', 'discarded']);
export type ActionStatus = z.infer<typeof ActionStatus>;

// amendment: why an action failed, so the UI can offer the right recovery.
// unreachable: the outbox gave up after repeated transient failures; draft_missing: the draft file was lost (FR-14.5, FR-14.7).
export const FailureReason = z.enum(['conflict', 'people_check', 'allow_list', 'no_fit', 'model_error', 'unreachable', 'draft_missing']);
export type FailureReason = z.infer<typeof FailureReason>;

/** The prompt and guidance files under config/ that Settings can edit (FR-1.7). */
export const PromptFileId = z.enum(['triage', 'filing-policy', 'tune-policy', 'topics', 'settle', 'finish', 'draft-vault', 'pick-confluence', 'draft-confluence', 'people-check', 'vault-conventions', 'confluence-routing']);
export type PromptFileId = z.infer<typeof PromptFileId>;

export const ActionTarget = z.object({
  path: z.string().optional(),
  paths: z.array(z.string()).optional(), // a vault draft that files into several notes (FR-9.7)
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
  markDoneWhenFiled: z.boolean().optional(), // approved in a batch: the item is done once all its filings are written (cockpit CK-4.4)
  quiet: z.boolean().optional(), // drafted ahead while filing in a batch: no macOS notification when it's ready (FR-11.6)
  failedWhile: z.enum(['drafting', 'writing']).optional(), // what it was doing when it failed: the bell says "draft failed" or "couldn't file" (FR-11.4)
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

/** A note or section that may already hold what a draft files (FR-9.6, FR-10.7). */
export const PossibleDuplicate = z.object({
  path: z.string().min(1).optional(),
  pageId: z.string().min(1).optional(),
  pageTitle: z.string().optional(),
  section: z.string().optional(),
  why: z.string(),
});
export type PossibleDuplicate = z.infer<typeof PossibleDuplicate>;

export const VaultNewDraft = DraftMeta.extend({
  kind: z.literal('vault_new'),
  path: z.string().min(1),
  content: z.string(),
  /** Notes the check found for the same source or meeting, when the draft still chose a new note (FR-9.6). */
  possibleDuplicates: z.array(PossibleDuplicate).optional(),
});
/** Nothing to file: the note at `path` already holds it (FR-9.6). Approving writes nothing. */
export const VaultFiledDraft = DraftMeta.extend({
  kind: z.literal('vault_filed'),
  path: z.string().min(1),
  why: z.string().min(1),
});
export const VaultAppendDraft = DraftMeta.extend({
  kind: z.literal('vault_append'),
  path: z.string().min(1),
  heading: z.string().min(1),
  context: z.array(z.string()), // existing lines shown above the insertion point
  content: z.string(),
});
/** One note of a draft that files into several (FR-9.7): an append under a heading, or a new note. */
export const VaultPart = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('append'), path: z.string().min(1), heading: z.string().min(1), context: z.array(z.string()), content: z.string(), edited: z.boolean().optional() }),
  z.object({ kind: z.literal('new'), path: z.string().min(1), content: z.string(), edited: z.boolean().optional() }),
]);
export type VaultPart = z.infer<typeof VaultPart>;
/**
 * A thread or meeting filed into several notes at once (FR-9.7): each fact under the topic note that
 * owns it, and a new note only for what fits nowhere. Approving writes every part, or none.
 */
export const VaultMultiDraft = DraftMeta.extend({
  kind: z.literal('vault_multi'),
  parts: z.array(VaultPart).min(2),
  /** As on a new note: when one of the parts is a new note beside a likely match (FR-9.6). */
  possibleDuplicates: z.array(PossibleDuplicate).optional(),
});
export const ConfluenceDraft = DraftMeta.extend({
  kind: z.literal('confluence'),
  pageId: z.string().min(1),
  pageTitle: z.string().min(1),
  /** The page's ancestors when it was picked from the catalogue (amendment: live catalogue). */
  ancestorIds: z.array(z.string()).optional(),
  section: z.string().min(1),
  baseVersion: z.number().int().positive(),
  title: z.string().min(1),
  content: z.string(),
  /** Sections that already hold this thread's link, when the draft still wrote an entry (FR-10.7). */
  possibleDuplicates: z.array(PossibleDuplicate).optional(),
});
/** To-do lines for the Tasks note (UX-5), built by code: model "code", no tokens. Approving appends them. */
export const TodoDraft = DraftMeta.extend({
  kind: z.literal('todo'),
  path: z.string().min(1),
  content: z.string(),
  /** E15 (FR-16.1): triage's deadline for each line by its task, so a To Do keeps the time, not just the 📅 date. */
  dues: z.record(z.string(), z.iso.datetime()).optional(),
});
/** Nothing to file: the page's section already holds it (FR-10.7). Approving writes nothing. */
export const ConfluenceFiledDraft = DraftMeta.extend({
  kind: z.literal('confluence_filed'),
  pageId: z.string().min(1),
  pageTitle: z.string().min(1),
  ancestorIds: z.array(z.string()).optional(),
  section: z.string().min(1),
  baseVersion: z.number().int().positive(),
  why: z.string().min(1),
});
export const Draft = z.discriminatedUnion('kind', [VaultNewDraft, VaultAppendDraft, VaultMultiDraft, VaultFiledDraft, ConfluenceDraft, ConfluenceFiledDraft, TodoDraft]);
export type Draft = z.infer<typeof Draft>;
export type VaultNewDraft = z.infer<typeof VaultNewDraft>;
export type VaultAppendDraft = z.infer<typeof VaultAppendDraft>;
export type VaultMultiDraft = z.infer<typeof VaultMultiDraft>;
export type VaultFiledDraft = z.infer<typeof VaultFiledDraft>;
export type ConfluenceDraft = z.infer<typeof ConfluenceDraft>;
export type ConfluenceFiledDraft = z.infer<typeof ConfluenceFiledDraft>;
export type TodoDraft = z.infer<typeof TodoDraft>;
/** A draft that files nothing: what it would file is already there (FR-9.6, FR-10.7). */
export const isFiledDraft = (d: Draft): d is VaultFiledDraft | ConfluenceFiledDraft => d.kind === 'vault_filed' || d.kind === 'confluence_filed';
/** Every note a vault draft writes, in order (FR-9.7). */
export const draftPaths = (d: VaultNewDraft | VaultAppendDraft | VaultMultiDraft | VaultFiledDraft): string[] => (d.kind === 'vault_multi' ? [...new Set(d.parts.map((p) => p.path))] : [d.path]);
/** Where an approved draft goes: the page and its version for Confluence, the note path (the first, and all of them for several) for the vault. */
export const draftTarget = (d: Draft): { pageId: string; baseVersion: number } | { path: string; paths?: string[] } =>
  'pageId' in d ? { pageId: d.pageId, baseVersion: d.baseVersion } : d.kind === 'vault_multi' ? { path: d.parts[0].path, paths: draftPaths(d) } : { path: d.path };

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
  // To file: the model still reads the thread (summary, where to file it), but attention is
  // None and at least one filing destination is suggested, so the item lands in To file.
  // predraft (FR-15.2): its filings are drafted ahead, whatever the policy says.
  z.object({ type: z.literal('file'), predraft: z.boolean().optional() }),
]);
export type RuleOutcome = z.infer<typeof RuleOutcome>;

/** The sources each condition can be checked on. Email has no channels, DMs or `<@id>` mentions. */
export const CONDITION_SOURCES: Record<RuleCondition['type'], readonly SourceId[]> = {
  sender_in: SourceId.options,
  keyword: SourceId.options,
  channel_in: ['slack', 'teams'],
  mentions_me: ['slack', 'teams'],
  is_dm: ['slack', 'teams'],
};

/** The sources a rule can match: its own scope (every source when unset), narrowed to where all its conditions apply. */
export function ruleSources(rule: { sources?: SourceId[]; conditions: { type: RuleCondition['type'] }[] }): SourceId[] {
  const scope = rule.sources?.length ? rule.sources : SourceId.options;
  return scope.filter((src) => rule.conditions.every((c) => CONDITION_SOURCES[c.type].includes(src)));
}

export const Rule = z
  .object({
    id: z
      .string()
      .min(1, 'Give the rule an id')
      .regex(/^[a-z0-9-]+$/, 'Use lower-case letters, digits and hyphens'),
    enabled: z.boolean(),
    sources: z.array(SourceId).optional(), // amendment (sources): unset or empty means every source
    conditions: z.array(RuleCondition).min(1, 'Add at least one condition'),
    outcome: RuleOutcome,
  })
  .superRefine((r, ctx) => {
    if (r.conditions.length && ruleSources(r).length === 0) {
      ctx.addIssue({ code: 'custom', path: ['sources'], message: 'None of the chosen sources supports every condition' });
    }
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

// haiku-4.5 stays readable for usage and eval records made on it; new calls use haiku-5.5.
export const ModelId = z.enum(['haiku-4.5', 'haiku-5.5', 'sonnet-5.5', 'opus-5.5']);
export type ModelId = z.infer<typeof ModelId>;

/** The models Settings offers. A settings file from before Haiku 5.5 loads with haiku-5.5. */
const SettingsModelId = z.preprocess((v) => (v === 'haiku-4.5' ? 'haiku-5.5' : v), ModelId);

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

/**
 * The claude.ai Microsoft 365 connector (R2.5): its server id, as mcpServerStatus() reports it (not a
 * secret; it goes into the proxy URL), and the account it reads, from get_me when it was connected.
 */
export const Ms365Connector = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, 'Enter the connector id, e.g. mcpsrv_01…'),
  account: z.object({ name: z.string(), address: z.string().min(1), upn: z.string().optional() }).optional(),
});
export type Ms365Connector = z.infer<typeof Ms365Connector>;

export const ConfluencePage = z.object({
  title: z.string().min(1, 'Enter a page title'),
  id: z.string().regex(/^\d{5,12}$/, 'Page IDs are 5–12 digits'),
});
export type ConfluencePage = z.infer<typeof ConfluencePage>;

export const ConfluenceLabel = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,254}$/, 'Labels are lower case, without spaces');

/** The PSG context tree in the PRD space, from the psg-context-builder skill (FR-10.2). */
export const CONFLUENCE_SCOPE_DEFAULTS: { roots: ConfluencePage[]; labels: string[]; exclude: ConfluencePage[] } = {
  roots: [
    { id: '3031007299', title: 'Data Products (DP)' },
    { id: '3031138405', title: 'Safety & Operations (S&O)' },
    { id: '3031007314', title: 'Maritime Risk & Compliance (MR&C)' },
    { id: '3031236721', title: 'Global Government Services (GGS)' },
    { id: '3463184414', title: 'Insurance (INS)' },
    { id: '3462955031', title: 'Defence (DEF)' },
    { id: '3463184434', title: 'Organisation-wide (ORG)' },
    { id: '3032186889', title: 'UX Principles' },
    { id: '3261104200', title: 'Competitor Profiles' },
    { id: '3260940434', title: 'Glossary & Taxonomy' },
    { id: '3187900417', title: 'Company Strategic & Commercial Context' },
  ],
  labels: ['psg-shared-competitors', 'psg-shared-strategy', 'psg-shared-glossary', 'psg-shared-data-assets', 'psg-shared-resources', 'psg-shared-ux'],
  exclude: [
    { id: '3215425626', title: 'Never-write page (psg-context-builder)' },
    { id: '3032842242', title: 'Meridia Context (index)' },
    { id: '3157229580', title: 'Archive' },
  ],
};

export const Settings = z.object({
  dataDir: z.string().min(1),
  slack: z.object({
    fetchMode: z.enum(['search', 'history']),
    includeChannels: z.array(z.string()),
    excludeChannels: z.array(z.string()),
    customerChannels: z.array(z.string()),
    openLinksIn: z.enum(['browser', 'app']).optional(), // amendment: where Open in Slack goes; browser when unset
    appChannels: z.array(z.string()).optional(), // amendment: channels whose app posts (Gong, say) are read; dropped elsewhere (FR-2.10)
  }),
  // Amendment (sources): who matters on every source, matched by name. Was `slack.vips`; see upgradeSettings.
  people: z.object({
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
    // Amendment (cockpit CK-2.7): whether a settle check that finds Frank's reply settles every ask
    // closes the item, and on which sources the check runs. See closeOnReply().
    closeOnReply: z.object({ enabled: z.boolean(), sources: z.partialRecord(SourceId, z.boolean()) }).optional(),
    // Amendment (cockpit CK-2.10): on which sources a topic that waited on Frank, and that later
    // messages settled, is suggested as "Looks finished". See suggestFinished().
    suggestFinished: z.object({ sources: z.partialRecord(SourceId, z.boolean()) }).optional(),
    // E14 (FR-15.3, FR-15.5, FR-15.6): what the filing policy may do. See filingSettings().
    filing: z.object({ predraft: z.enum(['policy', 'all', 'off']), ready: z.boolean(), todoSuggestions: z.boolean() }).optional(),
  }),
  models: z.object({
    triage: SettingsModelId,
    draftVault: SettingsModelId,
    draftConfluence: SettingsModelId,
    routing: SettingsModelId.optional(), // amendment (topics): Haiku when unset
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
  // UX-5: the note in the vault that to-dos are appended to, as Obsidian Tasks lines. Missing in older files: the default.
  tasksNote: z.string().trim().regex(/^[^/.][\s\S]*\.md$/, 'Enter a note path in the vault, such as Work/Tasks.md').default('Work/Tasks.md'),
  confluence: z.object({
    siteUrl: z.url({ protocol: /^https$/, error: 'Enter the https:// address of your Confluence site' }), // amendment: links to pages
    spaceKey: z.string().regex(/^[A-Za-z0-9~][A-Za-z0-9_~-]*$/, 'Enter a space key, e.g. PRD'),
    // Amendment (live catalogue): every page below a root, or with one of the labels, is in
    // scope, minus the excluded pages and everything under them; `pages` adds single pages.
    // Missing in older files: filled with the PSG defaults.
    roots: z.array(ConfluencePage).default(CONFLUENCE_SCOPE_DEFAULTS.roots),
    labels: z.array(ConfluenceLabel).default(CONFLUENCE_SCOPE_DEFAULTS.labels),
    exclude: z.array(ConfluencePage).default(CONFLUENCE_SCOPE_DEFAULTS.exclude),
    pages: z.array(ConfluencePage),
  }),
  notifications: z.object({
    enabled: z.boolean(),
    quietHours: timeRange,
    // Amendment (R2.8): how long before a meeting the sidebar and agenda show it as next; 5 when unset.
    meetingLeadMinutes: z.number().int('Whole minutes only').min(1, 'At least 1 minute').max(30, 'At most 30 minutes').optional(),
  }),
  dryRun: z.boolean(),
  sources: z.partialRecord(SourceId, SourceSchedule.partial()).optional(),
  // Amendment (Outlook, R2.5): the claude.ai connectors the relay reads through, shared by every
  // source on them. Set by Settings › Sources › Outlook, never typed into the settings form.
  connectors: z.object({ ms365: Ms365Connector.optional() }).optional(),
  // Amendment (R2.8): the colour Frank gives each Outlook category, by name. The connector can't
  // read the colours Outlook has for them.
  calendar: z.object({ categoryColors: z.record(z.string().min(1), OutlookColor) }).optional(),
  schemaVersion: z.literal(1),
});
export type Settings = z.infer<typeof Settings>;

/**
 * Brings a settings file written by an older version up to the current shape, still at
 * schemaVersion 1: `slack.vips` moves to `people.vips`. The next save writes the new shape.
 */
export function upgradeSettings(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const s = raw as Record<string, unknown> & { slack?: Record<string, unknown> };
  if (s.people !== undefined || !s.slack || !('vips' in s.slack)) return raw;
  const { vips, ...slack } = s.slack;
  return { ...s, slack, people: { vips } };
}

/** What `settings.json` is read with: the upgrade, then the schema. */
export const SettingsFile = z.preprocess(upgradeSettings, Settings);

const SOURCE_DEFAULTS: Record<SourceId, SourceSchedule> = {
  slack: { enabled: true, intervalWorkMinutes: 10, intervalOffMinutes: 60 },
  outlook: { enabled: false, intervalWorkMinutes: 30, intervalOffMinutes: 120 },
  teams: { enabled: false, intervalWorkMinutes: 30, intervalOffMinutes: 120 },
  plaud: { enabled: false, intervalWorkMinutes: 180, intervalOffMinutes: null },
  wispr: { enabled: false, intervalWorkMinutes: 180, intervalOffMinutes: null },
  calendar: { enabled: false, intervalWorkMinutes: 30, intervalOffMinutes: 120 },
};

/** A source's schedule with defaults filled in. Slack's defaults are the global schedule. */
/** Minutes before a meeting that it shows as next (R2.8). */
export const MEETING_LEAD_DEFAULT = 5;
export const meetingLead = (s: Pick<Settings, 'notifications'>) => s.notifications.meetingLeadMinutes ?? MEETING_LEAD_DEFAULT;

export function sourceSchedule(settings: Pick<Settings, 'schedule' | 'sources'>, id: SourceId): SourceSchedule {
  const base =
    id === 'slack'
      ? { enabled: true, intervalWorkMinutes: settings.schedule.intervalWorkMinutes, intervalOffMinutes: settings.schedule.intervalOffMinutes }
      : SOURCE_DEFAULTS[id];
  return { ...base, ...settings.sources?.[id] };
}

/** The minutes between a source's polls at `at` (work or off hours); undefined when it doesn't poll then. */
export function pollIntervalMinutes(settings: Pick<Settings, 'schedule' | 'sources'>, id: SourceId, at: Date | string): number | undefined {
  const s = sourceSchedule(settings, id);
  if (!s.enabled) return undefined;
  return (isWorkHours(at, settings.schedule.workHours) ? s.intervalWorkMinutes : s.intervalOffMinutes) ?? undefined;
}

// ---------- Usage (CL-5) and eval (FR-6.x) ----------

export const UsagePurpose = z.enum(['triage', 'draft_vault', 'confluence_pick', 'draft_confluence', 'people_check', 'eval', 'startup_check', 'fetch', 'routing', 'settle', 'tune']); // tune: a proposed filing policy (FR-15.9); fetch: connector relay (CL-9); routing: topics; confluence_pick: the page picker before a Confluence draft; settle: whether Frank's reply settles an item (cockpit CK-2.2)
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
const EMPTY_PR = { precision: 0, recall: 0, support: 0 };
const Count = z.number().int().nonnegative();

/**
 * rows = labelled, columns = predicted, in ATTENTION_ORDER. A report saved before Waiting on others
 * (3×3: now, today, none) is read with an empty follow row and column, so scores compare across it.
 */
const Confusion = z
  .union([z.array(z.array(Count).length(4)).length(4), z.array(z.array(Count).length(3)).length(3)])
  .transform((c) => (c.length === 4 ? c : [...c.slice(0, 2), [0, 0, 0], c[2]].map((row) => [row[0], row[1], 0, row[2]])));

const EvalCategories = z.object({ now: PR, today: PR, follow: PR.default(EMPTY_PR), none: PR, confluence: PR, vault: PR });

export const EvalReport = z.object({
  id: z.string().min(1),
  at: isoDate,
  labelCount: z.number().int().positive(),
  promptVersion: z.string(),
  policyVersion: z.string().optional(), // E14 (FR-15.1): the filing policy sent with the prompt
  model: ModelId,
  categories: EvalCategories,
  confusion: Confusion,
  tokens: z.number().int().nonnegative(),
  costEquivalent: z.number().nonnegative(),
  /** Labelled threads the model gave no usable answer for; not in the scores. */
  failed: z.number().int().nonnegative().optional(),
  /** Amendment (R2.2): the same scores for each source's labels, when there are labels from several. */
  bySource: z.partialRecord(SourceId, z.object({ labelCount: z.number().int().positive(), categories: EvalCategories, confusion: Confusion })).optional(),
  /** Amendment (R2.2): the eval ran on this source's labels only. */
  source: SourceId.optional(),
});
export type EvalReport = z.infer<typeof EvalReport>;
/** A report as saved, before reading fills in what older ones lack. */
export type EvalReportInput = z.input<typeof EvalReport>;

// ---------------------------------------------------------------- filing eval (E14, FR-15.8)

/** A field's score counts once this many of its values are labelled (FR-15.8). */
export const FILING_EVAL_MIN_LABELS = 30;
/** Precision each stage must reach before it is trusted more (FR-15.8). */
export const FILING_TARGETS = { toFile: 0.85, predraft: 0.8, ready: 0.95, todo: 0.95 } as const;
export type FilingDimension = keyof typeof FILING_TARGETS;

/** One dimension: `n` labelled values, `support` of them true, `predicted` true by the policy. */
const FilingScore = z.object({
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1),
  support: z.number().int().nonnegative(),
  predicted: z.number().int().nonnegative(),
  n: z.number().int().nonnegative(),
});
export type FilingScore = z.infer<typeof FilingScore>;
export const FilingScores = z.object({ toFile: FilingScore, predraft: FilingScore, ready: FilingScore, todo: FilingScore });
export type FilingScores = z.infer<typeof FilingScores>;

export const FilingEvalReport = z.object({
  id: z.string().min(1),
  at: isoDate,
  /** Labelled items scored or failed. */
  labelCount: z.number().int().positive(),
  promptVersion: z.string(),
  policyVersion: z.string().optional(),
  model: ModelId,
  scores: FilingScores,
  /** The same, from Frank's word alone and from what his actions said. */
  byOrigin: z.object({ explicit: FilingScores, implicit: FilingScores }),
  bySource: z.partialRecord(SourceId, z.object({ labelCount: z.number().int().positive(), scores: FilingScores })).optional(),
  tokens: z.number().int().nonnegative(),
  costEquivalent: z.number().nonnegative(),
  failed: z.number().int().nonnegative().optional(),
});
export type FilingEvalReport = z.infer<typeof FilingEvalReport>;

// ---------------------------------------------------------------- settle check (cockpit CK-2.2)

/**
 * Whether Frank's reply settles an item's open asks, one decision per item. `index` is the ask's
 * place in the list the prompt gave (0 first). `why` stays with the item's content, never in the log.
 */
export const SettleDecision = z.object({
  itemId: z.string().min(1),
  itemRevision: z.number().int().positive(),
  asks: z.array(z.object({ index: z.number().int().nonnegative(), settled: z.boolean(), why: z.string().min(1).max(300) })).min(1),
  allSettled: z.boolean(),
  // He handed what is open on to someone else but still owns the outcome (FR-8.1, amended).
  handedOn: z.boolean().optional(),
});
export type SettleDecision = z.infer<typeof SettleDecision>;

export const SettleBatchOutput = z.object({ decisions: z.array(SettleDecision) });
export type SettleBatchOutput = z.infer<typeof SettleBatchOutput>;

/** A check gives up on a reply after this many failures; the item stays as it is (CK-2.3). */
export const SETTLE_MAX_ATTEMPTS = 3;

/**
 * Closing on reply (CK-2.7, CK-2.9): on by default; the check runs on Slack, and on Outlook once
 * Frank turns it on there. With `enabled` off the check still runs, and the row asks "Mark done?".
 */
export function closeOnReply(settings: Pick<Settings, 'triage'>): { enabled: boolean; sources: Record<SourceId, boolean> } {
  const c = settings.triage.closeOnReply;
  const sources = Object.fromEntries(SourceId.options.map((id) => [id, c?.sources[id] ?? id === 'slack'])) as Record<SourceId, boolean>;
  return { enabled: c?.enabled ?? true, sources };
}

/** "Looks finished" (CK-2.10): suggested on Slack by default, and on Outlook once Frank turns it on. */
export type FilingSettings = NonNullable<Settings['triage']['filing']>;
export const DEFAULT_FILING: FilingSettings = { predraft: 'policy', ready: true, todoSuggestions: true };
export function filingSettings(settings: Pick<Settings, 'triage'>): FilingSettings {
  return { ...DEFAULT_FILING, ...settings.triage.filing };
}
export function suggestFinished(settings: Pick<Settings, 'triage'>): Record<SourceId, boolean> {
  const c = settings.triage.suggestFinished;
  return Object.fromEntries(SourceId.options.map((id) => [id, c?.sources[id] ?? id === 'slack'])) as Record<SourceId, boolean>;
}

/** Whether Frank's reply can close an item from this source by itself (CK-2.5). */
export const closesOnReply = (settings: Pick<Settings, 'triage'>, source: SourceId) => {
  const c = closeOnReply(settings);
  return c.enabled && c.sources[source];
};
