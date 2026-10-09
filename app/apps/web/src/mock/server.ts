import {
  Rules,
  SETTLE_MAX_ATTEMPTS,
  Settings as SettingsSchema,
  askId,
  awaitsReply,
  effectiveTriage,
  filedAll,
  settleChecked,
  settleFailed,
  anchorOf,
  applyActionEvent,
  applyDecision,
  budgetsOf,
  correct,
  costOf,
  failTriage,
  firstMatchingRule,
  followAnchor,
  inTimeRange,
  isSnoozeDue,
  isWorkHours,
  londonParts,
  pollIntervalMinutes,
  markAskDone,
  markDone,
  markNotified,
  markSeen,
  needsNotification,
  partGrew,
  receiveMessages,
  reopen,
  routeTopic,
  categoryTags,
  meetingLead,
  mergeEdit,
  sourceSchedule,
  seenChanges,
  snooze,
  summaryOf,
  closedByReply,
  closeOnReply,
  closesOnReply,
  conversationOf,
  replay,
  replyCloseCriteria,
  toLoggedDecision,
  topicItem,
  topicPiecesView,
  unsnooze,
  upgradeSettings,
  type Action,
  type ConfluenceCatalogueView,
  type GuideFilesView,
  type ActionType,
  type BudgetState,
  type CorrectionInput,
  type DependencyHealth,
  type Criterion,
  type DraftProgress,
  type EventData,
  type EvalReport,
  type EventType,
  type HealthView,
  type InboxView,
  type ItemSummary,
  type EarlierView,
  type PersonOption,
  type ItemView,
  type Notice,
  type PromptFileId,
  type PromptFileView,
  type Rule,
  type Settings,
  type SettingsSaved,
  type SettingsView,
  type SourceHealth,
  type StartupCheck,
  type UsagePurpose,
  type UsageRecord,
  type UsageRow,
  type UsageView,
  type AgendaView,
  type CategoryTag,
  type Item,
  type OutlookStatusView,
  type WisprConnectView,
  type WisprStatusView,
  type WorkEvent,
  type WorkOsApi,
} from '@work-os/shared';
import { ApiError, type FieldIssue } from '../api/errors';
import { MIN, addMins, buildDecision, makeEvent, newRec, recActivity, slackTs, upserted, type EventIds } from './build';
import type { MockControls, PollOutcome, SettleOutcome, StateFlag } from './controls';
import { buildDraft } from './drafts';
import { CALENDAR, CALENDAR_CATEGORIES } from './seed/calendar';
import { inMockScope, mockCatalogue } from './seed/catalogue';
import { ME } from './me';
import { FRANK } from './seed/people';
import { SEED_CLOCK, STATE_VERSION, buildState, type Preset } from './seed';
import { SEED_PROMPT_FILES } from './seed/prompts';
import { BATCH_TWELVE, CALENDAR_INVITE, OUTLOOK_THREADS, REPLIES, VIP_DM, WISPR_MEETING } from './seed/threads';
import type { DraftOutcome, ItemRec, MockState, ReplySeed, ThreadSeed } from './types';

const STORAGE_KEY = 'workos.mock';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const QUERY_MS = 30;
const COMMAND_MS = 160;
const STAGE_MS = 1500;

const DRAFT_STAGES: Record<ActionType, string[]> = {
  vault_note: ['Reading the thread', 'Finding related notes in the vault', 'Drafting the note'],
  confluence_entry: ['Reading the thread', 'Reading the Confluence catalogue', 'Picking the page', 'Drafting the entry', 'People check (Haiku)'],
};

const ACTIVE: Action['status'][] = ['drafting', 'ready', 'approved', 'executing'];
const RANK = { none: 0, today: 1, now: 2 } as const;

/** The Microsoft 365 connector's ID on the mock's claude.ai. */
export const MOCK_CONNECTOR_ID = 'mcpsrv_01MockMicrosoft365';

export class MockServer implements WorkOsApi, MockControls {
  private s: MockState;
  private listeners = new Set<(n: Notice) => void>();
  private clockAnchor = 0; // mock epoch ms at realAnchor
  private realAnchor = 0;
  private progress: Record<string, DraftProgress> = {};
  private draftTimers = new Map<string, ReturnType<typeof setTimeout>[]>();
  private saveTimer?: ReturnType<typeof setTimeout>;
  private tickTimer?: ReturnType<typeof setInterval>;
  private polling = false;
  private readonly startedAt = new Date().toISOString();

