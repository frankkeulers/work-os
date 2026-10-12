import type { CategoryTag } from './categories';
import type { DepId, DepState, PollReason } from './events';
import type { EffectiveTriage, ItemStatus, Lane, TriageState } from './lanes';
import type { FilingPlans } from './policy';
import type { FilingFeedbackBody } from './requests';
import type { DoneBy } from './projection/state';
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
  PromptFileId,
  Rule,
  SourceId,
  Settings,
  TodoSuggestion,
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
  failedWhile?: 'drafting' | 'writing'; // a failed write shows as "Not written", with Retry write
  stale: boolean; // a ready draft made from an older revision than the item has now
  repliesSince: boolean; // drafted from an older revision, whatever the status: a filed entry with new replies can take a next version
  version: number; // entries of this type filed before this one, plus one: v2 is the draft after the first filing
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
  confirmed?: boolean; // Frank said this decision was right: it is in the labelled set
  containsPeopleObservations: boolean;
  targetHints: { confluence?: string; vault?: string };
  filing?: FilingPlans; // E14 (FR-15.3, FR-15.5): what the policy says about each suggested filing
  todoSuggestion?: TodoSuggestion; // E14 (FR-15.6): a to-do offered, while not added or dismissed
  actions: Partial<Record<ActionType, ActionSummary>>; // latest action per type
  newReplies: boolean; // new messages since the last triage
  backFromSnooze: boolean;
  backAt?: string; // when it came back from snooze, while backFromSnooze (FR-11.4)
  modelPaused: boolean; // waiting for model triage while the budget is hit
  snoozedUntil?: string;
  quietUntil?: string; // when a waiting thread becomes eligible for triage
  doneAt?: string;
  pieces: number; // amendment (topics): threads and stretches of chat in the topic; 1 for a lone piece
  asksDone: string[]; // amendment (topics): asks in next.asks Frank ticked off, by askId
  calendarCategories?: CategoryTag[]; // amendment (R2.8): an invite's or a joined meeting's Outlook categories, while the calendar is read
  // Cockpit Stage 2 (CK-2.3, CK-2.5): who closed it, and whether Frank's reply settled it.
  doneBy?: DoneBy;
  doneSource?: SourceId; // doneBy reply: where the reply was
  doneReason?: string; // doneBy source: "You accepted it in Outlook"
  settling?: boolean; // Frank replied; a settle check will look at it
  replyCheck?: { at: string; allSettled: boolean; settled: number; why?: string; handedOn?: true }; // the last check on his reply, while it stands
  looksFinished?: { at: string; why?: string }; // cockpit CK-2.10: others' messages settled what it asked of Frank; suggested as Done
}

/** Needs you's footer (CK-2.5): items Frank's replies closed today, London time. */
export interface ClosedByReply {
  today: number;
  latestAt?: string;
  latestTitle?: string;
}

export type PollPhase = 'idle' | 'polling' | 'triaging';

export interface PollStatus {
  phase: PollPhase;
  triagingCount?: number;
  reason?: PollReason;
  polling?: SourceId; // the source polling now; sources poll one at a time
  queued?: SourceId[]; // the sources waiting their turn, in the order they will poll
  lastPollAt?: string;
  nextPollAt?: string;
  lastResult?: { at: string; fetched: number; triaged: number; calls: number; reason: PollStatus['reason'] };
}

// offline: no network, not a source failure (FR-2.9); degraded: reachable but failing; paused: settings invalid or safe mode.
export type SlackStatus = 'healthy' | 'backoff' | 'auth_failed' | 'never' | 'offline' | 'degraded' | 'paused';

export interface SourceHealth {
  id: SourceId;
  status: SlackStatus;
  mode?: Settings['slack']['fetchMode']; // Slack only
  lastPollAt?: string;
  nextPollAt?: string;
  /** Minutes between polls now (work or off hours); unset when it doesn't poll now. Stale after 2× (cockpit CK-1.7). */
  intervalMinutes?: number;
  retryAt?: string;
  rateLimitedToday: number;
  cursor?: string;
  message?: string;
}

/** Settings › Sources › Wispr Flow (R2.7). */
export interface WisprStatusView {
  connected: boolean;
  account?: string; // the signed-in name, once known
}

