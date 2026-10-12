import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { SourceEnv } from '../claude/promptFiles';
import {
  filingSettings,
  anchorOf,
  buildAttention,
  buildFiled,
  budgetsOf,
  categoryTags,
  closedByReply,
  closesOnReply,
  replyCloseCriteria,
  isWorkHours,
  londonAt,
  londonParts,
  meetingLead,
  mondayOf,
  pollIntervalMinutes, sourceSchedule,
  summaryOf,
  topicItem,
  topicPiecesView,
  type ActionState,
  type AgendaEvent,
  type AgendaView,
  type AttentionView,
  type BudgetState,
  type FiledView,
  type GuidanceChange,
  type CategoryTag,
  type CorrectionInput,
  type Criterion,
  type EvalReport,
  type DependencyHealth,
  type EarlierView,
  type HealthView,
  type InboxView,
  type Item,
  type ItemState,
  type ItemSummary,
  type Participant,
  type PersonOption,
  type ItemView,
  type SettingsView,
  type SourceHealth,
  type SourceId,
  type SourceItemsView,
  type SourceRow,
  type WeekEvent,
  type WeekView,
  type StartupCheck,
  type DecisionText,
  type FilingEvalReport,
  type LearningLoop,
  type LearningLoopView,
  type LearningView,
  type LoggedDecision,
  type TriageDecision,
  type UsagePurpose,
  type UsageRecord,
  type UsageRow,
  type UsageView,
} from '@work-os/shared';
import type { RuntimeConfig } from '../config/env';
import type { SettingsState } from '../config/settingsState';
import type { CatalogueEntry } from '../actions/confluenceCatalogue';
import type { ActionService } from '../actions/service';
import type { Evals } from '../pipeline/eval';
import { readTopic } from '../pipeline/topics';
import { SOURCE_PRIORITY } from '../sources/types';
import type { CalendarSnapshot, SnapEvent } from '../sources/calendar/store';
import type { Ms365Link } from '../sources/ms365/link';
import type { WisprLink } from '../sources/wispr/link';
import type { Runtime } from '../runtime/runtime';
import type { ItemFiles } from '../store/items';
import type { FilingFeedback } from '../pipeline/filingFeedback';
import type { FilingLabelStore, MergedFilingLabel } from '../store/filingLabels';
import type { ProposalStore } from '../learning/proposals';
import type { ProposalRunner } from '../learning/tuner';
import type { LabelStore } from '../store/labels';
import type { SettleLabelStore } from '../store/settleLabels';
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
  meId?: (source?: SourceId) => string | undefined; // Frank in a source (Slack by default), once it has polled
  /** The calendar as the last poll saw it (R2.8). */
  calendar?: () => CalendarSnapshot | undefined;
  /** Health, wake state and the scheduler. Absent in tests of the HTTP layer alone. */
  runtime?: Runtime;
  /** The last eight days of Claude calls (CL-5), for budgets and the usage view. */
  usage?: () => readonly UsageRecord[];
  /** The labelled set (FR-6.2) and "Correct triage" itself. */
  labels?: LabelStore;
  correct?: (id: string, input: CorrectionInput) => Promise<{ labelCount: number }>;
  confirm?: (id: string) => Promise<{ labelCount: number }>;
  /** What the settle check got wrong, from Frank's Undo or a Done soon after it (cockpit CK-2.6). */
  settleLabels?: SettleLabelStore;
  /** Frank's answers to "Looks finished" (cockpit CK-2.10), for the finish eval. */
  finishLabels?: SettleLabelStore;
  /** E14 (FR-15.7): feedback on the filing policy, labels/filing.jsonl. */
  filingFeedback?: FilingFeedback;
  /** The settle check on an item's reply as it stands, for a Done no check saw (CK-2.6). */
  settleCheck?: (it: ItemState) => Promise<object | undefined>;
  /** Eval reports and "Run eval" (FR-6.1, FR-6.3). */
  evals?: Evals;
  /** The filing eval (FR-15.8), over labels/filing.jsonl. */
  filingEvals?: Evals<MergedFilingLabel, FilingEvalReport>;
  /** Proposed prompt revisions (FR-15.9, FR-15.11): the store, and each loop's run Frank starts. */
  filingLabels?: FilingLabelStore;
  proposals?: ProposalStore;
  proposing?: Partial<Record<LearningLoop, ProposalRunner>>;
  /** The Slack workspace ID, once the first poll has asked Slack: for links to the web client. */
  slackTeamId?: () => string | undefined;
  /** A group DM's title from its members, when Slack has said who they are. */
  dmTitle?: (itemId: string) => string | undefined;
  /** Everyone in a DM item's conversation, from Slack. */
  members?: (item: Item, signal?: AbortSignal) => Promise<Participant[] | undefined>;
  /** The user guide's Markdown folder (FR-1.8). Absent: the app shows the copy in its build. */
  guideDir?: string;
  /** Where the guidance files' sources live, to flag a source that changed (FR-1.7). Absent in tests and fakes. */
  promptSources?: () => SourceEnv;
  /** The messages before a DM item, read live from Slack. */
  earlier?: (item: Item, signal?: AbortSignal) => Promise<EarlierView>;
  /** The Slack channels Frank is in, as "#name", for the rule editor's channel search. */
  channels?: (signal?: AbortSignal) => Promise<string[]>;
  /** The people in the Slack workspace, for the VIP search. */
  people?: (signal?: AbortSignal) => Promise<PersonOption[]>;
  /** Drafts, approvals and the outbox (FR-9.x, FR-14.5). */
  actions?: ActionService;
  /** The pages in the Confluence scope, read live (FR-10.2). */
  catalogue?: (signal?: AbortSignal) => Promise<CatalogueEntry[]>;
  /** Wispr Flow's sign-in, for Settings › Sources (R2.7). Absent: Wispr Flow can't be connected. */
  wispr?: WisprLink;
  outlook?: Ms365Link; // Outlook's Connect (R2.5): finds and tests the Microsoft 365 connector
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

