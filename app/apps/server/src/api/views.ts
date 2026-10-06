import { access } from 'node:fs/promises';
import { join } from 'node:path';
import {
  budgetsOf,
  isWorkHours,
  londonParts,
  summaryOf,
  type ActionState,
  type BudgetState,
  type DependencyHealth,
  type HealthView,
  type InboxView,
  type Item,
  type ItemView,
  type SettingsView,
  type SourceHealth,
  type StartupCheck,
  type TriageDecision,
  type UsageView,
} from '@work-os/shared';
import type { RuntimeConfig } from '../config/env';
import type { SettingsState } from '../config/settingsState';
import type { Runtime } from '../runtime/runtime';
import type { ItemFiles } from '../store/items';
import type { RecoveryReport, Store } from '../store/store';
import { HttpError } from './errors';

// The read side of the API: each view is built from the projection, the item files and the
// settings in force. Usage, labels and drafts arrive with M2 and M3; until then those parts of
// the views are empty rather than made up.

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
}

function budgets(d: ViewDeps): BudgetState {
  return budgetsOf([], d.settings.editable.settings, d.now());
}

function actionsByItem(d: ViewDeps): Map<string, ActionState[]> {
  const by = new Map<string, ActionState[]>();
  for (const a of Object.values(d.store.projection.actions)) {
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
    .filter((i) => i.status !== 'done' || !i.doneAt || i.doneAt >= cutoff)
    .map((i) =>
      summaryOf(i, i, {
        actions: actions.get(i.id) ?? [],
        quietMinutes: s.triage.quietMinutes,
        now: nowIso,
        triageBudgetHit: b.triage.hit,
        text: d.items.text(i.id) ?? {},
      }),
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
    labelCount: 0,
    firstRun: !source.lastPollAt,
    workHours: isWorkHours(now, s.schedule.workHours),
  };
}

export async function itemView(d: ViewDeps, id: string): Promise<ItemView> {
  const it = d.store.projection.items[id];
  if (!it) throw new HttpError('not_found', 'Item not found. It may have been removed by retention.');
  const s = d.settings.editable.settings;
  const b = budgets(d);
  const stored = await d.items.read(it.source, id);
  const actions = actionsByItem(d).get(id) ?? [];
  const text = stored?.text;
  const summary = summaryOf(it, it, {
    actions,
    quietMinutes: s.triage.quietMinutes,
    now: d.now().toISOString(),
    triageBudgetHit: b.triage.hit,
    text: d.items.text(id) ?? {},
  });
  // Without its file the item shows its metadata and permalink only (FR-12.1).
  const item: Item = stored?.item ?? {
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
    drafts: {},
    progress: {},
    results: {},
    allowListedPageIds: s.confluence.pages.map((p) => p.id),
    dryRun: d.settings.settings?.dryRun ?? true,
    dataDir: d.config.dataDir,
    targets: { confluenceSite: s.confluence.siteUrl, spaceKey: s.confluence.spaceKey, vaultPath: s.vaultPath },
    budgets: b,
    meId: d.meId?.() ?? '',
  };
}

export function usageView(d: ViewDeps): UsageView {
  const now = d.now();
  const days: UsageView['days'] = [];
  for (let i = 6; i >= 0; i--) {
    const p = londonParts(new Date(now.getTime() - i * 86_400_000));
    days.push({ date: p.dateKey, label: p.weekday, triage: 0, drafts: 0 });
  }
  const b = budgets(d);
  return {
    today: {
      costEquivalent: b.cost.used,
      pctOfBaseline: b.pctOfBaseline,
      triageCalls: b.triage.used,
      threadsTriaged: 0,
      pollsSkipped: 0,
      draftsVault: 0,
      draftsConfluence: 0,
      tokens: { input: 0, output: 0, cache: 0, total: 0 },
    },
    days,
    budgets: b,
    byPurpose: [],
    source: slackHealth(d),
    criteria: [],
    evalRunning: false,
  };
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
    labelCount: 0,
    correctionCount: 0,
    vaultConventionsLoaded: conventions,
  };
}