/** Connect: the sign-in page to open, or none when the stored sign-in still works. */
export interface WisprConnectView {
  url?: string;
}

/** Settings › Sources › Outlook (R2.5): the claude.ai Microsoft 365 connector mail is read through. */
export interface OutlookStatusView {
  /** The connector's ID on claude.ai, once found or entered; kept when Outlook is turned off. */
  connectorId?: string;
  /** Who the connector reads mail as, from the last Connect. */
  account?: { name: string; address: string };
  /** Whether Outlook mail is being polled. */
  enabled: boolean;
  /** The Outlook categories on the calendar's events and those given a colour, A to Z (R2.8). */
  categories?: string[];
}

/** One meeting on the inbox's agenda strip (R2.8), from the calendar snapshot. */
export interface AgendaEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  /** Outlook's free/busy: free, tentative, busy, oof, workingElsewhere. */
  showAs?: string;
  organizer?: string; // a name, or the address when the name isn't known
  /** Opens the event in Outlook on the web. */
  link?: string;
  /** Frank's answer: "organizer" for his own meetings; unset when it hasn't been read. */
  response?: string;
  /** The open invite item asking Frank to answer it. */
  inviteItemId?: string;
  /** The Wispr Flow meeting notes for it (R2.8, Wispr enrichment). */
  notesItemId?: string;
  /** Its Outlook categories, with the colours Frank gave them. */
  categories?: CategoryTag[];
}

/** Today's and tomorrow's meetings, without cancelled or declined ones (R2.8). */
export interface AgendaView {
  /** off: the calendar isn't read; never: not read yet; stale: the last read is old. */
  state: 'off' | 'never' | 'ok' | 'stale' | 'auth_failed';
  polledAt?: string;
  /** Today's, then tomorrow's, soonest first. */
  events: AgendaEvent[];
  /** How many minutes before a meeting it shows as next, in the sidebar and on its chip. */
  leadMinutes: number;
}

/**
 * A row in a source's history (cockpit CK-5.1): every item stored for the source, whatever triage
 * made of it. Done ones of any age, excluded channels' and expired ones too; parts stay in their topic.
 */
export interface SourceRow extends ItemSummary {
  /** The people in it by name, Frank left out. */
  people: string[];
  messageCount: number;
  /** A Slack channel now under "Never read these channels": fetched before it was excluded. */
  excluded?: boolean;
  /** Older than the retention period: its text is gone, its metadata stays. */
  expired?: boolean;
}

export interface SourceItemsView {
  source: SourceId;
  /** Newest activity first. */
  items: SourceRow[];
}

/** A meeting in the calendar week (cockpit CK-5.6). Cancelled and declined ones show too, marked. */
export interface WeekEvent extends AgendaEvent {
  cancelled?: boolean;
  /** Who is invited, by name or address. */
  attendees?: string[];
}

/** One week of the calendar snapshot, Monday to Sunday, London time (CK-5.6). */
export interface WeekView {
  state: AgendaView['state'];
  polledAt?: string;
  /** The Monday, as YYYY-MM-DD. */
  weekStart: string;
  /** What the snapshot holds: weeks outside it aren't kept. */
  held?: { from: string; to: string };
  /** Soonest first. */
  events: WeekEvent[];
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
  closedByReply: ClosedByReply;
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
  /** Pages excluded from the Confluence scope: a draft for one of them, or below one, will be refused. */
  excludedPageIds: string[];
  /** Frank's reply closes this item once it settles the asks (cockpit CK-2.5): closing on reply is on for its source. */
  closesOnReply: boolean;
  dryRun: boolean;
  dataDir: string;
  /** Where approved actions write, for links to the Confluence page and the Obsidian note. */
  targets: { confluenceSite: string; spaceKey: string; vaultPath: string; tasksNote: string };
  budgets: BudgetState;
  meId: string; // the signed-in Slack user, shown as "You"
  /** Everyone in a DM or group DM, from the source; absent when it can't say. */
  members?: Participant[];
  /** The topic's pieces, oldest first; `item.messages` holds all their messages (amendment, topics). Absent: the item is its only piece. */
  pieces?: TopicPiece[];
  /** The Outlook categories of a meeting's or invite's calendar event, with their colours (R2.8). */
  calendarCategories?: CategoryTag[];
}