export function budgets(d: ViewDeps): BudgetState {
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

export function sourceHealth(d: ViewDeps, id: SourceId): SourceHealth {
  const src = d.store.projection.sources[id];
  const mode = id === 'slack' ? d.settings.editable.settings.slack.fetchMode : undefined;
  const intervalMinutes = pollIntervalMinutes(d.settings.editable.settings, id, d.now());
  if (d.runtime) {
    const st = d.runtime.sourceStatus(id);
    return {
      id,
      status: st.status,
      ...(mode && { mode }),
      lastPollAt: src?.lastPollAt,
      nextPollAt: d.runtime.scheduler.nextPollAt(id),
      ...(intervalMinutes !== undefined && { intervalMinutes }),
      retryAt: st.retryAt,
      rateLimitedToday: 0,
      cursor: src?.cursor,
      message: st.message,
    };
  }
  return {
    id,
    status: src?.lastPollAt ? 'healthy' : 'never',
    ...(mode && { mode }),
    lastPollAt: src?.lastPollAt,
    ...(intervalMinutes !== undefined && { intervalMinutes }),
    rateLimitedToday: 0,
    cursor: src?.cursor,
    message: src?.lastPollAt ? undefined : 'Not polled yet.',
  };
}

export const slackHealth = (d: ViewDeps): SourceHealth => sourceHealth(d, 'slack');

/** A calendar read older than this many polls is stale on the agenda. */
const STALE_POLLS = 3;

/** Today's Wispr Flow meetings joined to a calendar event, by event (R2.8). */
async function notesByEvent(d: ViewDeps, since: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const it of Object.values(d.store.projection.items)) {
    if (it.source !== 'wispr' || it.lastActivityAt < since) continue;
    const eventId = (await d.items.read(it.source, it.id).catch(() => undefined))?.item.meeting?.calendar?.eventId;
    if (eventId) out.set(eventId, it.id);
  }
  return out;
}