  constructor() {
    this.s = this.load() ?? buildState('default');
    this.anchorClock(this.s.clock);
    this.resumeAfterLoad();
    this.tickTimer = setInterval(() => this.tick(), 2000);
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.flushOnHide);
  }

  private flushOnHide = () => {
    if (this.saveTimer) this.writeNow();
  };

  // ---------------------------------------------------------------- clock & persistence

  now(): Date {
    return new Date(this.clockAnchor + (Date.now() - this.realAnchor));
  }
  private iso() {
    return this.now().toISOString();
  }
  private anchorClock(iso: string) {
    this.clockAnchor = Date.parse(iso);
    this.realAnchor = Date.now();
  }

  private load(): MockState | undefined {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw) as MockState;
      if (parsed.schemaVersion !== STATE_VERSION) return undefined;
      parsed.settings = upgradeSettings(parsed.settings) as Settings; // a session saved before VIPs moved to People
      return parsed;
    } catch {
      return undefined;
    }
  }

  private save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.writeNow(), 150);
  }

  /** Writes at once. Also runs as the page unloads, so a reload never loses the last change. */
  private writeNow = () => {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.s.clock = this.iso();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.s));
    } catch {
      /* storage full or blocked: the session still works in memory */
    }
  };

  private resumeAfterLoad() {
    this.s.poll.phase = 'idle';
    this.s.evalRunning = false;
    for (const a of Object.values(this.s.actions)) {
      if (a.status === 'drafting') this.startDrafting(a, 'normal');
      if (a.status === 'approved' || a.status === 'executing') void this.execute(a.id, 0);
    }
    if (this.s.flags.connection === 'reconnecting') this.scheduleReconnect();
  }

  // ---------------------------------------------------------------- notices

  subscribe(onNotice: (n: Notice) => void) {
    this.listeners.add(onNotice);
    return () => {
      this.listeners.delete(onNotice);
    };
  }
  private emit(...notices: Notice[]) {
    this.save();
    for (const n of notices) for (const l of this.listeners) l(n);
  }
  private emitAll() {
    this.emit({ topic: 'health' }, { topic: 'inbox' }, { topic: 'usage' }, { topic: 'settings' }, { topic: 'evals' }, { topic: 'clock' });
    for (const id of Object.keys(this.s.items)) this.emit({ topic: 'item', id });
  }
  /** Logs an event. Action state follows from its events, through the server's own reducer. */
  private event<T extends EventType>(type: T, data: EventData<T>, ids: EventIds = {}) {
    this.s.seq += 1;
    const e = makeEvent(this.s.seq, type, this.iso(), data, ids);
    this.s.events.push(e);
    if (this.s.events.length > 2000) this.s.events.splice(0, this.s.events.length - 2000);
    applyActionEvent(this.s.actions, e);
  }

  private async gate(ms: number) {
    await sleep(ms);
    if (this.s.flags.connection !== 'up') throw new ApiError('network', 'Work OS server is not reachable on 127.0.0.1.');
  }

  private rec(id: string): ItemRec {
    const r = this.s.items[id];
    if (!r) throw new ApiError('not_found', 'Item not found. It may have been removed by retention.');
    return r;
  }

  // ---------------------------------------------------------------- scheduler

  private intervalMins(at = this.now()) {
    const sch = this.s.settings.schedule;
    return isWorkHours(at, sch.workHours) ? sch.intervalWorkMinutes : sch.intervalOffMinutes;
  }

  private tick() {
    if (this.s.flags.connection !== 'up' || this.s.flags.startupFailure) return;
    const now = this.iso();
    let changed = false;
    for (const rec of Object.values(this.s.items)) {
      if (isSnoozeDue(rec, now)) {
        unsnooze(rec);
        this.event('item.unsnoozed', undefined, { itemId: rec.item.id });
        changed = true;
        this.emit({ topic: 'item', id: rec.item.id });
      }
    }
    if (changed) this.emit({ topic: 'inbox' });

    const src = this.s.source;
    if (this.s.flags.firstRun || src.status === 'auth_failed' || this.polling) return;
    // Quietly stuck, in safe mode, or stopping: nothing is read (cockpit CK-1.7).
    const h = this.s.flags.health;
    if (h === 'stale' || h === 'safe' || h === 'stopping') return;
    if (src.status === 'backoff') {
      if (src.retryAt && src.retryAt > now) return;
      src.status = 'healthy';
      src.retryAt = undefined;
      this.emit({ topic: 'inbox' }, { topic: 'usage' });
    }
    const interval = this.intervalMins();
    const last = src.lastPollAt ? Date.parse(src.lastPollAt) : 0;
    // A clock jump of more than twice the interval means the laptop slept (FR-2.7).
    const woke = last > 0 && Date.parse(now) - last > 2 * interval * MIN;
    if (woke) void this.runPoll('wake');
    else if (!src.nextPollAt || src.nextPollAt <= now) void this.runPoll('scheduled');
  }

  // ---------------------------------------------------------------- polling & triage

  private async runPoll(reason: 'manual' | 'scheduled' | 'wake' | 'first', inject: { threads?: ThreadSeed[]; replies?: ReplySeed[] } = {}) {
    if (this.polling) return;
    this.polling = true;
    try {
      // Each enabled source in turn, as the scheduler polls them; Slack's turn takes longest.
      const round = [this.sourceHealth(), ...this.outlookHealth(), ...this.wisprHealth()].filter((h) => h.status !== 'auth_failed').map((h) => h.id);
      for (const [i, id] of round.entries()) {
        this.s.poll = { ...this.s.poll, phase: 'polling', reason, polling: id, queued: round.slice(i + 1) };
        this.emit({ topic: 'inbox' });
        await sleep(id !== 'slack' ? 600 : reason === 'wake' ? 1600 : 1100);
      }
      const now = this.iso();
      let fetched = 0;

      if (this.s.flags.firstRun) {
        for (const seed of this.s.firstRunSeeds) {
          this.ingestThread(seed, '', true);
          fetched += seed.messages.length;
        }
        this.s.firstRunSeeds = [];
        this.s.flags.firstRun = false;
      }
      const due = this.s.timeline.filter((t) => t.at <= now);
      this.s.timeline = this.s.timeline.filter((t) => t.at > now);
      for (const t of due) {
        if (t.thread) fetched += this.ingestThread(t.thread, `-${this.s.seq}`);
        if (t.reply) fetched += this.ingestReply(t.reply);
      }
      for (const t of inject.threads ?? []) fetched += this.ingestThread(t, `-${this.s.seq}`);
      for (const r of inject.replies ?? []) fetched += this.ingestReply(r);

      const interval = this.intervalMins();
      this.s.source = { ...this.s.source, status: 'healthy', lastPollAt: now, nextPollAt: addMins(now, interval), cursor: slackTs(now) };
      this.event('source.polled', { source: 'slack', reason, fetched, cursor: slackTs(now) });

      const quiet = this.s.settings.triage.quietMinutes;
      const isQuiet = (r: ItemRec) => Date.parse(now) - Date.parse(r.item.lastActivityAt) >= quiet * MIN;
      // Topics: a scripted piece joins its topic once quiet; a part is triaged with its topic.
      for (const r of Object.values(this.s.items)) if (r.topicKey && !r.routed && r.triageState === 'pending' && isQuiet(r)) this.route(r);
      const eligible = Object.values(this.s.items).filter((r) => r.triageState === 'pending' && !r.topicOf && isQuiet(r));
      let triaged = 0;
      let calls = 0;
      if (eligible.length && !this.budgets().triage.hit) {
        this.s.poll = { ...this.s.poll, phase: 'triaging', triagingCount: eligible.length, polling: undefined, queued: undefined };
        this.emit({ topic: 'inbox' });
        await sleep(1400);
        const res = this.triageBatch(eligible);
        triaged = res.triaged;
        calls = res.calls;
      } else if (!eligible.length) {
        this.s.pollsSkippedToday += 1;
      }
      this.s.poll = {
        phase: 'idle',
        lastPollAt: now,
        nextPollAt: this.s.source.nextPollAt,
        lastResult: { at: now, fetched, triaged, calls, reason },
      };
      this.emit({ topic: 'inbox' }, { topic: 'usage' });
    } finally {
      this.polling = false;
    }
  }

  /** Stores a new thread; fixed-outcome rules decide at once and bypass the quiet window (§5.3). */
  private ingestThread(seed: ThreadSeed, uniq: string, keepOriginalTimes = false): number {
    const rec = newRec(seed, this.iso(), uniq);
    if (!keepOriginalTimes) rec.arrivedAt = this.iso();
    const rule = firstMatchingRule(rec.item, this.s.rules, this.s.settings, ME);
    if (rule?.outcome.type === 'drop') {
      this.s.ruleHits[rule.id] = (this.s.ruleHits[rule.id] ?? 0) + 1;
      return seed.messages.length; // dropped at ingest, never stored (FR-2.10)
    }
    this.s.items[rec.item.id] = rec;
    this.event('item.upserted', upserted(rec.item, false), { itemId: rec.item.id });
    if (rule && (rule.outcome.type === 'now' || rule.outcome.type === 'today')) {
      this.s.ruleHits[rule.id] = (this.s.ruleHits[rule.id] ?? 0) + 1;
      this.decide(rec, buildDecision(rec, this.iso(), { kind: 'rule', ruleId: rule.id, attention: rule.outcome.type }));
    }
    this.emit({ topic: 'item', id: rec.item.id });
    return seed.messages.length;
  }

  private ingestReply(reply: ReplySeed): number {
    const rec = Object.values(this.s.items).find((r) => r.key === reply.targetKey);
    if (!rec) return 0;
    const now = this.iso();
    const item = rec.item;
    item.messages.push({ id: `${rec.key}-r${item.revision + 1}`, authorId: reply.by, ts: now, text: reply.text });
    item.messageCount += 1;
    item.revision += 1;
    item.lastActivityAt = now;
    if (!item.participants.some((p) => p.id === reply.by)) {
      item.participants.push({ id: reply.by, name: this.personName(reply.by) });
    }
    if (reply.decision) rec.script = { ...rec.script, ...reply.decision };
    this.event('item.upserted', upserted(item, reply.by === FRANK), { itemId: item.id });
    // Re-triage only when the new messages are not from Frank alone (§5.3). A part's new messages are its topic's.
    receiveMessages(rec, reply.by === FRANK, now);
    partGrew(this.s.items, recActivity, item.id, reply.by === FRANK);
    if (reply.by !== FRANK) {
      const rule = firstMatchingRule(item, this.s.rules, this.s.settings, ME);
      if (rule && (rule.outcome.type === 'now' || rule.outcome.type === 'today')) {
        this.decide(rec, buildDecision(rec, now, { kind: 'rule', ruleId: rule.id, attention: rule.outcome.type }));
      }
    }
    this.emit({ topic: 'item', id: item.id });
    return 1;
  }

  private personName(id: string) {
    for (const r of Object.values(this.s.items)) {
      const p = r.item.participants.find((x) => x.id === id);
      if (p) return p.name;
    }
    return id;
  }

  /** Routing, as scripted by the seed: the piece joins its topic (topics). */
  private route(rec: ItemRec) {
    const into = Object.values(this.s.items).find((r) => r.key === rec.topicKey);
    routeTopic(this.s.items, recActivity, rec.item.id, into?.item.id, 'model');
    this.event('topic.routed', { ...(into && { into: into.item.id }), by: 'model' }, { itemId: rec.item.id });
  }

  /** The record a topic shows as: a part's anchor, or itself. */
  private anchor(id: string): ItemRec {
    return this.rec(anchorOf(this.s.items, this.rec(id).item.id));
  }

  /** One batched Haiku call per maxThreadsPerCall threads (CL-4, §5.3). */
  private triageBatch(recs: ItemRec[]) {
    const max = this.s.settings.triage.maxThreadsPerCall;
    let triaged = 0;
    let calls = 0;
    for (let i = 0; i < recs.length; i += max) {
      const chunk = recs.slice(i, i + max);
      const at = this.iso();
      const batchId = `batch-${at}`;
      calls += 1;
      this.recordUsage('triage', this.s.settings.models.triage, 2200 + chunk.length * 900, 120 + chunk.length * 95, chunk.map((r) => r.item.id), 'triage v3');
      for (const rec of chunk) {
        rec.batch = { at, threads: recs.length, calls: Math.ceil(recs.length / max) };
        // CL-7: retry once, then mark the item triage_failed.
        if (rec.failTriage > 0) {
          rec.failTriage -= Math.min(rec.failTriage, 2);
          failTriage(rec, 2);
          this.event('triage.failed', { revision: rec.item.revision, attempts: 2, reason: 'schema validation failed' }, { itemId: rec.item.id });
          this.emit({ topic: 'item', id: rec.item.id });
          continue;
        }
        const rule = firstMatchingRule(rec.item, this.s.rules, this.s.settings, ME);
        this.decide(
          rec,
          buildDecision(rec, at, {
            kind: 'model',
            batchId,
            ruleId: rule?.id,
            min: rule?.outcome.type === 'model' ? rule.outcome.min : undefined,
            file: rule?.outcome.type === 'file',
            model: this.s.settings.models.triage,
          }),
        );
        if (rule) this.s.ruleHits[rule.id] = (this.s.ruleHits[rule.id] ?? 0) + 1;
        triaged += 1;
      }
    }
    return { triaged, calls };
  }

  private decide(rec: ItemRec, d: NonNullable<ItemRec['decision']>) {
    applyDecision(rec, d);
    this.event('triage.decided', { decision: toLoggedDecision(d) }, { itemId: rec.item.id });
    if (needsNotification(rec)) {
      const n = this.s.settings.notifications;
      const suppressed = !n.enabled ? 'disabled' : inTimeRange(this.now(), n.quietHours) ? 'quiet_hours' : undefined;
      markNotified(rec);
      this.event('item.notified', { kind: 'now', ...(suppressed && { suppressed }) }, { itemId: rec.item.id });
      if (!suppressed) this.emit({ topic: 'notification', itemId: rec.item.id, title: rec.item.title, summary: d.summary });
    }
    this.emit({ topic: 'item', id: rec.item.id });
  }

  private recordUsage(purpose: UsagePurpose, model: UsageRecord['model'], input: number, output: number, itemIds: string[], promptVersion: string, durationMs = 2600) {
    const cache = purpose === 'triage' ? 1800 : 3200;
    this.s.usage.push({
      id: `u-${this.s.seq}-${this.s.usage.length}`,
      at: this.iso(),
      purpose,
      model,
      inputTokens: input,
      outputTokens: output,
      cacheTokens: cache,
      costEquivalent: costOf(model, input, output, cache),
      durationMs,
      itemIds,
      promptVersion,
    });
  }

  // ---------------------------------------------------------------- views

  private budgets(): BudgetState {
    const f = this.s.flags;
    return budgetsOf(this.s.usage, this.s.settings, this.now(), { triage: f.forceTriageBudget, drafts: f.forceDraftBudget });
  }

  private actionsFor(itemId: string) {
    return Object.values(this.s.actions)
      .filter((a) => a.itemId === itemId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private summaryOf(rec: ItemRec, budgets: BudgetState): ItemSummary {
    const d = rec.decision;
    const row = summaryOf(rec.item, rec, {
      actions: this.actionsFor(rec.item.id),
      quietMinutes: this.s.settings.triage.quietMinutes,
      now: this.iso(),
      triageBudgetHit: budgets.triage.hit,
      text: { summary: d?.summary, reason: d?.reason, next: d?.next, firstMessage: rec.item.messages[0]?.text, ...(rec.settleWhy && { settleWhy: rec.settleWhy }) },
    });
    const calendarCategories = this.categoryTagsOf(rec.item.meeting?.calendar?.eventId);
    return calendarCategories ? { ...row, calendarCategories } : row;
  }

  async getHealth(): Promise<HealthView> {
    await sleep(QUERY_MS);
    const f = this.s.flags;
    const since = this.s.checkedAt;
    const dep = (id: DependencyHealth['id'], state: DependencyHealth['state'], reason?: string, fix?: string): DependencyHealth => ({ id, state, since, failures: state === 'ok' ? 0 : 1, reason, fix });
    const slack = this.s.source.status;
    const deps = [
      dep('network', 'ok'),
      dep('slack', slack === 'auth_failed' ? 'auth_failed' : slack === 'backoff' ? 'rate_limited' : f.startupFailure === 'slack_token' ? 'auth_failed' : 'ok'),
      dep('claude', f.startupFailure === 'claude_login' ? 'auth_failed' : 'ok'),
      dep('keychain', f.startupFailure === 'slack_token' ? 'degraded' : 'ok', f.startupFailure === 'slack_token' ? 'Slack token missing' : undefined),
      dep('storage', 'ok'),
      ...(f.health === 'ms365'
        ? [dep('ms365', 'auth_failed', 'connector needs-auth', 'The Microsoft 365 connector needs signing in again. Reconnect it on claude.ai (Settings → Connectors), then choose Check again.')]
        : []),
    ];
    const pending = Object.values(this.s.actions).filter((a) => a.status === 'approved' || a.status === 'executing');
    return {
      connection: f.connection,
      startupFailure: f.startupFailure,
      mode: f.health === 'safe' ? 'safe' : deps.some((d) => d.state !== 'ok') ? 'degraded' : 'normal',
      phase: f.health === 'catching_up' ? 'catching_up' : f.health === 'stopping' ? 'stopping' : 'running',
      deps,
      checks: this.startupChecks(),
      checkedAt: this.s.checkedAt,
      outbox: { approved: pending.length, waiting: 0, oldestAt: pending.map((a) => a.updatedAt).sort()[0] },
      instance: 'mock',
      version: '0.1.0',
      startedAt: this.startedAt,
    };
  }

  async recheck() {
    await this.gate(COMMAND_MS);
    this.s.checkedAt = this.iso();
    this.emit({ topic: 'health' }, { topic: 'settings' });
  }

  async getInbox(): Promise<InboxView> {
    await this.gate(QUERY_MS);
    const budgets = this.budgets();
    const items = Object.values(this.s.items)
      .filter((r) => !r.topicOf) // a part shows in its topic
      .map((r) => this.summaryOf(r, budgets))
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    return {
      items,
      poll: { ...this.s.poll, lastPollAt: this.s.source.lastPollAt, nextPollAt: this.s.source.nextPollAt },
      source: this.sourceHealth(),
      sources: [this.sourceHealth(), ...this.outlookHealth(), ...this.wisprHealth()],
      budgets,
      dryRun: this.s.settings.dryRun,
      notices: { rebuilt: this.s.flags.rebuiltNotice, fileVaultOff: this.s.flags.fileVaultOff },
      labelCount: this.s.labelCount,
      firstRun: this.s.flags.firstRun,
      workHours: isWorkHours(this.now(), this.s.settings.schedule.workHours),
      closedByReply: closedByReply(items, this.now()),
    };
  }

  private sourceHealth() {
    const src = this.s.source;
    const messages: Record<string, string | undefined> = {
      backoff: 'Slack returned 429. Waiting for Retry-After before the next poll.',
      auth_failed: 'Slack rejected the user token (invalid_auth). Re-install the app and update the Keychain entry.',
      never: 'Not polled yet.',
    };
    return {
      id: 'slack' as const,
      status: src.status,
      mode: this.s.settings.slack.fetchMode,
      lastPollAt: src.lastPollAt,
      nextPollAt: src.nextPollAt,
      intervalMinutes: pollIntervalMinutes(this.s.settings, 'slack', this.now()),
      retryAt: src.retryAt,
      rateLimitedToday: src.rateLimitedToday,
      cursor: src.cursor,
      message: messages[src.status],
    };
  }

  /** Outlook's lines in the inbox health, mail and calendar, once each is turned on (R2.5, R2.8). */
  private outlookHealth(): SourceHealth[] {
    return (['outlook', 'calendar'] as const).filter((id) => sourceSchedule(this.s.settings, id).enabled).map((id) => ({ id, status: 'healthy', lastPollAt: this.s.source.lastPollAt, intervalMinutes: pollIntervalMinutes(this.s.settings, id, this.now()), rateLimitedToday: 0 }));
  }

  /** Wispr Flow's line in the inbox health, once it is turned on (R2.7). */
  private wisprHealth(): SourceHealth[] {
    if (!sourceSchedule(this.s.settings, 'wispr').enabled) return [];
    const connected = !!this.s.wispr?.connected;
    return [
      {
        id: 'wispr',
        status: connected ? 'healthy' : 'auth_failed',
        lastPollAt: this.s.source.lastPollAt,
        intervalMinutes: pollIntervalMinutes(this.s.settings, 'wispr', this.now()),
        rateLimitedToday: 0,
        ...(!connected && { message: 'Not signed in to Wispr Flow. Reconnect in Settings › Sources › Wispr Flow.' }),
      },
    ];
  }

  async getEarlier(id: string): Promise<EarlierView> {
    await this.gate(QUERY_MS);
    this.rec(id);
    return { messages: [], people: [] }; // the seed has no conversation before its items
  }

  async getChannels(): Promise<string[]> {
    await this.gate(QUERY_MS);
    const sl = this.s.settings.slack;
    const fromItems = Object.values(this.s.items).filter((r) => r.item.source === 'slack' && r.item.kind !== 'dm' && r.item.title.startsWith('#')).map((r) => r.item.title);
    return [...new Set([...fromItems, ...sl.includeChannels, ...sl.excludeChannels, ...sl.customerChannels, ...(sl.appChannels ?? [])])].sort((a, b) => a.localeCompare(b));
  }

  async getPeople(): Promise<PersonOption[]> {
    await this.gate(QUERY_MS);
    const names = Object.values(this.s.items).flatMap((r) => (r.item.source === 'slack' ? r.item.participants : []).filter((p) => p.id !== FRANK).map((p) => p.name));
    return [...new Set([...names, ...this.s.settings.people.vips])].sort((a, b) => a.localeCompare(b)).map((name) => ({ name }));
  }

  /** The mock has no guide folder: the app shows the copy in its build, as a server without one does. */
  async getGuide(): Promise<GuideFilesView> {
    await this.gate(QUERY_MS);
    throw new ApiError('unavailable', 'The mock has no guide folder; the app shows its built-in copy.');
  }

  async getConfluenceCatalogue(): Promise<ConfluenceCatalogueView> {
    await this.gate(QUERY_MS * 10); // a few CQL pages on the real site
    return { pages: mockCatalogue(this.s.settings.confluence), truncated: false };
  }

  async getItem(requested: string): Promise<ItemView> {
    await this.gate(QUERY_MS);
    // A part opens as its topic, with every piece's messages.
    const rec = this.anchor(requested);
    const id = rec.item.id;
    const parts = (rec.parts ?? []).map((p) => this.rec(p).item);
    const pieces = topicPiecesView(id, [rec.item, ...parts]);
    const budgets = this.budgets();
    const summary = this.summaryOf(rec, budgets);
    // Opening an item counts as seeing it.
    if (seenChanges(rec)) {
      markSeen(rec);
      this.event('item.seen', undefined, { itemId: id });
    }
    const actions = this.actionsFor(id);
    const drafts = Object.fromEntries(actions.filter((a) => this.s.drafts[a.id]).map((a) => [a.id, this.s.drafts[a.id]]));
    const progress = Object.fromEntries(actions.filter((a) => this.progress[a.id]).map((a) => [a.id, this.progress[a.id]]));
    const results = Object.fromEntries(actions.filter((a) => this.s.results[a.id]).map((a) => [a.id, this.s.results[a.id]]));
    return {
      summary,
      item: this.withCalendarShown(structuredClone(topicItem(rec.item, parts).item)),
      ...(pieces && { pieces }),
      decision: rec.decision,
      correction: rec.correction,
      batch: rec.batch,
      actions: structuredClone(actions),
      drafts: structuredClone(drafts),
      progress: { ...progress },
      results,
      excludedPageIds: this.s.settings.confluence.exclude.map((p) => p.id),
      closesOnReply: closesOnReply(this.s.settings, rec.item.source),
      dryRun: this.s.settings.dryRun,
      dataDir: this.s.settings.dataDir,
      targets: { confluenceSite: this.s.settings.confluence.siteUrl, spaceKey: this.s.settings.confluence.spaceKey, vaultPath: this.s.settings.vaultPath },
      budgets,
      meId: FRANK,
      ...(this.categoryTagsOf(rec.item.meeting?.calendar?.eventId) && { calendarCategories: this.categoryTagsOf(rec.item.meeting?.calendar?.eventId) }),
    };
  }

  async getUsage(): Promise<UsageView> {
    await this.gate(QUERY_MS);
    const now = this.now();
    const todayKey = londonParts(now).dateKey;
    const today = this.s.usage.filter((u) => londonParts(u.at).dateKey === todayKey);
    const budgets = this.budgets();
    const isDraft = (p: UsagePurpose) => p === 'draft_vault' || p === 'draft_confluence';

    const days: UsageView['days'] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 3600_000);
      const key = londonParts(d).dateKey;
      const rows = this.s.usage.filter((u) => londonParts(u.at).dateKey === key);
      days.push({
        date: key,
        label: londonParts(d).weekday,
        triage: rows.filter((u) => !isDraft(u.purpose)).reduce((s, u) => s + u.costEquivalent, 0),
        drafts: rows.filter((u) => isDraft(u.purpose)).reduce((s, u) => s + u.costEquivalent, 0),
      });
    }

    const group = new Map<string, UsageRow>();
    for (const u of today) {
      const k = `${u.purpose}|${u.model}`;
      const row = group.get(k) ?? { purpose: u.purpose, model: u.model, calls: 0, tokens: 0, costEquivalent: 0 };
      row.calls += 1;
      row.tokens += u.inputTokens + u.outputTokens + u.cacheTokens;
      row.costEquivalent += u.costEquivalent;
      group.set(k, row);
    }

    const last = this.s.evals[this.s.evals.length - 1];
    const tok = today.reduce(
      (t, u) => ({ input: t.input + u.inputTokens, output: t.output + u.outputTokens, cache: t.cache + u.cacheTokens }),
      { input: 0, output: 0, cache: 0 },
    );
    return {
      today: {
        costEquivalent: budgets.cost.used,
        pctOfBaseline: budgets.pctOfBaseline,
        triageCalls: budgets.triage.used,
        threadsTriaged: today.filter((u) => u.purpose === 'triage').reduce((s, u) => s + Math.max(1, Math.round((u.inputTokens - 2200) / 900)), 0),
        pollsSkipped: this.s.pollsSkippedToday,
        draftsVault: today.filter((u) => u.purpose === 'draft_vault').length,
        draftsConfluence: today.filter((u) => u.purpose === 'draft_confluence').length,
        tokens: { ...tok, total: tok.input + tok.output + tok.cache },
      },
      days,
      budgets,
      byPurpose: [...group.values()].sort((a, b) => b.costEquivalent - a.costEquivalent),
      source: this.sourceHealth(),
      sources: [this.sourceHealth(), ...this.outlookHealth(), ...this.wisprHealth()],
      criteria: [...this.criteria(last, budgets), ...replyCloseCriteria(this.closes(), this.now())],
      lastEval: last,
      evalRunning: this.s.evalRunning,
    };
  }

  /** The close counts behind C1 and C2, from the mock's own event log, as the server's projection keeps them. */
  private closes() {
    try {
      return replay(this.s.events).closes;
    } catch {
      return undefined; // a staged preset whose log doesn't replay
    }
  }

  private criteria(last: EvalReport | undefined, budgets: BudgetState): Criterion[] {
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const c = last?.confusion;
    const precision = c ? (c[0][0] + c[1][1]) / (c[0][0] + c[1][0] + c[2][0] + c[0][1] + c[1][1] + c[2][1]) : undefined;
    const recall = c ? c[0][0] / (c[0][0] + c[0][1] + c[0][2]) : undefined;
    const written = Object.values(this.s.actions).filter((a) => a.type === 'confluence_entry' && a.status === 'done').length;
    return [
      precision === undefined
        ? { id: 'S1', name: 'Precision, now + today', value: '—', target: '≥ 80%', status: 'pending', statusLabel: 'No eval yet' }
        : { id: 'S1', name: 'Precision, now + today', value: pct(precision), target: '≥ 80%', status: precision >= 0.8 ? 'on_track' : 'at_risk', statusLabel: precision >= 0.8 ? 'On track' : 'At risk' },
      recall === undefined
        ? { id: 'S2', name: 'Recall, now', value: '—', target: '≥ 90%', status: 'pending', statusLabel: 'No eval yet' }
        : { id: 'S2', name: 'Recall, now', value: pct(recall), target: '≥ 90%', status: recall >= 0.9 ? 'on_track' : 'at_risk', statusLabel: recall >= 0.9 ? 'On track' : 'At risk' },
      budgets.pctOfBaseline === null
        ? { id: 'S3', name: 'Daily usage vs baseline', value: '—', target: '≤ 100%', status: 'pending', statusLabel: 'Baseline not measured' }
        : {
            id: 'S3',
            name: 'Daily usage vs baseline',
            value: `${budgets.pctOfBaseline}%`,
            target: '≤ 100%',
            status: budgets.pctOfBaseline <= 100 ? 'on_track' : 'at_risk',
            statusLabel: budgets.pctOfBaseline <= 100 ? 'On track' : 'Over baseline',
          },
      { id: 'S4', name: 'Dashboard opened', value: '4 / 5', target: '≥ 4 of 5 days', status: 'on_track', statusLabel: 'On track' },
      { id: 'S5', name: 'Writes without approval', value: '0', target: '0', status: 'met', statusLabel: 'Met' },
      { id: 'S6', name: 'People observations in Confluence', value: '0', target: '0', status: 'met', statusLabel: `Met · ${written} ${written === 1 ? 'entry' : 'entries'} checked` },
      { id: 'S7', name: 'Slack digest task', value: 'Enabled', target: 'Disabled', status: 'pending', statusLabel: 'Parallel run 2/3' },
    ];
  }

  async getEvalReports(): Promise<EvalReport[]> {
    await this.gate(QUERY_MS);
    return [...this.s.evals].reverse();
  }

  private startupChecks(): StartupCheck[] {
    const f = this.s.flags;
    return [
      f.fileVaultOff
        ? { id: 'filevault', label: 'FileVault on', status: 'warn', note: 'off: local files hold company messages' }
        : { id: 'filevault', label: 'FileVault on', status: 'ok', note: 'ok' },
      f.startupFailure === 'api_key'
        ? { id: 'api_key', label: 'ANTHROPIC_API_KEY not set', status: 'fail', note: 'set in environment' }
        : { id: 'api_key', label: 'ANTHROPIC_API_KEY not set', status: 'ok', note: 'ok' },
      f.startupFailure === 'slack_token' || this.s.source.status === 'auth_failed'
        ? { id: 'slack_token', label: 'Slack token in Keychain', status: 'fail', note: f.startupFailure === 'slack_token' ? 'missing' : 'rejected by Slack' }
        : { id: 'slack_token', label: 'Slack token in Keychain', status: 'ok', note: 'ok' },
      f.startupFailure === 'claude_login'
        ? { id: 'claude_login', label: 'Claude login works', status: 'fail', note: 'not logged in' }
        : { id: 'claude_login', label: 'Claude login works', status: 'ok', note: 'haiku · 1 call' },
    ];
  }

  async getSettings(): Promise<SettingsView> {
    await this.gate(QUERY_MS);
    return {
      settings: structuredClone(this.s.settings),
      rules: structuredClone(this.s.rules),
      ruleHits: { ...this.s.ruleHits },
      savedAt: this.s.savedAt,
      checks: this.startupChecks(),
      checkedAt: this.s.checkedAt,
      labelCount: this.s.labelCount,
      correctionCount: this.s.correctionCount,
      vaultConventionsLoaded: true,
    };
  }

  async getWisprStatus(): Promise<WisprStatusView> {
    await this.gate(QUERY_MS);
    const w = this.s.wispr;
    return w?.connected ? { connected: true, ...(w.account && { account: w.account }) } : { connected: false };
  }

  /** The mock has no sign-in page: Connect signs in at once, like `--fakes`, turns the source on and polls it. */
  async connectWispr(): Promise<WisprConnectView> {
    await this.gate(COMMAND_MS);
    const first = !this.s.wispr?.read;
    this.s.wispr = { connected: true, account: 'Frank Keulers', read: true };
    this.s.settings = { ...this.s.settings, sources: { ...this.s.settings.sources, wispr: { ...this.s.settings.sources?.wispr, enabled: true } } };
    this.emit({ topic: 'settings' }, { topic: 'health' }, { topic: 'inbox' });
    if (first) void this.runPoll('manual', { threads: [WISPR_MEETING] });
    return {};
  }

  async disconnectWispr() {
    await this.gate(COMMAND_MS);
    this.s.wispr = { ...this.s.wispr, connected: false };
    this.s.settings = { ...this.s.settings, sources: { ...this.s.settings.sources, wispr: { ...this.s.settings.sources?.wispr, enabled: false } } };
    this.emit({ topic: 'settings' }, { topic: 'health' }, { topic: 'inbox' });
  }

  private outlookView(): OutlookStatusView {
    const o = this.s.outlook;
    const chosen = Object.keys(this.s.settings.calendar?.categoryColors ?? {});
    const seen = this.calendarOn() ? Object.values(CALENDAR_CATEGORIES).flat() : [];
    const categories = [...new Map([...seen, ...chosen].map((n) => [n.toLowerCase(), n])).values()].sort((a, b) => a.localeCompare(b));
    return { ...(o && { connectorId: o.connectorId, account: o.account }), enabled: sourceSchedule(this.s.settings, 'outlook').enabled, ...(categories.length && { categories }) };
  }

  private calendarOn = () => !!this.s.outlook && sourceSchedule(this.s.settings, 'calendar').enabled;

  /** A seed event's Outlook categories, in the colours chosen in Settings › Outlook (R2.8). */
  private categoryTagsOf(eventId: string | undefined): CategoryTag[] | undefined {
    const names = eventId ? CALENDAR_CATEGORIES[eventId] : undefined;
    return names && this.calendarOn() ? categoryTags(names, this.s.settings.calendar?.categoryColors) : undefined;
  }

  async getOutlookStatus(): Promise<OutlookStatusView> {
    await this.gate(QUERY_MS);
    return this.outlookView();
  }

  /** Finds the mock's connector, or takes the one entered if it is that one; the first Connect brings the mail in. */
  async connectOutlook(connectorId?: string): Promise<OutlookStatusView> {
    await this.gate(COMMAND_MS);
    if (connectorId !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(connectorId)) throw new ApiError('validation', 'That isn’t a connector ID: it has only letters, digits, - and _.');
    if (connectorId && connectorId !== MOCK_CONNECTOR_ID) throw new ApiError('unavailable', 'claude.ai has no connector with that ID, or it is signed out. Check the ID, or leave it empty to find the connector.');
    const first = !this.s.outlook?.read;
    this.s.outlook = { connectorId: MOCK_CONNECTOR_ID, account: { name: 'Frank Keulers', address: 'frank.keulers@polestarglobal.example' }, read: true };
    this.s.settings = { ...this.s.settings, sources: { ...this.s.settings.sources, outlook: { ...this.s.settings.sources?.outlook, enabled: true } } };
    this.emit({ topic: 'settings' }, { topic: 'health' }, { topic: 'inbox' });
    if (first) void this.runPoll('manual', { threads: OUTLOOK_THREADS });
    return this.outlookView();
  }

  /** The first calendar poll, once Outlook is connected and the calendar on, brings the invite you haven't answered. */
  private readCalendarOnce() {
    if (!this.s.outlook || this.s.outlook.calendarRead || !sourceSchedule(this.s.settings, 'calendar').enabled) return;
    this.s.outlook = { ...this.s.outlook, calendarRead: true };
    // On the timeline, and polled once the poll that Connect started is over, so it isn't lost.
    this.s.timeline.push({ at: this.iso(), thread: CALENDAR_INVITE });
    const poll = () => (this.polling ? void setTimeout(poll, 200) : void this.runPoll('manual'));
    poll();
  }

  /** A meeting's calendar event shows only while the calendar is read, as on the server (R2.8). */
  private withCalendarShown(item: Item): Item {
    if (!item.meeting?.calendar || (this.s.outlook && sourceSchedule(this.s.settings, 'calendar').enabled)) return item;
    const { calendar: _hidden, ...meeting } = item.meeting;
    return { ...item, meeting };
  }

  /** The seed week's calendar, once Outlook is connected and the calendar is on (R2.8). */
  async getAgenda(): Promise<AgendaView> {
    await this.gate(QUERY_MS);
    const leadMinutes = meetingLead(this.s.settings);
    if (!this.s.outlook || !sourceSchedule(this.s.settings, 'calendar').enabled) return { state: 'off', events: [], leadMinutes };
    // A Wispr Flow meeting joined to an event is its notes; an open invite item is its "Not answered".
    const joined = (source: Item['source'], open: boolean) =>
      new Map(Object.values(this.s.items).flatMap((r) => (r.item.source === source && r.item.meeting?.calendar && (!open || r.status === 'open') ? [[r.item.meeting.calendar.eventId, r.item.id] as const] : [])));
    const notes = joined('wispr', false);
    const invites = joined('calendar', true);
    const events = CALENDAR.map((e) => ({ ...e, ...(notes.has(e.id) && { notesItemId: notes.get(e.id) }), ...(invites.has(e.id) && { inviteItemId: invites.get(e.id) }), ...(CALENDAR_CATEGORIES[e.id] && { categories: this.categoryTagsOf(e.id) }) }));
    return { state: 'ok', polledAt: this.s.source.lastPollAt ?? this.iso(), events, leadMinutes };
  }

  /** Turns Outlook mail and calendar off: both read through the connector. */
  async disconnectOutlook() {
    await this.gate(COMMAND_MS);
    const src = this.s.settings.sources;
    this.s.settings = { ...this.s.settings, sources: { ...src, outlook: { ...src?.outlook, enabled: false }, calendar: { ...src?.calendar, enabled: false } } };
    this.emit({ topic: 'settings' }, { topic: 'health' }, { topic: 'inbox' });
  }

  // ---------------------------------------------------------------- item commands

  async pollNow() {
    await this.gate(COMMAND_MS);
    const src = this.s.source;
    if (src.status === 'auth_failed') {
      this.event('source.failed', { source: 'slack', error: 'invalid_auth' });
      this.emit({ topic: 'inbox' });
      throw new ApiError('forbidden', 'Slack rejected the token. Fix it in the Keychain, then poll again.');
    }
    if (src.status === 'backoff' && src.retryAt && src.retryAt > this.iso()) {
      throw new ApiError('conflict', 'Slack is rate-limiting. The next poll runs after Retry-After.');
    }
    if (this.polling) return;
    void this.runPoll(this.s.flags.firstRun ? 'first' : 'manual');
  }

  async markDone(itemId: string) {
    await this.gate(COMMAND_MS);
    markDone(this.rec(itemId), this.iso());
    followAnchor(this.s.items, itemId);
    this.event('item.done', undefined, { itemId });
    this.emit({ topic: 'inbox' }, { topic: 'item', id: itemId });
  }

  async markDoneMany(itemIds: string[]) {
    await this.gate(COMMAND_MS);
    const ids = [...new Set(itemIds)].filter((id) => this.rec(id).status !== 'done');
    for (const id of ids) {
      markDone(this.rec(id), this.iso());
      followAnchor(this.s.items, id);
      this.event('item.done', undefined, { itemId: id });
    }
    this.emit({ topic: 'inbox' }, ...ids.map((id) => ({ topic: 'item' as const, id })));
    return { count: ids.length };
  }

  async reopenMany(itemIds: string[]) {
    await this.gate(COMMAND_MS);
    const ids = [...new Set(itemIds)].filter((id) => this.rec(id).status === 'done');
    for (const id of ids) {
      reopen(this.rec(id));
      followAnchor(this.s.items, id);
      this.event('item.reopened', undefined, { itemId: id });
    }
    this.emit({ topic: 'inbox' }, ...ids.map((id) => ({ topic: 'item' as const, id })));
    return { count: ids.length };
  }

  async reopen(itemId: string) {
    await this.gate(COMMAND_MS);
    reopen(this.rec(itemId));
    followAnchor(this.s.items, itemId);
    this.event('item.reopened', undefined, { itemId });
    this.emit({ topic: 'inbox' }, { topic: 'item', id: itemId });
  }

  async snooze(itemId: string, untilIso: string) {
    await this.gate(COMMAND_MS);
    if (untilIso <= this.iso()) throw new ApiError('validation', 'Pick a time in the future.', [{ path: 'until', message: 'Pick a time in the future' }]);
    snooze(this.rec(itemId), untilIso);
    followAnchor(this.s.items, itemId);
    this.event('item.snoozed', { until: untilIso }, { itemId });
    this.emit({ topic: 'inbox' }, { topic: 'item', id: itemId });
  }

  async correctTriage(itemId: string, input: CorrectionInput) {
    await this.gate(COMMAND_MS);
    const rec = this.rec(itemId);
    const correction = { itemId, itemRevision: rec.item.revision, ...input, correctedAt: this.iso() };
    correct(rec, correction);
    this.s.labelCount += 1;
    this.s.correctionCount += 1;
    this.event('triage.corrected', { correction }, { itemId });
    this.emit({ topic: 'inbox' }, { topic: 'item', id: itemId }, { topic: 'settings' });
    return { labelCount: this.s.labelCount };
  }

  async retryTriage(itemId: string) {
    await this.gate(COMMAND_MS);
    const rec = this.rec(itemId);
    if (this.budgets().triage.hit) throw new ApiError('budget', 'Triage budget reached for today. Rules still run; model triage resumes tomorrow.');
    rec.triageState = 'pending';
    rec.failTriage = 0;
    this.emit({ topic: 'inbox' }, { topic: 'item', id: itemId });
    await sleep(1200);
    this.triageBatch([rec]);
    this.emit({ topic: 'inbox' }, { topic: 'usage' }, { topic: 'item', id: itemId });
  }

  // ---------------------------------------------------------------- topics

  async markAskDone(itemId: string, askId: string) {
    await this.gate(COMMAND_MS);
    const rec = this.anchor(itemId);
    markAskDone(rec, askId);
    this.event('topic.askDone', { askId }, { itemId: rec.item.id });
    this.emit({ topic: 'inbox' }, { topic: 'item', id: rec.item.id });
  }

  async replied(itemId: string) {
    await this.gate(COMMAND_MS);
    this.rec(itemId);
    return { scheduled: false }; // the mock has no source to read again: Scenarios › Frank replies stands in
  }

  async splitPiece(pieceId: string) {
    await this.gate(COMMAND_MS);
    const rec = this.rec(pieceId);
    const from = rec.topicOf;
    if (!from) throw new ApiError('conflict', 'This piece is the topic itself, so it can’t be split out. Split out the other pieces instead.');
    routeTopic(this.s.items, recActivity, pieceId, undefined, 'user');
    this.event('topic.routed', { from, by: 'user' }, { itemId: pieceId });
    this.emit({ topic: 'inbox' }, { topic: 'item', id: pieceId }, { topic: 'item', id: from });
    // Both are triaged again: the piece on its own, the topic without it.
    await sleep(1200);
    if (!this.budgets().triage.hit) this.triageBatch([rec, this.rec(from)]);
    this.emit({ topic: 'inbox' }, { topic: 'usage' }, { topic: 'item', id: pieceId }, { topic: 'item', id: from });
  }

  async regroup(conversation: string) {
    await this.gate(COMMAND_MS);
    if (this.budgets().triage.hit) throw new ApiError('budget', 'Triage budget reached for today, so topics can’t be regrouped until tomorrow.');
    const open = Object.values(this.s.items).filter((r) => !r.topicOf && r.status !== 'done' && conversationOf(r.item) === conversation);
    await sleep(900);
    this.recordUsage('routing', 'haiku-5.5', 900 + open.length * 400, 40 + open.length * 20, open.map((r) => r.item.id), 'topics v1', 1400);
    // As scripted by the seed: a piece with regroupWith joins that seed's topic.
    const topics = new Set<ItemRec>();
    let merged = 0;
    for (const r of open) {
      const into = r.regroupKey ? open.find((x) => x.key === r.regroupKey) : undefined;
      if (!into || r.notWith?.includes(into.item.id)) continue;
      routeTopic(this.s.items, recActivity, r.item.id, into.item.id, 'regroup');
      this.event('topic.routed', { into: into.item.id, by: 'regroup' }, { itemId: r.item.id });
      // The "model" re-triages the topic as a whole: as urgent as its most urgent piece.
      if (RANK[r.script.attention] > RANK[into.script.attention]) into.script = { ...r.script };
      topics.add(into);
      merged++;
    }
    if (topics.size) this.triageBatch([...topics]);
    this.emit({ topic: 'inbox' }, { topic: 'usage' }, ...open.map((r) => ({ topic: 'item' as const, id: r.item.id })));
    return { merged };
  }

  // ---------------------------------------------------------------- drafts & actions

  private takeOutcome(applies: (o: DraftOutcome) => boolean): DraftOutcome {
    const o = this.s.nextDraftOutcome;
    if (o !== 'normal' && applies(o)) {
      this.s.nextDraftOutcome = 'normal';
      return o;
    }
    return 'normal';
  }

  async requestDraft(itemId: string, type: ActionType): Promise<Action> {
    await this.gate(COMMAND_MS);
    const rec = this.rec(itemId);
    const existing = this.actionsFor(itemId).find((a) => a.type === type && ACTIVE.includes(a.status));
    if (existing) return structuredClone(existing);
    if (this.budgets().drafts.hit) throw new ApiError('budget', 'Drafts budget reached for today. Drafting resumes tomorrow, or raise the budget in Settings.');
    if (type === 'confluence_entry' && rec.decision?.containsPeopleObservations) {
      throw new ApiError('forbidden', 'This thread contains observations about people, so it can only go to the vault (FR-10.1).');
    }
    const outcome = this.takeOutcome((o) => o === 'model_error' || (type === 'confluence_entry' && (o === 'people_check' || o === 'allow_list' || o === 'no_fit')));
    return structuredClone(this.createAction(rec, type, outcome));
  }

  private createAction(rec: ItemRec, type: ActionType, outcome: DraftOutcome, supersedes?: string): Action {
    const id = `act-${rec.key}-${type === 'vault_note' ? 'v' : 'c'}${this.s.seq + 1}`;
    this.event('action.requested', { type, revision: rec.item.revision, ...(supersedes && { supersedes }) }, { itemId: rec.item.id, actionId: id });
    const action = this.s.actions[id];
    this.startDrafting(action, outcome);
    this.emit({ topic: 'inbox' }, { topic: 'item', id: rec.item.id });
    return action;
  }

  private startDrafting(action: Action, outcome: DraftOutcome) {
    const stages = DRAFT_STAGES[action.type];
    this.progress[action.id] = { stages, stage: 0, startedAt: Date.now() };
    const timers: ReturnType<typeof setTimeout>[] = [];
    // The people check and the picker fail on their own stages, so the failure lands where it happens.
    const lastStage = outcome === 'people_check' ? stages.length - 1 : outcome === 'no_fit' ? stages.indexOf('Picking the page') : stages.length;
    for (let i = 1; i < stages.length; i++) {
      timers.push(
        setTimeout(() => {
          const p = this.progress[action.id];
          if (!p) return;
          this.progress[action.id] = { ...p, stage: i };
          this.emit({ topic: 'item', id: action.itemId });
        }, i * STAGE_MS),
      );
    }
    timers.push(setTimeout(() => this.finishDraft(action.id, outcome), lastStage * STAGE_MS + (outcome === 'people_check' ? 900 : 400)));
    this.draftTimers.set(action.id, timers);
  }

  private clearDraftTimers(actionId: string) {
    for (const t of this.draftTimers.get(actionId) ?? []) clearTimeout(t);
    this.draftTimers.delete(actionId);
    delete this.progress[actionId];
  }

  private finishDraft(actionId: string, outcome: DraftOutcome) {
    const action = this.s.actions[actionId];
    this.clearDraftTimers(actionId);
    if (!action || action.status !== 'drafting') return;
    const rec = this.s.items[action.itemId];
    if (!rec) return;
    const now = this.iso();
    const model = action.type === 'vault_note' ? this.s.settings.models.draftVault : this.s.settings.models.draftConfluence;
    const purpose: UsagePurpose = action.type === 'vault_note' ? 'draft_vault' : 'draft_confluence';
    let ready = false;

    if (outcome === 'model_error') {
      this.recordUsage(purpose, model, 21000, 900, [rec.item.id], 'draft v2', 44000);
      action.error = 'The draft did not match the expected format twice, so it was dropped.';
      this.s.results[actionId] = action.error;
      this.event('action.failed', { reason: 'model_error' }, { itemId: rec.item.id, actionId });
    } else if (outcome === 'no_fit') {
      this.recordUsage('confluence_pick', model, 9000, 90, [rec.item.id], 'pick-confluence v1', 9000);
      action.error = 'The thread is about AIS pricing for Defence, and there is no DEF - Pricing page in the catalogue. Suggested home: DEF - Pricing.';
      this.s.results[actionId] = action.error;
      this.event('action.failed', { reason: 'no_fit' }, { itemId: rec.item.id, actionId });
    } else {
      const attempt = this.actionsFor(rec.item.id).filter((a) => a.type === action.type).length;
      const draft = buildDraft(rec, action.type, this.s.settings, now, { attempt, forceOffList: outcome === 'allow_list' });
      if (action.type === 'confluence_entry') this.recordUsage('confluence_pick', model, 9000, 90, [rec.item.id], 'pick-confluence v1', 9000);
      this.recordUsage(purpose, model, Math.round(draft.tokens * 0.93), Math.round(draft.tokens * 0.07), [rec.item.id], draft.promptVersion, draft.durationMs);
      if (action.type === 'confluence_entry') this.recordUsage('people_check', 'haiku-5.5', 2100, 60, [rec.item.id], 'people-check v1', 1900);
      if (outcome === 'people_check') {
        action.error = 'The people check found observations about named people in the draft. Nothing will be written to Confluence.';
        this.s.results[actionId] = action.error;
        this.event('action.failed', { reason: 'people_check' }, { itemId: rec.item.id, actionId });
      } else {
        this.s.drafts[actionId] = draft;
        const target = draft.kind === 'confluence' ? { pageId: draft.pageId, baseVersion: draft.baseVersion } : { path: draft.path };
        this.event('action.drafted', { type: action.type, revision: rec.item.revision, draftRef: action.draftRef, tokens: draft.tokens, target }, { itemId: rec.item.id, actionId });
        ready = true;
      }
    }
    this.emit({ topic: 'item', id: rec.item.id }, { topic: 'inbox' }, { topic: 'usage' });
    if (ready) {
      this.emit({ topic: 'draft_ready', itemId: rec.item.id, actionId, type: action.type, title: rec.item.title });
    }
  }

  private action(id: string) {
    const a = this.s.actions[id];
    if (!a) throw new ApiError('not_found', 'Action not found.');
    return a;
  }

  async cancelDraft(actionId: string) {
    await this.gate(COMMAND_MS);
    const a = this.action(actionId);
    if (a.status !== 'drafting') return;
    this.clearDraftTimers(actionId);
    this.event('action.discarded', { reason: 'cancelled' }, { itemId: a.itemId, actionId });
    this.emit({ topic: 'item', id: a.itemId }, { topic: 'inbox' });
  }

  async saveDraftEdit(actionId: string, content: string) {
    await this.gate(COMMAND_MS);
    const a = this.action(actionId);
    const d = this.s.drafts[actionId];
    if (a.status !== 'ready' || !d) throw new ApiError('conflict', 'This draft can no longer be edited.');
    this.s.drafts[actionId] = { ...d, content, edited: true };
    this.event('action.edited', undefined, { itemId: a.itemId, actionId });
    this.emit({ topic: 'item', id: a.itemId });
  }

  async redraft(actionId: string): Promise<Action> {
    await this.gate(COMMAND_MS);
    const a = this.action(actionId);
    if (this.budgets().drafts.hit) throw new ApiError('budget', 'Drafts budget reached for today.');
    if (ACTIVE.includes(a.status) || a.status === 'failed') {
      this.clearDraftTimers(actionId);
      if (a.status !== 'failed') {
        this.event('action.discarded', { reason: 'redraft' }, { itemId: a.itemId, actionId });
      }
    }
    const rec = this.rec(a.itemId);
    const outcome = this.takeOutcome((o) => o === 'model_error' || (a.type === 'confluence_entry' && (o === 'people_check' || o === 'allow_list' || o === 'no_fit')));
    return structuredClone(this.createAction(rec, a.type, outcome, a.id));
  }

  async discardAction(actionId: string) {
    await this.gate(COMMAND_MS);
    const a = this.action(actionId);
    this.clearDraftTimers(actionId);
    this.event('action.discarded', { reason: 'discarded' }, { itemId: a.itemId, actionId });
    this.emit({ topic: 'item', id: a.itemId }, { topic: 'inbox' });
  }

  async approveAction(actionId: string, opts: { markDoneWhenFiled?: boolean } = {}) {
    await this.gate(COMMAND_MS);
    const a = this.action(actionId);
    if (a.status !== 'ready') throw new ApiError('conflict', 'This draft is no longer ready to approve.');
    this.event('action.approved', opts.markDoneWhenFiled ? { markDoneWhenFiled: true } : undefined, { itemId: a.itemId, actionId });
    this.emit({ topic: 'item', id: a.itemId }, { topic: 'inbox' });
    void this.execute(actionId, 500);
  }

  /** The executor: code writes, after re-validating the target (NF-5, FR-9.4, FR-10.5, FR-10.6). */
  private async execute(actionId: string, delay: number) {
    await sleep(delay);
    const a = this.s.actions[actionId];
    if (!a) return;
    this.event('action.executing', { attempt: 1 }, { itemId: a.itemId, actionId });
    this.emit({ topic: 'item', id: a.itemId });
    await sleep(delay ? 1300 : 0);
    const d = this.s.drafts[actionId];
    const rec = this.s.items[a.itemId];
    if (!d || !rec) return;
    const conflict = this.takeOutcome((o) => (a.type === 'vault_note' ? o === 'vault_conflict' : o === 'confluence_conflict'));
    const dry = this.s.settings.dryRun;

    if (conflict !== 'normal') {
      a.error =
        d.kind === 'confluence'
          ? `The page changed after drafting (v${d.baseVersion} → v${d.baseVersion + 2}). Re-drafting instead of writing.`
          : d.kind === 'vault_append'
            ? `${d.path} changed after drafting (file hash differs). Re-drafting instead of writing.`
            : `A note now exists at ${d.path}. Re-drafting instead of overwriting it.`;
      this.s.results[actionId] = a.error;
      this.event('action.failed', { reason: 'conflict' }, { itemId: a.itemId, actionId });
      this.emit({ topic: 'item', id: a.itemId });
      await sleep(900);
      this.createAction(rec, a.type, 'normal', a.id);
      return;
    }

    if (d.kind === 'confluence' && !inMockScope(this.s.settings.confluence, d.pageId)) {
      a.error = `Page ${d.pageId} (${d.pageTitle}) is not in the Confluence scope. The executor refused the write.`;
      this.s.results[actionId] = a.error;
      this.event('action.failed', { reason: 'allow_list', pageId: d.pageId }, { itemId: a.itemId, actionId });
      this.emit({ topic: 'item', id: a.itemId }, { topic: 'inbox' });
      return;
    }

    let msg: string;
    if (d.kind === 'confluence') {
      msg = dry
        ? `Dry-run: write logged only. ${d.pageTitle} stays at v${d.baseVersion}. Logged action.executed.`
        : `Written to ${d.pageTitle}, now v${d.baseVersion + 1}. Logged action.executed.`;
      this.event('action.executed', { dryRun: dry, pageId: d.pageId, pageVersion: dry ? d.baseVersion : d.baseVersion + 1 }, { itemId: a.itemId, actionId });
    } else {
      const where = dry ? `${this.s.settings.dataDir}/sandbox/vault/${d.path}` : `${this.s.settings.vaultPath}/${d.path}`;
      msg = `${dry ? 'Dry-run: ' : ''}${d.kind === 'vault_append' ? `Appended under ${d.heading} in` : 'Created'} ${where}. Logged action.executed.`;
      this.event('action.executed', { dryRun: dry, path: where }, { itemId: a.itemId, actionId });
    }
    this.s.results[actionId] = msg;
    // Filed in a batch (CK-4.4): done once every filing it suggests is written.
    const mine = Object.values(this.s.actions).filter((b) => b.itemId === a.itemId).reverse();
    if (a.markDoneWhenFiled && rec.status === 'open' && filedAll(rec, mine)) {
      markDone(rec, this.iso());
      this.event('item.done', undefined, { itemId: a.itemId });
    }
    this.emit({ topic: 'item', id: a.itemId }, { topic: 'inbox' });
  }

  // ---------------------------------------------------------------- usage, eval, settings

  async runEval() {
    await this.gate(COMMAND_MS);
    if (this.s.evalRunning) return;
    this.s.evalRunning = true;
    this.emit({ topic: 'usage' }, { topic: 'evals' });
    setTimeout(() => {
      const prev = this.s.evals[this.s.evals.length - 1];
      const labels = this.s.labelCount;
      const base = prev?.confusion ?? [
        [20, 3, 1],
        [5, 42, 10],
        [2, 10, 100],
      ];
      // A little better on "today" each run, to make the comparison visible.
      const confusion = base.map((row, i) => (i === 1 ? [row[0], row[1] + 2, Math.max(0, row[2] - 1)] : [...row]));
      const pr = (i: number) => {
        const tp = confusion[i][i];
        const col = confusion.reduce((s, r) => s + r[i], 0);
        const row = confusion[i].reduce((s, v) => s + v, 0);
        return { precision: col ? tp / col : 0, recall: row ? tp / row : 0, support: row };
      };
      const report: EvalReport = {
        id: `eval-${this.iso()}`,
        at: this.iso(),
        labelCount: labels,
        promptVersion: 'triage v3',
        model: this.s.settings.models.triage,
        categories: {
          now: pr(0),
          today: pr(1),
          none: pr(2),
          confluence: { precision: 0.8, recall: 0.83, support: 35 },
          vault: { precision: 0.81, recall: 0.86, support: 45 },
        },
        confusion,
        tokens: 446000,
        costEquivalent: 0.67,
      };
      this.s.evals.push(report);
      this.recordUsage('eval', this.s.settings.models.triage, 420000, 26000, [], 'triage v3', 52000);
      this.s.evalRunning = false;
      this.emit({ topic: 'usage' }, { topic: 'evals' });
    }, 5000);
  }

  async rebuildState() {
    await this.gate(COMMAND_MS);
    await sleep(1800);
    const time = this.now().toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
    this.s.flags.rebuiltNotice = `Inbox state rebuilt from ${this.s.events.length.toLocaleString('en-GB')} events at ${time}. Nothing was lost.`;
    this.emit({ topic: 'inbox' });
    return { events: this.s.events.length };
  }

  async saveSettings(sent: Settings, sentRules: Rule[], base?: { settings: Settings; rules: Rule[] }): Promise<SettingsSaved> {
    await this.gate(COMMAND_MS + 200);
    // As the server: only what changed from the form's base, so Connect's change made meanwhile stays.
    const settings = base ? mergeEdit(this.s.settings, base.settings, sent) : sent;
    const rules = base ? mergeEdit(this.s.rules, base.rules, sentRules) : sentRules;
    const issues: FieldIssue[] = [];
    const sp = SettingsSchema.safeParse(settings);
    if (!sp.success) for (const i of sp.error.issues) issues.push({ path: ['settings', ...i.path].join('.'), message: i.message });
    const rp = Rules.safeParse(rules);
    if (!rp.success) for (const i of rp.error.issues) issues.push({ path: ['rules', ...i.path].join('.'), message: i.message });
    if (issues.length) throw new ApiError('validation', `${issues.length} ${issues.length === 1 ? 'field needs' : 'fields need'} fixing before saving.`, issues);

    const settingsChanged = JSON.stringify(this.s.settings) !== JSON.stringify(sp.data);
    const rulesChanged = JSON.stringify(this.s.rules) !== JSON.stringify(rp.data);
    if (settingsChanged) {
      const intervalsChanged = JSON.stringify(this.s.settings.schedule) !== JSON.stringify(sp.data!.schedule);
      this.s.settings = sp.data!;
      this.event('settings.changed', { dryRun: sp.data!.dryRun });
      if (intervalsChanged && this.s.source.lastPollAt) this.s.source.nextPollAt = addMins(this.s.source.lastPollAt, this.intervalMins());
    }
    if (rulesChanged) {
      this.s.rules = rp.data!;
      this.event('rules.changed', { count: rp.data!.length });
    }
    this.s.savedAt = this.iso();
    this.emit({ topic: 'settings' }, { topic: 'inbox' }, { topic: 'usage' });
    this.readCalendarOnce();
    return { savedAt: this.s.savedAt, settings: structuredClone(this.s.settings), rules: structuredClone(this.s.rules) };
  }

  // ---------------------------------------------------------------- prompt files (FR-1.7)

  private promptView(id: PromptFileId): PromptFileView {
    const f = SEED_PROMPT_FILES.find((p) => p.id === id);
    if (!f) throw new ApiError('not_found', `There is no prompt file called ${id}.`);
    const text = (this.s.prompts?.[id] ?? '').trim() || f.defaultText.trim();
    const { defaultText, sources = [], ...meta } = f;
    const reviewed = this.s.reviewedPrompts?.includes(id);
    return {
      ...meta,
      text,
      version: promptVersion(text),
      defaultVersion: promptVersion(defaultText.trim()),
      edited: text !== defaultText.trim(),
      sources: sources.map((x) => ({ ...x, state: reviewed && x.state === 'changed' ? 'current' : x.state })),
    };
  }

  async getPrompts(): Promise<PromptFileView[]> {
    await this.gate(QUERY_MS);
    return SEED_PROMPT_FILES.map((f) => this.promptView(f.id));
  }

  private writePrompt(id: PromptFileId, baseVersion: string, text: string, reset: boolean): PromptFileView {
    const current = this.promptView(id);
    if (current.version !== baseVersion) throw new ApiError('conflict', `${current.label} changed since you opened it (now ${current.version}). Reload it, then make your change again.`);
    this.s.prompts = { ...this.s.prompts, [id]: text.trim() };
    const saved = this.promptView(id);
    this.event('prompt.changed', { id, version: saved.version, reset });
    this.emit({ topic: 'settings' });
    return saved;
  }

  async savePrompt(id: PromptFileId, text: string, baseVersion: string) {
    await this.gate(COMMAND_MS);
    if (!text.trim()) throw new ApiError('validation', 'Send { text, baseVersion } with some text.', [{ path: 'text', message: 'The file can’t be empty' }]);
    return this.writePrompt(id, baseVersion, text, false);
  }

  async markPromptReviewed(id: PromptFileId, baseVersion: string) {
    await this.gate(COMMAND_MS);
    const current = this.promptView(id);
    if (current.version !== baseVersion) throw new ApiError('conflict', `${current.label} changed since you opened it (now ${current.version}). Reload it, then make your change again.`);
    // The real server rewrites the source hashes in the header; the mock only remembers the review.
    this.s.reviewedPrompts = [...(this.s.reviewedPrompts ?? []), id];
    this.event('prompt.changed', { id, version: current.version, reset: false });
    this.emit({ topic: 'settings' });
    return this.promptView(id);
  }

  async resetPrompt(id: PromptFileId, baseVersion: string) {
    await this.gate(COMMAND_MS);
    const f = SEED_PROMPT_FILES.find((p) => p.id === id);
    return this.writePrompt(id, baseVersion, f?.defaultText ?? '', true);
  }

  // ---------------------------------------------------------------- scenario controls (MockControls)

  reset(preset: Preset = 'default') {
    for (const id of [...this.draftTimers.keys()]) this.clearDraftTimers(id);
    this.polling = false;
    this.s = buildState(preset);
    this.anchorClock(SEED_CLOCK);
    this.emitAll();
  }

  advanceClock(mins: number) {
    this.clockAnchor += mins * MIN;
    this.emit({ topic: 'clock' });
    this.tick();
    this.emitAll();
  }

  setClockLondon(hhmm: string) {
    const [h, m] = hhmm.split(':').map(Number);
    const p = londonParts(this.now());
    const cur = p.hours * 60 + p.minutes;
    let delta = h * 60 + m - cur;
    if (delta <= 0) delta += 24 * 60;
    // Move without triggering a catch-up poll: pretend the last poll happened just now.
    this.clockAnchor += delta * MIN;
    const now = this.iso();
    this.s.source.lastPollAt = now;
    this.s.source.nextPollAt = addMins(now, this.intervalMins());
    this.emitAll();
  }

  cockpitAfternoon() {
    this.reset();
    this.setClockLondon('13:48');
    this.tick(); // snoozes due back by then come back
    this.s.outlook = { connectorId: MOCK_CONNECTOR_ID, account: { name: 'Frank Keulers', address: 'frank.keulers@polestarglobal.example' }, read: true };
    const src = this.s.settings.sources;
    this.s.settings = { ...this.s.settings, sources: { ...src, outlook: { ...src?.outlook, enabled: true }, calendar: { ...src?.calendar, enabled: true } } };
    void this.runPoll('manual', { threads: OUTLOOK_THREADS });
    this.readCalendarOnce();
    this.emitAll();
  }

  frankReplies(outcome: SettleOutcome, itemId?: string) {
    // The check runs only where closing on reply is on for the source (Slack until CK-2.9).
    const checked = closeOnReply(this.s.settings).sources;
    const open = Object.values(this.s.items).filter((r) => !r.topicOf && awaitsReply(r) && checked[r.item.source]);
    const rank = (r: ItemRec) => (effectiveTriage(r.decision, r.correction)?.attention === 'now' ? 0 : 1);
    const rec = itemId ? this.s.items[itemId] : open.sort((a, b) => rank(a) - rank(b) || b.item.lastActivityAt.localeCompare(a.item.lastActivityAt))[0];
    if (!rec || !awaitsReply(rec) || !checked[rec.item.source]) return;
    const text = { settled: 'Yes, go ahead. Done on my side.', open: 'Will look later today', failed: 'Sounds good' }[outcome];
    this.ingestReply({ targetKey: rec.key, by: FRANK, text });
    this.emit({ topic: 'inbox' });
    const id = rec.item.id;
    const revision = rec.item.revision;
    const through = rec.item.lastActivityAt;
    const messageId = rec.item.messages.at(-1)!.id;
    void (async () => {
      await sleep(1200); // the poll that brought it in, then the check
      const r = this.s.items[id];
      if (!r || r.item.revision !== revision || !r.settlePending) return;
      const at = this.iso();
      if (outcome === 'failed') {
        const data = { revision, attempts: SETTLE_MAX_ATTEMPTS, reason: 'claude unavailable' };
        settleFailed(r, data.attempts);
        this.event('settle.failed', data, { itemId: id });
      } else {
        const next = r.decision?.next;
        const asks = next?.asks?.filter((a) => !(r.asksDone ?? []).includes(askId(a.step))) ?? (next ? [next] : []);
        const settled = outcome === 'settled';
        const data = { revision, through, batchId: `settle-${at}-1`, allSettled: settled, settled: settled ? asks.map((a) => askId(a.step)) : [] };
        this.recordUsage('settle', this.s.settings.models.triage, 2400, 140, [id], 'settle v1#mock', 1400);
        r.settleWhy = settled ? undefined : `You said you’d look later; ${next ? `“${next.step}”` : 'the reply'} is still yours.`;
        settleChecked(r, at, data);
        this.event('settle.checked', data, { itemId: id });
        if (settled && closesOnReply(this.s.settings, r.item.source)) {
          const done = { by: 'reply' as const, source: r.item.source, messageId, check: data.batchId };
          markDone(r, at, done);
          this.event('item.done', done, { itemId: id });
        }
      }
      this.emit({ topic: 'inbox' }, { topic: 'item', id }, { topic: 'usage' });
    })();
  }

  wakeFromSleep() {
    this.advanceClock(180);
  }

  simulatePoll(outcome: PollOutcome) {
    if (outcome === 'nothing') {
      this.s.timeline = [];
      void this.runPoll('manual');
      return;
    }
    if (outcome === 'vip_dm') return void this.runPoll('manual', { threads: [VIP_DM] });
    if (outcome === 'batch12') return void this.runPoll('manual', { threads: BATCH_TWELVE });
    if (outcome === 'reply_done') return void this.runPoll('manual', { replies: [REPLIES.done] });
    if (outcome === 'reply_snoozed') return void this.runPoll('manual', { replies: [REPLIES.snoozed] });
    if (outcome === 'reply_drafted') return void this.runPoll('manual', { replies: [REPLIES.drafted] });
    if (outcome === 'reply_corrected') {
      let target = Object.values(this.s.items)
        .filter((r) => r.correction)
        .sort((a, b) => (b.correction!.correctedAt > a.correction!.correctedAt ? 1 : -1))[0];
      if (!target) {
        // Nothing corrected yet: correct the Head of Sales DM to "none" first, as Frank would.
        target = Object.values(this.s.items).find((r) => r.key === 't3')!;
        correct(target, { itemId: target.item.id, itemRevision: target.item.revision, attention: 'none', confluence: false, vault: false, correctedAt: this.iso() });
        this.event('triage.corrected', { correction: target.correction! }, { itemId: target.item.id });
      }
      const by = target.item.participants.find((p) => p.id !== FRANK)?.id ?? 'U09SALES';
      return void this.runPoll('manual', {
        replies: [{ targetKey: target.key, by, text: 'Following up: Thursday 14:00 works for the team. Can you confirm?', decision: { attention: 'today' } }],
      });
    }
  }

  setNextDraftOutcome(o: DraftOutcome) {
    this.s.nextDraftOutcome = o;
    this.emit({ topic: 'clock' });
  }

  setFlag(flag: StateFlag) {
    const f = this.s.flags;
    switch (flag) {
      case 'triage_budget':
        f.forceTriageBudget = !f.forceTriageBudget;
        break;
      case 'drafts_budget':
        f.forceDraftBudget = !f.forceDraftBudget;
        break;
      case 'slack_429':
        this.s.source = { ...this.s.source, status: 'backoff', retryAt: addMins(this.iso(), 3), rateLimitedToday: this.s.source.rateLimitedToday + 1 };
        this.event('source.failed', { source: 'slack', error: 'ratelimited', retryAfterSeconds: 180 });
        break;
      case 'slack_auth':
        this.s.source = { ...this.s.source, status: 'auth_failed' };
        this.event('source.failed', { source: 'slack', error: 'invalid_auth' });
        break;
      case 'slack_healthy':
        this.s.source = { ...this.s.source, status: 'healthy', retryAt: undefined };
        break;
      case 'server_down':
        f.connection = 'down';
        break;
      case 'reconnecting':
        f.connection = 'reconnecting';
        this.scheduleReconnect();
        break;
      case 'server_up':
        f.connection = 'up';
        break;
      case 'api_key':
      case 'slack_token':
      case 'claude_login':
        f.startupFailure = f.startupFailure === flag ? undefined : flag;
        break;
      case 'startup_ok':
        f.startupFailure = undefined;
        break;
      case 'filevault_off':
        f.fileVaultOff = !f.fileVaultOff;
        break;
      case 'health_normal':
        f.health = undefined;
        break;
      case 'health_catching_up':
      case 'health_stopping':
      case 'health_safe':
      case 'health_ms365':
        f.health = flag === 'health_catching_up' ? 'catching_up' : flag === 'health_stopping' ? 'stopping' : flag === 'health_safe' ? 'safe' : 'ms365';
        break;
      case 'health_stale':
        // The server stopped polling 34 minutes ago without a word.
        f.health = 'stale';
        this.s.source = { ...this.s.source, lastPollAt: addMins(this.iso(), -34) };
        break;
      case 'rebuilt_notice':
        f.rebuiltNotice = f.rebuiltNotice ? undefined : `Inbox state rebuilt from the event log at startup: snapshot.json was unreadable. ${this.s.events.length.toLocaleString('en-GB')} events replayed.`;
        break;
    }
    this.emitAll();
  }

  private scheduleReconnect() {
    setTimeout(() => {
      if (this.s.flags.connection === 'reconnecting') {
        this.s.flags.connection = 'up';
        this.emitAll();
      }
    }, 4000);
  }

  dismissRebuiltNotice() {
    this.s.flags.rebuiltNotice = undefined;
    this.emit({ topic: 'inbox' });
  }

  getEvents(): WorkEvent[] {
    return [...this.s.events].reverse().slice(0, 200);
  }

  getControlsState() {
    return {
      clock: this.iso(),
      nextDraftOutcome: this.s.nextDraftOutcome,
      flags: { ...this.s.flags },
      slack: this.s.source.status,
      timelinePending: this.s.timeline.length,
    };
  }

  itemIdForKey(key: string): string | undefined {
    return Object.values(this.s.items).find((r) => r.key === key)?.item.id;
  }

  dispose() {
    clearInterval(this.tickTimer);
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.flushOnHide);
  }
}

/** "<declared name>#<8 hex>", like the server's promptVersion; FNV-1a stands in for sha1. */
function promptVersion(text: string): string {
  const name = /^<!--\s*prompt:\s*(.+?)\s*-->/.exec(text)?.[1] ?? 'custom';
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${name}#${(h >>> 0).toString(16).padStart(8, '0')}`;
}
