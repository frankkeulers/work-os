import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceEnv } from '../claude/promptFiles';
import {
  anchorOf,
  budgetsOf,
  isWorkHours,
  londonParts,
  summaryOf,
  topicItem,
  topicPiecesView,
  type ActionState,
  type BudgetState,
  type CorrectionInput,
  type Criterion,
  type EvalReport,
  type DependencyHealth,
  type EarlierView,
  type HealthView,
  type InboxView,
  type Item,
  type ItemSummary,
  type Participant,
  type ItemView,
  type SettingsView,
  type SourceHealth,
  type StartupCheck,
  type TriageDecision,
  type UsagePurpose,
  type UsageRecord,
  type UsageRow,
  type UsageView,
} from '@work-os/shared';
import type { RuntimeConfig } from '../config/env';
import type { SettingsState } from '../config/settingsState';
import type { ActionService } from '../actions/service';
import type { Evals } from '../pipeline/eval';
import { readTopic } from '../pipeline/topics';
import type { Runtime } from '../runtime/runtime';
import type { ItemFiles } from '../store/items';
import type { LabelStore } from '../store/labels';
import type { RecoveryReport, Store } from '../store/store';
import { mpdmTitle } from '../sources/slack/directory';
import { channelListed, webClientUrl } from '../sources/slack/normalise';
import { HttpError } from './errors';

// The read side of the API: each view is built from the projection, the item files and the
// settings in force, the usage log, the labelled set, the eval reports and the drafts.

export const DONE_VISIBLE_DAYS = 7; // the inbox returns done items from the last week only (NF-11)

export interface ViewDeps {
  config: RuntimeConfig;
  store: Store;
  items: ItemFiles;
  settings: SettingsState;
  recovery?: RecoveryReport;
  tokenPersisted: boolean;
  startedAt: string;
  now: () => Date;
  meId?: () => string | undefined; // the Slack user, once the first poll has asked Slack
  /** Health, wake state and the scheduler. Absent in tests of the HTTP layer alone. */
  runtime?: Runtime;
  /** The last eight days of Claude calls (CL-5), for budgets and the usage view. */
  usage?: () => readonly UsageRecord[];
  /** The labelled set (FR-6.2) and "Correct triage" itself. */
  labels?: LabelStore;
  correct?: (id: string, input: CorrectionInput) => Promise<{ labelCount: number }>;
  /** Eval reports and "Run eval" (FR-6.1, FR-6.3). */
  evals?: Evals;
  /** The Slack workspace ID, once the first poll has asked Slack: for links to the web client. */
  slackTeamId?: () => string | undefined;
  /** A group DM's title from its members, when Slack has said who they are. */
  dmTitle?: (itemId: string) => string | undefined;
  /** Everyone in a DM item's conversation, from Slack. */
  members?: (item: Item, signal?: AbortSignal) => Promise<Participant[] | undefined>;
  /** Where the guidance files' sources live, to flag a source that changed (FR-1.7). Absent in tests and fakes. */
  promptSources?: () => SourceEnv;
  /** The messages before a DM item, read live from Slack. */
  earlier?: (item: Item, signal?: AbortSignal) => Promise<EarlierView>;
  /** The Slack channels Frank is in, as "#name", for the rule editor's channel search. */
  channels?: (signal?: AbortSignal) => Promise<string[]>;
  /** Drafts, approvals and the outbox (FR-9.x, FR-14.5). */
  actions?: ActionService;
}

/**
 * What the stored summary can't know: Open in Slack's URL (the web client when settings say browser,
 * the default, and the workspace is known), and a group DM's title from its members. Titles stored
 * before those were known list each message's author, so repeats are dropped.
 */
function withOpenUrl(d: ViewDeps, s: ItemSummary): ItemSummary {
  if (s.source !== 'slack') return s;
  const team = d.slackTeamId?.();
  const web = d.settings.editable.settings.slack.openLinksIn !== 'app' && team ? webClientUrl(team, s.id, s.kind) : undefined;
  const title = s.kind === 'dm' ? (d.dmTitle?.(s.id) ?? mpdmTitle(s.title) ?? [...new Set(s.title.split(', '))].join(', ')) : s.title;
  return { ...s, title, openUrl: web ?? s.permalink };
}

