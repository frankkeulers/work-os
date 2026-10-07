import type { DepId, DepState, PollReason } from './events';
import type { EffectiveTriage, ItemStatus, Lane, TriageState } from './lanes';
import type {
  Action,
  ActionType,
  Attention,
  Draft,
  EvalReport,
  FailureReason,
  Item,
  ItemKind,
  Message,
  ModelId,
  NextStep,
  Participant,
  Rule,
  SourceId,
  Settings,
  TriageCorrection,
  TriageDecision,
  UsagePurpose,
} from './schemas';

// The contract between the web app and the backend, shared by both. Queries and commands map
// 1:1 to REST routes on the Fastify server; subscribe() stands in for the SSE stream (FR-3.2).

export interface ActionSummary {
  id: string;
  type: ActionType;
  status: Action['status'];
  failureReason?: FailureReason;
  stale: boolean; // drafted from an older revision than the item has now
}

export interface ItemSummary {
  id: string;
  source: SourceId;
  kind: ItemKind;
  title: string;
  permalink: string;
  /** Where Open in Slack goes: the web client or the permalink, per settings. Absent in the mock. */
  openUrl?: string;
  lastActivityAt: string;
  revision: number;
  lane: Lane;
  status: ItemStatus;
  triageState: TriageState;
  summary: string;
  reason?: string;
  next?: NextStep; // the model's suggested next step (amendment)
  triage?: EffectiveTriage;
  correctedFrom?: Attention; // shown when a re-triage replaced Frank's correction
  containsPeopleObservations: boolean;
  targetHints: { confluence?: string; vault?: string };
  actions: Partial<Record<ActionType, ActionSummary>>; // latest action per type
  newReplies: boolean; // new messages since the last triage
  backFromSnooze: boolean;
  modelPaused: boolean; // waiting for model triage while the budget is hit
  snoozedUntil?: string;
  quietUntil?: string; // when a waiting thread becomes eligible for triage
  doneAt?: string;
}

export type PollPhase = 'idle' | 'polling' | 'triaging';

export interface PollStatus {
  phase: PollPhase;
  triagingCount?: number;
  reason?: PollReason;
  lastPollAt?: string;
  nextPollAt?: string;
  lastResult?: { at: string; fetched: number; triaged: number; calls: number; reason: PollStatus['reason'] };
}

// offline: no network, not a source failure (FR-2.9); degraded: reachable but failing; paused: settings invalid or safe mode.
export type SlackStatus = 'healthy' | 'backoff' | 'auth_failed' | 'never' | 'offline' | 'degraded' | 'paused';

export interface SourceHealth {
  id: SourceId;
  status: SlackStatus;
  mode: Settings['slack']['fetchMode'];
  lastPollAt?: string;
  nextPollAt?: string;
  retryAt?: string;
  rateLimitedToday: number;
  cursor?: string;
  message?: string;
}

export interface BudgetLine {
  used: number;
  limit: number;
  hit: boolean;
}

export interface BudgetState {
  triage: BudgetLine;
  drafts: BudgetLine;
  cost: BudgetLine;
  baseline: number | null;
  pctOfBaseline: number | null;
}

export interface InboxView {
  items: ItemSummary[];
  poll: PollStatus;
  source: SourceHealth; // Slack, until the UI shows several sources
  sources: SourceHealth[]; // every enabled source (R2.1)
  budgets: BudgetState;
  dryRun: boolean;
  notices: { rebuilt?: string; fileVaultOff: boolean };
  labelCount: number;
  firstRun: boolean;
  workHours: boolean;
}

export interface DraftProgress {
  stages: string[];
  stage: number; // index of the running stage
  startedAt: number; // epoch ms, real time (drives the elapsed counter)
}

export interface ItemView {
  summary: ItemSummary;
  item: Item;
  decision?: TriageDecision;
  correction?: TriageCorrection;
  batch?: { at: string; threads: number; calls: number };
  actions: Action[]; // newest first
  drafts: Record<string, Draft>; // by action id
  progress: Record<string, DraftProgress>; // by action id, while drafting
  results: Record<string, string>; // by action id, outcome message after execution or failure
  allowListedPageIds: string[];
  dryRun: boolean;
  dataDir: string;
  /** Where approved actions write, for links to the Confluence page and the Obsidian note. */
  targets: { confluenceSite: string; spaceKey: string; vaultPath: string };
  budgets: BudgetState;
  meId: string; // the signed-in Slack user, shown as "You"
  /** Everyone in a DM or group DM, from the source; absent when it can't say. */
  members?: Participant[];
}

/** The messages just before a DM item, read live from the source and never stored. Oldest first. */
export interface EarlierView {
  messages: Message[];
  people: Participant[]; // names for their authors and mentions
}

export interface UsageRow {
  purpose: UsagePurpose;
  model: ModelId;
  calls: number;
  tokens: number;
  costEquivalent: number;
}