/** One thread or stretch of chat in a topic. */
export interface TopicPiece {
  id: string;
  kind: 'thread' | 'chat';
  permalink: string;
  openUrl?: string;
  messageIds: string[];
  messageCount: number;
  anchor: boolean; // the piece the topic is anchored on: it can't be split out
}

/** A person to pick as a VIP: `name` is what rules match on; `realName` when it differs. */
export interface PersonOption {
  name: string;
  realName?: string;
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
  source: SourceHealth; // Slack
  sources: SourceHealth[]; // every enabled source, Slack first (R2.1)
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

/** PUT /api/settings: the files as saved, with any change made meanwhile kept (FR-1.5). */
export interface SettingsSaved {
  savedAt: string;
  settings: Settings;
  rules: Rule[];
}

/** A prompt or guidance file under config/ (FR-1.7). Claude calls read it fresh every time. */
export interface PromptFileView {
  id: PromptFileId;
  label: string;
  description: string;
  usedBy: string;
  /** Relative to the data directory, e.g. config/prompts/triage.md. */
  path: string;
  /** What calls use: the file, or the built-in default when the file is missing or empty. */
  text: string;
  /** Declared name plus a hash of the text, as in the usage log and eval reports. */
  version: string;
  defaultVersion: string;
  /** The text differs from the built-in default. */
  edited: boolean;
  /** What the file was distilled from (named in its header), each compared with the source now. Empty when the server can't look. */
  sources: PromptSourceView[];
}

/** A source a guidance file was distilled from: a skill or a vault note. */
/** One page in the live Confluence catalogue (amendment: live catalogue, FR-10.2). */
export interface CataloguePageView {
  id: string;
  title: string;
  /** Ancestor titles below the space home, then the page's own. */
  path: string;
  /** The scope root it sits under, if any. */
  rootId?: string;
  labels: string[];
  /** Other pages sit under it: an index, so entries go to its children. */
  hub: boolean;
}

/** Every page in the Confluence scope, read live for Settings' preview. */
export interface ConfluenceCatalogueView {
  pages: CataloguePageView[];
  /** The search stopped at its limit, so there may be more. */
  truncated: boolean;
}

/** The user guide's Markdown files, read from the guide folder now (FR-1.8). */
export interface GuideFilesView {
  /** The folder they were read from. */
  dir: string;
  files: { slug: string; source: string }[];
}

export interface PromptSourceView {
  id: string;
  label: string;
  /** Where the server found it. */
  path?: string;
  /** current: as recorded in the header; changed: edited since; missing: not found. */
  state: 'current' | 'changed' | 'missing';
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
  | { topic: 'draft_ready'; itemId: string; actionId: string; type: ActionType; title: string }
  | { topic: 'draft_failed'; itemId: string; actionId: string; type: ActionType; title: string; message: string }
  /** The bell's entries may have changed (FR-11.3). */
  | { topic: 'attention' };

/**
 * What the bell lists (FR-11.4). Each kind is derived from state as it stands, so an entry goes once
 * Frank deals with it; the dismissible ones can also be dismissed (FR-11.5).
 */
export type AttentionKind =
  | 'draft_ready' // a draft waits for review
  | 'draft_failed' // drafting failed
  | 'write_failed' // an approved write failed
  | 'fix_needed' // a login, connector or setting Frank has to fix; or drafts held by the budget
  | 'snooze_back' // a snoozed item came back
  | 'looks_finished' // others' messages settled what it asked of Frank (CK-2.10)
  | 'reply_unsettled' // Frank replied, and the check found asks still open (CK-2.3)
  | 'eval_done' // a triage eval finished (FR-6.1)
  | 'guidance_changed'; // a guidance file's sources changed since it was distilled (FR-1.7)

export interface AttentionEntry {
  /** Names this occurrence: what dismissing remembers, so a new one shows again. */
  key: string;
  kind: AttentionKind;
  /** When it happened: newest first, and what the unseen count compares against. */
  at: string;
  /** What happened, e.g. "Vault note draft ready". */
  title: string;
  /** What it is about: the item's title, the dependency, the guidance file. */
  subject: string;
  /** One more line, when there is something to add, e.g. "New replies since it was drafted". */
  detail?: string;
  itemId?: string;
  actionId?: string;
  actionType?: ActionType;
  /** Where its button goes in the app, or (`href`) elsewhere. */
  to?: string;
  href?: string;
  /** The button's label: Review, Open, Fix… */
  cta: string;
  dismissible: boolean;
}

/** A draft being made now, or waiting its turn: shown in the bell, not counted. */
export interface AttentionWork {
  itemId: string;
  actionId: string;
  type: ActionType;
  subject: string;
  /** Absent while it waits its turn. */
  progress?: DraftProgress;
  /** Why it waits, when something holds it: the drafts budget, Claude, Confluence. */
  held?: string;
}

/** One filing written today (BACKLOG UX-12): what went where, for the Done list. */
export interface Filing {
  actionId: string;
  itemId: string;
  type: ActionType;
  /** When it was written. */
  at: string;
  /** The item: where it came from, and its summary. */
  title: string;
  summary: string;
  /** The item is done (so Reopen undoes it), or still open. */
  itemDone: boolean;
  /** The outcome as the action panel shows it, e.g. "Appended under ## Decisions in …". */
  result?: string;
  /** Vault notes, relative to the vault (to-dos: the Tasks note). */
  paths?: string[];
  pageId?: string;
}

/** Today's filings, newest first (UX-12), with what links to them need. */
export interface FiledView {
  filings: Filing[];
  dryRun: boolean;
  targets: { confluenceSite: string; spaceKey: string; vaultPath: string };
}

export interface AttentionView {
  /** Newest first. */
  entries: AttentionEntry[];
  /** Oldest first, as the queue takes them. */
  working: AttentionWork[];
}

export interface CorrectionInput {
  attention: Attention;
  confluence: boolean;
  vault: boolean;
}

export interface WorkOsApi {
  /** Server time. The real client returns the local clock; the mock returns its simulated clock. */
  now(): Date;