/** A snapshot event as the agenda and the week show it, with its notes and invite items when it has them. */
function agendaEvent(d: ViewDeps, e: SnapEvent, links: { notes?: string; invite?: string }): AgendaEvent {
  const organizer = e.organizer?.name ?? e.organizer?.address;
  return {
    id: e.id,
    title: e.subject || '(no title)',
    start: e.start,
    end: e.end,
    allDay: e.allDay,
    ...(e.showAs && { showAs: e.showAs }),
    ...(organizer && { organizer }),
    ...(e.link && { link: e.link }),
    ...(e.joinUrl && { joinUrl: e.joinUrl }),
    ...((e.isOrganizer || e.response) && { response: e.isOrganizer ? 'organizer' : e.response }),
    ...(links.invite && { inviteItemId: links.invite }),
    ...(links.notes && { notesItemId: links.notes }),
    ...(e.categories && { categories: categoryTags(e.categories, d.settings.editable.settings.calendar?.categoryColors) }),
  };
}

/** Today's and tomorrow's meetings from the calendar snapshot (R2.8): not cancelled, not declined. */
export async function agendaView(d: ViewDeps): Promise<AgendaView> {
  const settings = d.settings.editable.settings;
  const schedule = sourceSchedule(settings, 'calendar');
  const leadMinutes = meetingLead(settings);
  if (!schedule.enabled || !settings.connectors?.ms365) return { state: 'off', events: [], leadMinutes };
  const snap = d.calendar?.();
  if (!snap) return { state: 'never', events: [], leadMinutes };
  const now = d.now();
  const from = londonAt(now, '00:00');
  const to = londonAt(now, '00:00', 2);
  const inviteOf = new Map(snap.invites.flatMap((g) => g.eventIds.map((id) => [id, g.itemId] as const)));
  const notes = await notesByEvent(d, from);
  const events = snap.events
    .filter((e) => !e.cancelled && e.response !== 'declined' && e.end > from && e.start < to)
    .map((e) => {
      const invite = inviteOf.get(e.id);
      return agendaEvent(d, e, { notes: notes.get(e.id), invite: invite && d.store.projection.items[invite]?.status === 'open' ? invite : undefined });
    });
  const status = d.runtime?.sourceStatus('calendar').status;
  const stale = now.getTime() - Date.parse(snap.polledAt) > STALE_POLLS * schedule.intervalWorkMinutes * 60_000;
  return { state: status === 'auth_failed' ? 'auth_failed' : stale ? 'stale' : 'ok', polledAt: snap.polledAt, events, leadMinutes };
}

/** YYYY-MM-DD: a week's Monday as the week view's URL gives it. */
const WEEK_START = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One week of the calendar, Monday to Sunday, London time (cockpit CK-5.6). Unlike the agenda it
 * keeps cancelled and declined meetings, marked, and links an invite item whatever its state. The
 * snapshot holds this week and the next two, so other weeks come back empty with what it holds.
 */
export async function weekView(d: ViewDeps, weekStart?: string): Promise<WeekView> {
  const settings = d.settings.editable.settings;
  const schedule = sourceSchedule(settings, 'calendar');
  const now = d.now();
  if (weekStart !== undefined && (!WEEK_START.test(weekStart) || Number.isNaN(Date.parse(`${weekStart}T12:00:00Z`)))) {
    throw new HttpError('validation', 'Send start as YYYY-MM-DD.');
  }
  const monday = mondayOf(weekStart ? new Date(`${weekStart}T12:00:00Z`) : now);
  if (!schedule.enabled || !settings.connectors?.ms365) return { state: 'off', weekStart: monday, events: [] };
  const snap = d.calendar?.();
  if (!snap) return { state: 'never', weekStart: monday, events: [] };
  const day = new Date(`${monday}T12:00:00Z`);
  const from = londonAt(day, '00:00');
  const to = londonAt(day, '00:00', 7);
  const inviteOf = new Map(snap.invites.flatMap((g) => g.eventIds.map((id) => [id, g.itemId] as const)));
  const notes = await notesByEvent(d, from);
  const events = snap.events
    .filter((e) => e.end > from && e.start < to)
    .map((e): WeekEvent => {
      const invite = inviteOf.get(e.id);
      const attendees = e.attendees.map((a) => a.name ?? a.address).filter((a): a is string => !!a);
      return {
        ...agendaEvent(d, e, { notes: notes.get(e.id), invite: invite && d.store.projection.items[invite] ? invite : undefined }),
        ...(e.cancelled && { cancelled: true }),
        ...(attendees.length && { attendees }),
      };
    })
    .sort((a, b) => a.start.localeCompare(b.start));
  const status = d.runtime?.sourceStatus('calendar').status;
  const stale = now.getTime() - Date.parse(snap.polledAt) > STALE_POLLS * schedule.intervalWorkMinutes * 60_000;
  return { state: status === 'auth_failed' ? 'auth_failed' : stale ? 'stale' : 'ok', polledAt: snap.polledAt, weekStart: monday, held: { from: snap.from, to: snap.to }, events };
}