/** A channel item from a channel now under "Never read these channels": fetched before it was excluded. */
export function inExcludedChannel(i: { id: string; source: string; kind: string; title: string }, exclude: string[]): boolean {
  if (i.source !== 'slack' || i.kind === 'dm' || !exclude.length) return false;
  return channelListed(exclude, { id: i.id.split(':')[1], name: i.title.replace(/^#/, '') });
}

function budgets(d: ViewDeps): BudgetState {
  return budgetsOf(d.usage?.() ?? [], d.settings.editable.settings, d.now());
}

function actionsByItem(d: ViewDeps): Map<string, ActionState[]> {
  const by = new Map<string, ActionState[]>();
  for (const a of Object.values(d.store.projection.actions).reverse()) {
    const list = by.get(a.itemId);
    if (list) list.push(a);
    else by.set(a.itemId, [a]);
  }
  for (const list of by.values()) list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return by;
}

export function slackHealth(d: ViewDeps): SourceHealth {
  const src = d.store.projection.sources.slack;
  if (d.runtime) {
    const st = d.runtime.sourceStatus('slack');
    return {
      id: 'slack',
      status: st.status,
      mode: d.settings.editable.settings.slack.fetchMode,
      lastPollAt: src?.lastPollAt,
      nextPollAt: d.runtime.scheduler.nextPollAt('slack'),
      retryAt: st.retryAt,
      rateLimitedToday: 0,
      cursor: src?.cursor,
      message: st.message,
    };
  }
  return {
    id: 'slack',
    status: src?.lastPollAt ? 'healthy' : 'never',
    mode: d.settings.editable.settings.slack.fetchMode,
    lastPollAt: src?.lastPollAt,
    rateLimitedToday: 0,
    cursor: src?.cursor,
    message: src?.lastPollAt ? undefined : 'Not polled yet.',
  };
}

export function settingsCheck(s: SettingsState): StartupCheck {
  const first = s.issues[0];
  const where = first ? `${first.path}: ${first.message}` : '';
  if (s.status === 'ok') return { id: 'settings', label: 'Settings', status: 'ok', note: 'ok' };
  if (s.status === 'fallback') return { id: 'settings', label: 'Settings', status: 'warn', note: `using the last good copy. Fix ${where}` };
  return { id: 'settings', label: 'Settings', status: 'fail', note: `sources paused until fixed. ${where}` };
}

function keychainDep(d: ViewDeps): DependencyHealth[] {
  if (d.tokenPersisted) return [];
  return [
    {
      id: 'keychain',
      state: 'degraded',
      since: d.startedAt,
      failures: 1,
      reason: 'unreadable',
      fix: 'Unlock the login Keychain. Until a restart, open tabs work; after one, reload them.',
    },
  ];
}

/** The checks for the UI: settings live, the rest from the last run (they run every 5 min). */
function checksOf(d: ViewDeps): StartupCheck[] {
  return [settingsCheck(d.settings), ...(d.runtime?.checks.filter((c) => c.id !== 'settings') ?? [])];
}

export function healthView(d: ViewDeps, stopping: boolean): HealthView {
  const common = {
    connection: 'up' as const,
    checks: checksOf(d),
    outbox: { approved: 0, waiting: 0 },
    instance: d.config.instance,
    version: d.config.version,
    startedAt: d.startedAt,
  };
  if (d.runtime) {
    const r = d.runtime.view();
    return { ...common, ...r, checks: common.checks, phase: stopping ? 'stopping' : r.phase };
  }
  const deps = keychainDep(d);
  const checks = common.checks;
  return {
    connection: 'up',
    mode: d.settings.status === 'ok' && !deps.length ? 'normal' : 'degraded',
    phase: stopping ? 'stopping' : 'running',
    deps,
    checks,
    checkedAt: d.startedAt,
    outbox: { approved: 0, waiting: 0 },
    instance: d.config.instance,
    version: d.config.version,
    startedAt: d.startedAt,
  };
}

export function inboxView(d: ViewDeps): InboxView {
  const now = d.now();
  const nowIso = now.toISOString();
  const s = d.settings.editable.settings;
  const b = budgets(d);
  const cutoff = new Date(now.getTime() - DONE_VISIBLE_DAYS * 86_400_000).toISOString();
  const actions = actionsByItem(d);
  const items = Object.values(d.store.projection.items)
    .filter((i) => !i.topicOf) // a part shows in its topic
    .filter((i) => i.status !== 'done' || !i.doneAt || i.doneAt >= cutoff)
    .filter((i) => !inExcludedChannel(i, s.slack.excludeChannels))
    .map((i) =>
      withOpenUrl(
        d,
        summaryOf(i, i, {
          actions: actions.get(i.id) ?? [],
          quietMinutes: s.triage.quietMinutes,
          now: nowIso,
          triageBudgetHit: b.triage.hit,
          text: d.items.text(i.id) ?? {},
        }),
      ),
    )
    .sort((a, b2) => b2.lastActivityAt.localeCompare(a.lastActivityAt));
  const source = slackHealth(d);
  return {
    items,
    poll: d.runtime?.pollStatus('slack') ?? { phase: 'idle', lastPollAt: source.lastPollAt },
    source,
    sources: [source],
    budgets: b,
    dryRun: d.settings.settings?.dryRun ?? true,
    notices: { rebuilt: d.recovery?.rebuiltNotice, fileVaultOff: false },
    labelCount: d.labels?.counts.labels ?? 0,
    firstRun: !source.lastPollAt,
    workHours: isWorkHours(now, s.schedule.workHours),
  };
}

export async function itemView(d: ViewDeps, requested: string): Promise<ItemView> {
  // A part opens as its topic.
  const id = anchorOf(d.store.projection.items, requested);
  const it = d.store.projection.items[id];
  if (!it) throw new HttpError('not_found', 'Item not found. It may have been removed by retention.');
  const s = d.settings.editable.settings;
  const b = budgets(d);
  const topic = await readTopic(d.store.projection, d.items, id);
  const stored = topic?.anchor;
  const team = d.slackTeamId?.();
  const web = d.settings.editable.settings.slack.openLinksIn !== 'app' && team;
  const pieces = topic && topicPiecesView(id, [topic.anchor.item, ...topic.parts], (p, kind) => (web && p.source === 'slack' ? webClientUrl(web, p.id, kind) : undefined));
  const acts = d.actions ? await d.actions.view(id) : { actions: actionsByItem(d).get(id) ?? [], drafts: {}, progress: {}, results: {} };
  const actions = acts.actions;
  const text = stored?.text;
  const summary = withOpenUrl(
    d,
    summaryOf(it, it, {
      actions,
      quietMinutes: s.triage.quietMinutes,
      now: d.now().toISOString(),
      triageBudgetHit: b.triage.hit,
      text: d.items.text(id) ?? {},
    }),
  );
  // A topic shows every piece's messages. Without its file the item shows its metadata and permalink only (FR-12.1).
  const item: Item = (topic && topicItem(topic.anchor.item, topic.parts).item) ?? {
    id,
    source: it.source,
    kind: it.kind,
    title: it.title,
    permalink: it.permalink,
    participants: it.participants,
    messages: [],
    messageCount: it.messageCount,
    lastActivityAt: it.lastActivityAt,
    revision: it.revision,
    contentExpired: true,
    schemaVersion: 1,
  };
  // Who is in the DM, for the header. Nice to have: a Slack failure leaves it out.
  const members = it.kind === 'dm' && d.members ? await d.members(item).catch(() => undefined) : undefined;
  const decision: TriageDecision | undefined = it.decision && {
    ...it.decision,
    summary: text?.summary ?? '',
    reason: text?.reason ?? '',
    next: text?.next,
  };
  return {
    summary,
    item,
    decision,
    correction: it.correction,
    actions,
    drafts: acts.drafts,
    progress: acts.progress,
    results: acts.results,
    allowListedPageIds: s.confluence.pages.map((p) => p.id),
    dryRun: d.settings.settings?.dryRun ?? true,
    dataDir: d.config.dataDir,
    targets: { confluenceSite: s.confluence.siteUrl, spaceKey: s.confluence.spaceKey, vaultPath: s.vaultPath },
    budgets: b,
    meId: d.meId?.() ?? '',
    ...(members && { members }),
    ...(pieces && { pieces }),
  };
}

const isDraft = (p: UsagePurpose) => p === 'draft_vault' || p === 'draft_confluence';

/** Today and the last seven days from the usage log (FR-7.2), against the baseline. */
export function usageView(d: ViewDeps): UsageView {
  const now = d.now();
  const records = d.usage?.() ?? [];
  const byDay = new Map<string, UsageRecord[]>();
  for (const u of records) {
    const key = londonParts(u.at).dateKey;
    const list = byDay.get(key);
    if (list) list.push(u);
    else byDay.set(key, [u]);
  }
  const days: UsageView['days'] = [];
  for (let i = 6; i >= 0; i--) {
    const p = londonParts(new Date(now.getTime() - i * 86_400_000));
    const rows = byDay.get(p.dateKey) ?? [];
    const sum = (f: (u: UsageRecord) => boolean) => rows.filter(f).reduce((t, u) => t + u.costEquivalent, 0);
    days.push({ date: p.dateKey, label: p.weekday, triage: sum((u) => !isDraft(u.purpose)), drafts: sum((u) => isDraft(u.purpose)) });
  }
  const today = byDay.get(londonParts(now).dateKey) ?? [];
  const groups = new Map<string, UsageRow>();
  const tokens = { input: 0, output: 0, cache: 0, total: 0 };
  for (const u of today) {
    const k = `${u.purpose}|${u.model}`;
    const row = groups.get(k) ?? { purpose: u.purpose, model: u.model, calls: 0, tokens: 0, costEquivalent: 0 };
    row.calls += 1;
    row.tokens += u.inputTokens + u.outputTokens + u.cacheTokens;
    row.costEquivalent += u.costEquivalent;
    groups.set(k, row);
    tokens.input += u.inputTokens;
    tokens.output += u.outputTokens;
    tokens.cache += u.cacheTokens;
  }
  tokens.total = tokens.input + tokens.output + tokens.cache;
  const b = budgets(d);
  const last = d.evals?.last;
  return {
    today: {
      costEquivalent: b.cost.used,
      pctOfBaseline: b.pctOfBaseline,
      triageCalls: b.triage.used,
      threadsTriaged: today.filter((u) => u.purpose === 'triage').reduce((t, u) => t + u.itemIds.length, 0),
      pollsSkipped: d.runtime?.emptyTriageRunsToday() ?? 0,
      draftsVault: today.filter((u) => u.purpose === 'draft_vault').length,
      draftsConfluence: today.filter((u) => u.purpose === 'draft_confluence').length,
      tokens,
    },
    days,
    budgets: b,
    byPurpose: [...groups.values()].sort((x, y) => y.costEquivalent - x.costEquivalent),
    source: slackHealth(d),
    criteria: criteria(last, b),
    ...(last && { lastEval: last }),
    evalRunning: d.evals?.running ?? false,
  };
}

/**
 * The success criteria (§2) the server can measure so far: S1 and S2 from the last eval, S3 from
 * the usage log. S4–S7 are measured in the parallel run (M4) and say so.
 */
export function criteria(last: EvalReport | undefined, b: BudgetState): Criterion[] {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const c = last?.confusion;
  const flagged = c ? c[0][0] + c[1][0] + c[2][0] + c[0][1] + c[1][1] + c[2][1] : 0;
  const precision = c && flagged ? (c[0][0] + c[1][1]) / flagged : undefined;
  const recall = last && last.categories.now.support ? last.categories.now.recall : undefined;
  const pending = (id: string, name: string, target: string, statusLabel: string): Criterion => ({ id, name, value: '—', target, status: 'pending', statusLabel });
  const later = 'Measured in the parallel run';
  return [
    precision === undefined
      ? pending('S1', 'Precision, now + today', '≥ 80%', last ? 'No now or today predictions' : 'No eval yet')
      : { id: 'S1', name: 'Precision, now + today', value: pct(precision), target: '≥ 80%', status: precision >= 0.8 ? 'on_track' : 'at_risk', statusLabel: precision >= 0.8 ? 'On track' : 'At risk' },
    recall === undefined
      ? pending('S2', 'Recall, now', '≥ 90%', last ? 'No now labels' : 'No eval yet')
      : { id: 'S2', name: 'Recall, now', value: pct(recall), target: '≥ 90%', status: recall >= 0.9 ? 'on_track' : 'at_risk', statusLabel: recall >= 0.9 ? 'On track' : 'At risk' },
    b.pctOfBaseline === null
      ? pending('S3', 'Daily usage vs baseline', '≤ 100%', 'Baseline not measured')
      : { id: 'S3', name: 'Daily usage vs baseline', value: `${b.pctOfBaseline}%`, target: '≤ 100%', status: b.pctOfBaseline <= 100 ? 'on_track' : 'at_risk', statusLabel: b.pctOfBaseline <= 100 ? 'On track' : 'Over baseline' },
    pending('S4', 'Dashboard opened', '≥ 4 of 5 days', later),
    pending('S5', 'Writes without approval', '0', later),
    pending('S6', 'People observations in Confluence', '0', later),
    pending('S7', 'Slack digest task', 'Disabled', later),
  ];
}

export async function settingsView(d: ViewDeps): Promise<SettingsView> {
  const { settings, rules } = d.settings.editable;
  const conventions = await access(join(d.config.dataDir, 'config/vault-conventions.md')).then(
    () => true,
    () => false,
  );
  return {
    settings,
    rules,
    ruleHits: Object.fromEntries(rules.map((r) => [r.id, 0])),
    savedAt: d.settings.savedAt,
    checks: checksOf(d),
    checkedAt: d.runtime?.checkedAt ?? d.startedAt,
    labelCount: d.labels?.counts.labels ?? 0,
    correctionCount: d.labels?.counts.corrections ?? 0,
    vaultConventionsLoaded: conventions,
  };
}