  /** The link to the server as this client sees it right now (HealthView.connection follows it). */
  readonly connection: HealthView['connection'];

  getHealth(): Promise<HealthView>;
  /** Re-runs the startup checks and dependency probes now (FR-12.2). */
  recheck(): Promise<void>;
  getInbox(): Promise<InboxView>;
  getItem(id: string): Promise<ItemView>;
  /** The conversation before a DM item (empty for threads, or when the source can't say). */
  getEarlier(id: string): Promise<EarlierView>;
  /** Slack channel names ("#name") for the rule editor's search. */
  getChannels(): Promise<string[]>;
  /** People in the Slack workspace, for the VIP search. */
  getPeople(): Promise<PersonOption[]>;
  /** Every page in the Confluence scope as the saved settings define it, read live. */
  getConfluenceCatalogue(): Promise<ConfluenceCatalogueView>;
  /** The guide's pages as they are on disk now; unavailable when the server has no guide folder. */
  getGuide(): Promise<GuideFilesView>;
  getUsage(): Promise<UsageView>;
  getEvalReports(): Promise<EvalReport[]>;
  getSettings(): Promise<SettingsView>;
  /** Whether Wispr Flow is signed in (R2.7). */
  getWisprStatus(): Promise<WisprStatusView>;
  /** The Microsoft 365 connector Outlook reads through, and whether Outlook is on (R2.5). */
  getOutlookStatus(): Promise<OutlookStatusView>;
  /** Today's and tomorrow's meetings from Outlook Calendar (R2.8). */
  getAgenda(): Promise<AgendaView>;
  /** Every item stored for one source, triage or not (cockpit CK-5.1). */
  getSourceItems(source: SourceId): Promise<SourceItemsView>;
  /** The calendar week starting on the Monday given (YYYY-MM-DD), or this week (CK-5.6). */
  getWeek(weekStart?: string): Promise<WeekView>;

