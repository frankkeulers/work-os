import type {
  Action,
  Attention,
  Draft,
  EvalReport,
  Item,
  ItemStatus,
  Rule,
  Settings,
  TriageCorrection,
  TriageDecision,
  TriageState,
  UsageRecord,
  WorkEvent,
} from '@work-os/shared';
import type { PollStatus, SlackStatus, StartupFailure } from '../api/types';

// Mock-only types. Nothing outside src/mock and src/scenarios imports these.

export interface ScriptedDecision {
  attention: Attention;
  confluence?: string; // target hint; present means suggested
  vault?: string;
  people?: boolean; // containsPeopleObservations
  summary: string;
  reason: string;
}

export type VaultTemplate =
  | { kind: 'vault_new'; path: string; content: string }
  | { kind: 'vault_append'; path: string; heading: string; context: string[]; content: string };

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
}

export interface ThreadSeed {
  key: string;
  channelId: string;
  kind: 'thread' | 'dm';
  title: string;
  messages: SeedMessage[];
  messageCount?: number;
  decision: ScriptedDecision;
  failTriage?: number; // how many triage attempts return invalid output (CL-7)
  drafts?: DraftTemplates;
}

export interface ReplySeed {
  targetKey: string;
  by: string;
  text: string;
  decision?: Partial<ScriptedDecision>; // how the re-triage changes, if at all
}

export type DraftOutcome = 'normal' | 'vault_conflict' | 'confluence_conflict' | 'people_check' | 'allow_list' | 'model_error';

export interface ItemRec {
  key: string;
  item: Item;
  status: ItemStatus;
  triageState: TriageState;
  decision?: TriageDecision;
  correction?: TriageCorrection;
  correctedFrom?: Attention;
  snoozedUntil?: string;
  doneAt?: string;
  newReplies: boolean;
  backFromSnooze: boolean;
  failCount: number;
  notified: boolean;
  arrivedAt: string;
  script: ScriptedDecision;
  failTriage: number;
  drafts?: DraftTemplates;
  batch?: { at: string; threads: number; calls: number };
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
}

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
  pollsSkippedToday: number;
  timeline: TimelineEntry[];
  firstRunSeeds: ThreadSeed[];
  flags: MockFlags;
  nextDraftOutcome: DraftOutcome;
  evalRunning: boolean;
  seq: number;
}