export interface Criterion {
  id: string;
  name: string;
  value: string;
  target: string;
  status: 'on_track' | 'met' | 'at_risk' | 'pending';
  statusLabel: string;
}

export interface UsageView {
  today: {
    costEquivalent: number;
    pctOfBaseline: number | null;
    triageCalls: number;
    threadsTriaged: number;
    pollsSkipped: number;
    draftsVault: number;
    draftsConfluence: number;
    tokens: { input: number; output: number; cache: number; total: number };
  };
  days: { date: string; label: string; triage: number; drafts: number }[];
  budgets: BudgetState;
  byPurpose: UsageRow[];
  source: SourceHealth;
  criteria: Criterion[];
  lastEval?: EvalReport;
  evalRunning: boolean;
}

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface StartupCheck {
  id: 'filevault' | 'api_key' | 'slack_token' | 'claude_login' | 'settings' | 'keychain' | 'power_nap';
  label: string;
  status: CheckStatus;
  note: string;
}

export interface SettingsView {
  settings: Settings;
  rules: Rule[];
  ruleHits: Record<string, number>;
  savedAt: string;
  checks: StartupCheck[];
  checkedAt: string;
  labelCount: number;
  correctionCount: number;
  vaultConventionsLoaded: boolean;
}

export type StartupFailure = 'api_key' | 'slack_token' | 'claude_login';

/** Health of one dependency (FR-14.6). */
export interface DependencyHealth {
  id: DepId;
  state: DepState;
  since: string;
  lastOkAt?: string;
  retryAt?: string;
  failures: number;
  reason?: string; // e.g. captive_portal, schema_changed
  fix?: string; // what Frank can do about it
}

export interface HealthView {
  connection: 'up' | 'down' | 'reconnecting'; // the UI's link to the server
  startupFailure?: StartupFailure; // blocking screen; only api_key once the server exists (CL-2)
  mode: 'normal' | 'degraded' | 'safe';
  phase: 'running' | 'waking' | 'catching_up' | 'stopping';
  lastWakeAt?: string;
  deps: DependencyHealth[];
  checks: StartupCheck[];
  checkedAt: string;
  nextCheckAt?: string;
  outbox: { approved: number; waiting: number; oldestAt?: string }; // approved writes not yet applied (FR-14.5)
  instance: 'prod' | 'dev' | 'mock';
  version: string;
  startedAt: string;
}

export type Notice =
  | { topic: 'inbox' }
  | { topic: 'item'; id: string }
  | { topic: 'usage' }
  | { topic: 'settings' }
  | { topic: 'evals' }
  | { topic: 'health' }
  | { topic: 'clock' }
  | { topic: 'notification'; itemId: string; title: string; summary: string }
  | { topic: 'draft_ready'; itemId: string; actionId: string; type: ActionType; title: string };

export interface CorrectionInput {
  attention: Attention;
  confluence: boolean;
  vault: boolean;
}

export interface WorkOsApi {
  /** Server time. The real client returns the local clock; the mock returns its simulated clock. */
  now(): Date;

  getHealth(): Promise<HealthView>;
  /** Re-runs the startup checks and dependency probes now (FR-12.2). */
  recheck(): Promise<void>;
  getInbox(): Promise<InboxView>;
  getItem(id: string): Promise<ItemView>;
  /** The conversation before a DM item (empty for threads, or when the source can't say). */
  getEarlier(id: string): Promise<EarlierView>;
  getUsage(): Promise<UsageView>;
  getEvalReports(): Promise<EvalReport[]>;
  getSettings(): Promise<SettingsView>;

  pollNow(): Promise<void>;
  markDone(itemId: string): Promise<void>;
  reopen(itemId: string): Promise<void>;
  /** Marks many items done in one write; returns how many changed (items already done are skipped). */
  markDoneMany(itemIds: string[]): Promise<{ count: number }>;
  /** Undo for markDoneMany. */
  reopenMany(itemIds: string[]): Promise<{ count: number }>;
  snooze(itemId: string, untilIso: string): Promise<void>;
  correctTriage(itemId: string, input: CorrectionInput): Promise<{ labelCount: number }>;
  retryTriage(itemId: string): Promise<void>;

  requestDraft(itemId: string, type: ActionType): Promise<Action>;
  cancelDraft(actionId: string): Promise<void>;
  saveDraftEdit(actionId: string, content: string): Promise<void>;
  redraft(actionId: string): Promise<Action>;
  discardAction(actionId: string): Promise<void>;
  approveAction(actionId: string): Promise<void>;

  runEval(): Promise<void>;
  rebuildState(): Promise<{ events: number }>;
  saveSettings(settings: Settings, rules: Rule[]): Promise<{ savedAt: string }>;

  subscribe(onNotice: (n: Notice) => void): () => void;
}
