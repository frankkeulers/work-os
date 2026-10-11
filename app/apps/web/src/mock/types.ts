import type {
  Action,
  Attention,
  Draft,
  EvalReport,
  Item,
  ItemFlags,
  NextStep,
  PollStatus,
  PromptFileId,
  Rule,
  Settings,
  SlackStatus,
  StartupFailure,
  TriageDecision,
  UsageRecord,
  VaultPart,
  WorkEvent,
} from '@work-os/shared';

// Mock-only types. Nothing outside src/mock and src/scenarios imports these.

export interface ScriptedDecision {
  attention: Attention;
  confluence?: string; // target hint; present means suggested
  vault?: string;
  people?: boolean; // containsPeopleObservations
  summary: string;
  reason: string;
  next?: NextStep; // what the model says to do next (Inbox redesign)
}

export type VaultTemplate =
  | { kind: 'vault_new'; path: string; content: string }
  | { kind: 'vault_append'; path: string; heading: string; context: string[]; content: string }
  | { kind: 'vault_multi'; parts: VaultPart[] };

export interface ConfluenceTemplate {
  pageId: string;
  pageTitle: string;
  section: string;
  baseVersion: number;
  title: string;
  content: string;
}

export interface DraftTemplates {
  vault?: VaultTemplate;
  confluence?: ConfluenceTemplate;
}

export interface SeedMessage {
  by: string; // person id
  minsAgo: number; // relative to the seed clock
  text: string;
  to?: string[]; // an email's recipients, by person id
  cc?: string[];
}

export interface ThreadSeed {
  key: string;
  source?: 'outlook' | 'teams' | 'wispr' | 'calendar'; // default Slack. Teams is a P2 source, shown in Full scope.
  channelId: string; // Slack channel, or a mailbox folder / Teams chat for the P2 sources
  kind: 'thread' | 'dm' | 'email' | 'meeting' | 'chat' | 'event';
  title: string;
  messages: SeedMessage[];
  messageCount?: number;
  decision: ScriptedDecision;
  failTriage?: number; // how many triage attempts return invalid output (CL-7)
  drafts?: DraftTemplates;
  thread?: boolean; // a Slack thread with replies (topics), not a stretch of DM chat
  topic?: string; // routing puts this piece in that seed's topic
  regroupWith?: string; // on its own until Regroup merges it into that seed's topic
  meeting?: Item['meeting']; // a meeting's time and its calendar event (R2.8)
}

export interface ReplySeed {
  targetKey: string;
  by: string;
  text: string;
  decision?: Partial<ScriptedDecision>; // how the re-triage changes, if at all
  looksFinished?: string; // the finish check after the re-triage finds the asks settled, and why (cockpit CK-2.10)
}

export type DraftOutcome = 'normal' | 'vault_conflict' | 'confluence_conflict' | 'people_check' | 'allow_list' | 'no_fit' | 'model_error' | 'already_filed' | 'possible_duplicate';

/** An item with the server's inbox flags (shared projection), plus the mock's own script. */
export interface ItemRec extends ItemFlags<TriageDecision> {
  key: string;
  item: Item;
  arrivedAt: string;
  script: ScriptedDecision;
  failTriage: number;
  drafts?: DraftTemplates;
  batch?: { at: string; threads: number; calls: number };
  topicKey?: string; // ThreadSeed.topic
  regroupKey?: string; // ThreadSeed.regroupWith
  settleWhy?: string; // the last settle check's reason an ask is still open (cockpit CK-2.3)
  finishWhy?: string; // what settled it, while it looks finished (cockpit CK-2.10)
  finishOnTriage?: string; // the finish check's why, once the next model triage runs (cockpit CK-2.10)
}

export interface TimelineEntry {
  at: string;
  thread?: ThreadSeed;
  reply?: ReplySeed;
}

export interface MockFlags {
  forceTriageBudget: boolean;
  forceDraftBudget: boolean;
  connection: 'up' | 'down' | 'reconnecting';
  startupFailure?: StartupFailure;
  fileVaultOff: boolean;
  firstRun: boolean;
  rebuiltNotice?: string;
  /** The server's state for the health pill (cockpit CK-1.7); unset: running normally. */
  health?: MockHealth;
}

/** stale: the server has quietly stopped polling; ms365: the Microsoft 365 connector needs signing in again. */
export type MockHealth = 'catching_up' | 'stopping' | 'safe' | 'stale' | 'ms365';

export interface MockState {
  schemaVersion: number;
  clock: string;
  items: Record<string, ItemRec>;
  actions: Record<string, Action>;
  drafts: Record<string, Draft>;
  results: Record<string, string>;
  events: WorkEvent[];
  usage: UsageRecord[];
  evals: EvalReport[];
  settings: Settings;
  rules: Rule[];
  ruleHits: Record<string, number>;
  /** Prompt files Frank has saved in Settings › Prompts; absent ones serve the seed default. */
  prompts?: Partial<Record<PromptFileId, string>>;
  /** Prompt files marked reviewed: their sources read as current. */
  reviewedPrompts?: PromptFileId[];
  savedAt: string;
  checkedAt: string;
  labelCount: number;
  correctionCount: number;
  source: {
    status: SlackStatus;
    lastPollAt?: string;
    nextPollAt?: string;
    retryAt?: string;
    rateLimitedToday: number;
    cursor?: string;
  };
  poll: PollStatus;
  /** Settings › Sources › Wispr Flow (R2.7). Unset: never connected. `read`: its meeting has arrived. */
  wispr?: { connected: boolean; account?: string; read?: boolean };
  /** Settings › Sources › Outlook (R2.5). Unset: never connected. `read`: its mail has arrived. */
  outlook?: { connectorId: string; account: { name: string; address: string }; read?: boolean; calendarRead?: boolean };
  pollsSkippedToday: number;
  timeline: TimelineEntry[];
  firstRunSeeds: ThreadSeed[];
  flags: MockFlags;
  nextDraftOutcome: DraftOutcome;
  evalRunning: boolean;
  seq: number;
  /** The bell's dismissed entries (FR-11.5): key → when. */
  dismissed?: Record<string, string>;
}