  pollNow(): Promise<void>;
  markDone(itemId: string): Promise<void>;
  reopen(itemId: string): Promise<void>;
  /** Marks many items done in one write; returns how many changed (items already done are skipped). */
  markDoneMany(itemIds: string[]): Promise<{ count: number }>;
  /** Undo for markDoneMany. */
  reopenMany(itemIds: string[]): Promise<{ count: number }>;
  snooze(itemId: string, untilIso: string): Promise<void>;
  correctTriage(itemId: string, input: CorrectionInput): Promise<{ labelCount: number }>;
  /** "Not finished" on a topic that looks finished (cockpit CK-2.10): back to Today, and a label for the finish eval. */
  notFinished(itemId: string): Promise<{ labelCount: number }>;
  /** "Triage was right": the decision as it stands joins the labelled set, so the eval sees what triage gets right too. */
  confirmTriage(itemId: string): Promise<{ labelCount: number }>;
  retryTriage(itemId: string): Promise<void>;
  /** "Reply in …" (cockpit CK-2.4): the item is read again at +2 and +6 min, so a reply that settles it closes it soon. */
  replied(itemId: string): Promise<{ scheduled: boolean }>;
  /** Topics (amendment): ticks off one ask in a topic's checklist. */
  markAskDone(itemId: string, askId: string): Promise<void>;
  /** Takes a piece out of its topic: it is triaged on its own and never routed back there. */
  splitPiece(pieceId: string): Promise<void>;
  /** Asks routing to merge a conversation's open topics; triage then runs on the merged ones. */
  regroup(conversation: string): Promise<{ merged: number }>;

  /** `quiet`: drafted ahead while filing in a batch, so no macOS notification when it's ready (FR-11.6). */
  /** steps: a to-do's lines to start from (UX-5). */
  requestDraft(itemId: string, type: ActionType, opts?: { quiet?: boolean; steps?: string[]; suggested?: boolean }): Promise<Action>;
  /** E14 (FR-15.6): Frank doesn't want the to-do the filing policy suggested. */
  dismissTodo(itemId: string): Promise<void>;
  /** E14 (FR-15.7): Frank's word on the filing policy's call. Answers with the items in the filing labels. */
  filingFeedback(itemId: string, body: FilingFeedbackBody): Promise<{ labelCount: number }>;
  cancelDraft(actionId: string): Promise<void>;
  /** `part`: which note of a draft that files into several (FR-9.7). */
  saveDraftEdit(actionId: string, content: string, part?: number): Promise<void>;
  redraft(actionId: string): Promise<Action>;
  discardAction(actionId: string): Promise<void>;
  /** `markDoneWhenFiled`: approved while filing in a batch; the item is done once all its filings are written (cockpit CK-4.4). */
  approveAction(actionId: string, opts?: { markDoneWhenFiled?: boolean }): Promise<void>;
  /** Writes a draft whose write failed again, once the cause is fixed: no new draft, no drafts budget (FR-14.5). */
  retryWrite(actionId: string): Promise<void>;

  runEval(): Promise<void>;
  rebuildState(): Promise<{ events: number }>;
  /** `base`: the files the form had when the change was made; only what changed from it is applied. */
  saveSettings(settings: Settings, rules: Rule[], base?: { settings: Settings; rules: Rule[] }): Promise<SettingsSaved>;
  /** Starts Wispr Flow's sign-in: open the URL in a new tab. No URL: already signed in, and the source is on. */
  connectWispr(): Promise<WisprConnectView>;
  /** Forgets the Wispr Flow sign-in and turns the source off. */
  disconnectWispr(): Promise<void>;
  /** Finds the Microsoft 365 connector (or uses the entered ID), tests it, turns Outlook on and polls it. */
  connectOutlook(connectorId?: string): Promise<OutlookStatusView>;
  /** Turns Outlook off; the connector is kept. */
  disconnectOutlook(): Promise<void>;
  getPrompts(): Promise<PromptFileView[]>;
  /** Fails as conflict when the file changed since baseVersion. */
  savePrompt(id: PromptFileId, text: string, baseVersion: string): Promise<PromptFileView>;
  resetPrompt(id: PromptFileId, baseVersion: string): Promise<PromptFileView>;
  /** Records the sources as they are now in the file's header, once the guidance has been checked against them. */
  markPromptReviewed(id: PromptFileId, baseVersion: string): Promise<PromptFileView>;

  /** What the bell lists (FR-11.3). */
  getAttention(): Promise<AttentionView>;
  /** Dismisses one of the bell's entries by its key (FR-11.5). */
  dismissAttention(key: string): Promise<void>;
  /** What was filed today, for the Done list (UX-12). */
  getFiled(): Promise<FiledView>;

  subscribe(onNotice: (n: Notice) => void): () => void;
}