/** Every enabled source, in wake order (R2.1). Slack is always listed: the inbox is built around it. */
function enabledSources(d: ViewDeps): SourceHealth[] {
  const s = d.settings.editable.settings;
  return SOURCE_PRIORITY.filter((id) => id === 'slack' || sourceSchedule(s, id).enabled).map((id) => sourceHealth(d, id));
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
  const row = rowBuilder(d, nowIso, b);
  const items = Object.values(d.store.projection.items)
    .filter((i) => !i.topicOf) // a part shows in its topic
    .filter((i) => i.status !== 'done' || !i.doneAt || i.doneAt >= cutoff)
    .filter((i) => !inExcludedChannel(i, s.slack.excludeChannels))
    .map(row)
    .sort((a, b2) => b2.lastActivityAt.localeCompare(a.lastActivityAt));
  const source = slackHealth(d);
  return {
    items,
    poll: d.runtime?.pollStatus('slack') ?? { phase: 'idle', lastPollAt: source.lastPollAt },
    source,
    sources: enabledSources(d),
    budgets: b,
    dryRun: d.settings.settings?.dryRun ?? true,
    notices: { rebuilt: d.recovery?.rebuiltNotice, fileVaultOff: false },
    labelCount: d.labels?.counts.labels ?? 0,
    firstRun: !source.lastPollAt,
    workHours: isWorkHours(now, s.schedule.workHours),
    closedByReply: closedByReply(items, now),
  };
}

/**
 * A meeting's or invite's Outlook categories while the calendar is read (R2.8): the event's own
 * now, when the snapshot still has it, else those the item kept.
 */
/** An item's inbox row: its summary, Open in's URL and its calendar categories. */
/** A decision from the log with its free text from the item's file put back (§4.3). */
const withText = ({ todo: _todo, ...d }: LoggedDecision, text: DecisionText | undefined): TriageDecision => ({
  ...d,
  summary: text?.summary ?? '',
  reason: text?.reason ?? '',
  next: text?.next,
  ...(text?.todo && { todo: text.todo }),
});

function rowBuilder(d: ViewDeps, nowIso: string, b: BudgetState) {
  const s = d.settings.editable.settings;
  const actions = actionsByItem(d);
  return (i: ItemState): ItemSummary => {
    const row = withOpenUrl(
      d,
      summaryOf(i, i, {
        actions: actions.get(i.id) ?? [],
        quietMinutes: s.triage.quietMinutes,
        now: nowIso,
        triageBudgetHit: b.triage.hit,
        text: d.items.text(i.id) ?? {},
        filing: filingSettings(s),
      }),
    );
    const calendarCategories = calendarCategoriesOf(d, d.items.calendarOf(i.id));
    return calendarCategories ? { ...row, calendarCategories } : row;
  };
}

/**
 * The bell (FR-11.3, FR-11.4): what needs Frank, derived from state as it stands. Rows are built only
 * for the items it can be about: those with a draft in progress, ready or failed, and open topics
 * that may need a nudge.
 */
