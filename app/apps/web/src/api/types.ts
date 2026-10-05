import type {
  Action,
  ActionType,
  Attention,
  Draft,
  EffectiveTriage,
  EvalReport,
  FailureReason,
  Item,
  ItemKind,
  ItemStatus,
  Lane,
  ModelId,
  Rule,
  Settings,
  TriageCorrection,
  TriageDecision,
  TriageState,
  UsagePurpose,
} from '@work-os/shared';

// The contract between the web app and the backend. Queries and commands map 1:1 to REST
// routes on the future Fastify server; subscribe() stands in for the SSE stream (FR-3.2).

export interface ActionSummary {
  id: string;
  type: ActionType;
  status: Action['status'];
  failureReason?: FailureReason;
  stale: boolean; // drafted from an older revision than the item has now
}

export interface ItemSummary {
  id: string;
  kind: ItemKind;
  title: string;
  permalink: string;
  lastActivityAt: string;
  revision: number;
  lane: Lane;
  status: ItemStatus;
  triageState: TriageState;
  summary: string;
  reason?: string;
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
  reason?: 'manual' | 'scheduled' | 'wake' | 'first';
  lastPollAt?: string;
  nextPollAt?: string;
  lastResult?: { at: string; fetched: number; triaged: number; calls: number; reason: PollStatus['reason'] };
}

export type SlackStatus = 'healthy' | 'backoff' | 'auth_failed' | 'never';

export interface SourceHealth {
  id: 'slack';
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
  source: SourceHealth;
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
  budgets: BudgetState;
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
  id: 'filevault' | 'api_key' | 'slack_token' | 'claude_login';
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

export interface HealthView {
  connection: 'up' | 'down' | 'reconnecting';
  startupFailure?: StartupFailure;
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
  getInbox(): Promise<InboxView>;
  getItem(id: string): Promise<ItemView>;
  getUsage(): Promise<UsageView>;
  getEvalReports(): Promise<EvalReport[]>;
  getSettings(): Promise<SettingsView>;

  pollNow(): Promise<void>;
  markDone(itemId: string): Promise<void>;
  reopen(itemId: string): Promise<void>;
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