export async function attentionView(d: ViewDeps, guidance: GuidanceChange[] = []): Promise<AttentionView> {
  const now = d.now();
  const b = budgets(d);
  const p = d.store.projection;
  const row = rowBuilder(d, now.toISOString(), b);
  const actions = Object.values(p.actions);
  const live = new Set(actions.filter((a) => a.status === 'drafting' || a.status === 'ready' || a.status === 'failed').map((a) => a.itemId));
  const nudge = (i: ItemState) => !i.topicOf && i.status === 'open' && (i.backFromSnooze || !!i.looksFinished || !!i.replyCheck);
  const items = Object.values(p.items)
    .filter((i) => live.has(i.id) || nudge(i))
    .map(row);
  const shown = new Set(items.map((i) => i.id));
  const failed = actions.filter((a) => a.status === 'failed' && shown.has(a.itemId));
  const results: Record<string, string> = {};
  for (const a of failed) {
    const r = await d.actions?.result(a.id);
    if (r) results[a.id] = r;
  }
  const last = d.evals?.last;
  const lastFiling = d.filingEvals?.last;
  return buildAttention({
    now: now.toISOString(),
    items,
    actions,
    progress: d.actions?.running() ?? {},
    results,
    health: healthView(d, false),
    budgets: b,
    ...(last && { lastEval: last }),
    ...(lastFiling && { lastFilingEval: lastFiling }),
    guidance,
    proposals: ((await d.proposals?.list()) ?? []).filter((x) => x.status === 'open'),
    dismissed: p.dismissed ?? {},
  });
}

/**
 * A source's history (cockpit CK-5.1): every item stored for it, newest first, whatever triage made
 * of it. Unlike the inbox it keeps done items of any age and excluded channels' items (flagged).
 * A topic's parts stay in it: the topic's panel shows every piece.
 */
/** What was filed today, for the Done list (UX-12). Reads one draft file per filing, for its outcome. */
export async function filedView(d: ViewDeps): Promise<FiledView> {
  const p = d.store.projection;
  const now = d.now().toISOString();
  const day = londonParts(now).dateKey;
  const actions = Object.values(p.actions).filter((a) => a.status === 'done' && londonParts(a.updatedAt).dateKey === day);
  const items = new Map<string, { title: string; summary: string; done: boolean }>();
  const results: Record<string, string> = {};
  for (const a of actions) {
    const it = p.items[a.itemId];
    if (it) items.set(it.id, { title: it.kind === 'dm' ? (d.dmTitle?.(it.id) ?? mpdmTitle(it.title) ?? it.title) : it.title, summary: d.items.text(it.id)?.summary ?? '', done: it.status === 'done' });
    const r = await d.actions?.result(a.id);
    if (r) results[a.id] = r;
  }
  const s = d.settings.editable.settings;
  return buildFiled({ now, actions, items, results, dryRun: d.settings.settings?.dryRun ?? true, targets: { confluenceSite: s.confluence.siteUrl, spaceKey: s.confluence.spaceKey, vaultPath: s.vaultPath } });
}

export function sourceView(d: ViewDeps, source: SourceId): SourceItemsView {
  const now = d.now();
  const s = d.settings.editable.settings;
  const row = rowBuilder(d, now.toISOString(), budgets(d));
  const me = d.meId?.(source);
  const expiredBefore = new Date(now.getTime() - s.retentionDays * 86_400_000).toISOString();
  const items = Object.values(d.store.projection.items)
    .filter((i) => i.source === source && !i.topicOf)
    .map((i): SourceRow => ({
      ...row(i),
      people: [...new Set(i.participants.filter((p) => p.id !== me).map((p) => p.name || p.id))],
      messageCount: i.messageCount,
      ...(inExcludedChannel(i, s.slack.excludeChannels) && { excluded: true }),
      ...(i.lastActivityAt < expiredBefore && { expired: true }),
    }))
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  return { source, items };
}

function calendarCategoriesOf(d: ViewDeps, cal: { eventId: string; categories?: string[] } | undefined): CategoryTag[] | undefined {
  const s = d.settings.editable.settings;
  if (!cal || !sourceSchedule(s, 'calendar').enabled) return undefined;
  const live = d.calendar?.()?.events.find((e) => e.id === cal.eventId);
  const names = live ? live.categories : cal.categories;
  return names?.length ? categoryTags(names, s.calendar?.categoryColors) : undefined;
}

/** Every category the calendar has shown or Frank has given a colour, A to Z, for Settings › Outlook. */
export function knownCategories(d: ViewDeps): string[] {
  const seen = new Map<string, string>();
  const names = [...(d.calendar?.()?.events.flatMap((e) => e.categories ?? []) ?? []), ...Object.keys(d.settings.editable.settings.calendar?.categoryColors ?? {})];
  for (const n of names) if (!seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
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
  const acts = d.actions ? await d.actions.view(id) : { actions: actionsByItem(d).get(id) ?? [], drafts: {}, progress: {}, results: {}, additionalInfo: {} };
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
      filing: filingSettings(s),
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
  const calendarCategories = calendarCategoriesOf(d, item.meeting?.calendar);
  // Who is in the DM, for the header. Nice to have: a Slack failure leaves it out.
  const members = it.kind === 'dm' && d.members ? await d.members(item).catch(() => undefined) : undefined;
  const decision = it.decision && withText(it.decision, text);
  return {
    summary,
    item,
    decision,
    correction: it.correction,
    actions,
    drafts: acts.drafts,
    progress: acts.progress,
    results: acts.results,
    additionalInfo: acts.additionalInfo,
    excludedPageIds: s.confluence.exclude.map((p) => p.id),
    closesOnReply: closesOnReply(s, it.source),
    dryRun: d.settings.settings?.dryRun ?? true,
    dataDir: d.config.dataDir,
    targets: { confluenceSite: s.confluence.siteUrl, spaceKey: s.confluence.spaceKey, vaultPath: s.vaultPath, tasksNote: s.tasksNote },
    budgets: b,
    meId: d.meId?.(it.source) ?? '',
    ...(members && { members }),
    ...(pieces && { pieces }),
    ...(calendarCategories && { calendarCategories }),
  };
}

const isDraft = (p: UsagePurpose) => p === 'draft_vault' || p === 'draft_confluence' || p === 'draft_todo';

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
    sources: enabledSources(d),
    criteria: [...criteria(last, b), ...replyCloseCriteria(d.store.projection.closes, d.now())],
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
  // now and today predictions, whatever the label (the columns of the confusion matrix)
  const flagged = c ? c.reduce((s, row) => s + row[0] + row[1], 0) : 0;
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
    ...(await learningView(d)),
  };
}

/** Each loop's label lines: when they came, for which item, and whether Frank said so himself. */
export async function loopLabels(d: ViewDeps, loop: LearningLoop): Promise<{ at: string; itemId: string; explicit: boolean }[] | undefined> {
  switch (loop) {
    case 'filing':
      return (await d.filingLabels?.all())?.map((l) => ({ at: l.at, itemId: l.itemId, explicit: l.origin === 'explicit' }));
    case 'triage':
      return (await d.labels?.all())?.map((l) => ({ at: l.at, itemId: l.itemId, explicit: true }));
    case 'settle':
      return (await d.settleLabels?.all())?.map((l) => ({ at: l.at, itemId: l.itemId, explicit: false })); // read from Undo and Done
    case 'finish':
      return (await d.finishLabels?.all())?.map((l) => ({ at: l.at, itemId: l.itemId, explicit: true })); // his answer to Looks finished
  }
}

/** Settings › Learning (FR-15.10, FR-15.11): each loop's labels and latest proposal, and the filing eval. */
async function learningView(d: ViewDeps): Promise<{ learning?: LearningView }> {
  if (!d.filingLabels) return {};
  const all = (await d.proposals?.list()) ?? [];
  const loop = async (id: LearningLoop): Promise<LearningLoopView | undefined> => {
    const lines = await loopLabels(d, id);
    if (!lines) return undefined;
    const proposal = all.find((p) => p.loop === id);
    return {
      labels: { items: new Set(lines.map((l) => l.itemId)).size, explicit: lines.filter((l) => l.explicit).length, implicit: lines.filter((l) => !l.explicit).length },
      newLabels: proposal ? lines.filter((l) => l.at > proposal.at).length : lines.length,
      proposing: d.proposing?.[id]?.running ?? false,
      ...(proposal && { proposal }),
    };
  };
  const filing = (await loop('filing'))!;
  const [triage, settle, finish] = await Promise.all([loop('triage'), loop('settle'), loop('finish')]);
  const last = d.filingEvals?.last;
  const lastTriage = d.evals?.last;
  return {
    learning: {
      filing: { ...filing, ...(last && { lastEval: last }), evalRunning: d.filingEvals?.running ?? false },
      ...(triage && { triage: { ...triage, ...(lastTriage && { lastEval: { id: lastTriage.id, at: lastTriage.at, labelCount: lastTriage.labelCount } }) } }),
      ...(settle && { settle }),
      ...(finish && { finish }),
    },
  };
}
