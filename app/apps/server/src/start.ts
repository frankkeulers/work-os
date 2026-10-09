import { ConfigError, EXIT, exitCode, resolveConfig, type RuntimeConfig } from './config/env';
import { initDataDir, paths } from './config/dataDir';
import { DEFAULT_RULES, defaultSettings } from './config/defaults';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { loadApiToken } from './api/auth';
import { settingsCheck } from './api/views';
import { macKeychain, type SecretStore } from './config/keychain';
import { loadSettings } from './config/settings';
import { SettingsState } from './config/settingsState';
import { createLogger, type Logger } from './log';
import { HealthAlerts } from './notify/alerts';
import { silentNotifier, type Notifier } from './notify/macos';
import { Notifications } from './notify/notifications';
import { armCrash } from './runtime/crash';
import { RetentionJob } from './store/retention';
import { probeNetwork, type FetchFn } from './net/probe';
import { exec as systemExec, runChecks, type Exec } from './runtime/checks';
import { clearCrashes, recordCleanStop, recordStart } from './runtime/crashLoop';
import { Lifecycle } from './runtime/lifecycle';
import { acquireLock, systemProbe, type ProcessProbe } from './runtime/lock';
import { readWakeTime, systemClock, type Clock } from './runtime/power';
import { apiKeySet, clearRefusal, refuseApiKey } from './runtime/refuse';
import { Runtime } from './runtime/runtime';
import { followSystemZone } from './runtime/tz';
import { CursorFile } from './pipeline/cursors';
import { newDayWatcher, returnSnoozed } from './pipeline/due';
import { relinkMeetings, withCalendar } from './pipeline/meetings';
import { pollSource } from './pipeline/poll';
import { buildSources, type AdapterFactory } from './sources/registry';
import { Ms365Relay } from './sources/ms365/client';
import { calendarFactory } from './sources/calendar/adapter';
import { CalendarStore } from './sources/calendar/store';
import { ms365Link, type Ms365Link } from './sources/ms365/link';
import { meOf } from './sources/outlook/normalise';
import { FIRST_POLL_MS, outlookFactory, RecentEmails } from './sources/outlook/adapter';
import { wisprFactory } from './sources/wispr/adapter';
import { wisprLink, type WisprLink } from './sources/wispr/link';
import { httpConnector, WisprMcp } from './sources/wispr/mcp';
import { WisprAuth } from './sources/wispr/oauth';
import { slackFactory } from './sources/slack/adapter';
import { SlackApi } from './sources/slack/api';
import { SlackDirectory } from './sources/slack/directory';
import { EarlierMessages } from './sources/slack/earlier';
import { createServer, type WorkOsServer } from './server';
import { budgetsOf, sourceSchedule, type Item, type SourceId } from '@work-os/shared';
import { ClaudeAdapter, type QueryFn } from './claude/adapter';
import { noClaude } from './claude/fakeClaude';
import { loadPromptFile, PROMPT_FILES } from './claude/promptFiles';
import { ConfluenceApi } from './actions/confluenceApi';
import { buildCatalogue } from './actions/confluenceCatalogue';
import { noConfluence } from './actions/fakeConfluence';
import { UsageLog } from './claude/usage';
import { meFrom } from './pipeline/rules';
import { routeTopics } from './pipeline/topics';
import { meetingsToday, runTriage, type TriageDeps } from './pipeline/triage';
import { runSettle, type SettleDeps } from './pipeline/settle';
import { correctTriage } from './pipeline/corrections';
import { Evals, runEval } from './pipeline/eval';
import { LabelStore } from './store/labels';
import { DraftStore } from './store/drafts';
import { ActionService } from './actions/service';
import type { Notice } from '@work-os/shared';
import { ClaudeError } from './claude/errors';
import { ItemFiles } from './store/items';
import { Store, type RecoveryReport } from './store/store';

// The startup order (PLAN.md robustness §6): refuse an API key, take the lock, load settings
// (falling back if invalid), recover the store, then bind HTTP. Checks that need the network run after the server
// is ready, so a slow or offline start still shows the UI.

export interface RunDeps {
  env: NodeJS.ProcessEnv;
  notifier?: Notifier;
  probe?: ProcessProbe;
  secrets?: SecretStore;
  now?: () => Date;
  echoLogs?: boolean;
  /** Fakes for tests: the clocks, the network probe's fetch, and the commands the checks run. */
  clock?: Clock;
  fetch?: FetchFn;
  exec?: Exec;
  wakeTime?: () => string | undefined;
  followZone?: () => string | undefined;
  /** The source adapters by id; Slack by default. Tests pass fakes, or none. */
  sources?: Partial<Record<SourceId, AdapterFactory>>;
  /** Run against a made-up Slack (`--fakes`, e2e:server). Refused outside a temp data dir. */
  fakes?: boolean;
  /** Confluence REST calls; real fetch by default. Tests and `--fakes` pass a fake Confluence. */
  confluenceFetch?: FetchFn;
  /** The Agent SDK's query(), or a fake. Tests must pass one: they never call Claude. */
  claude?: QueryFn;
  /** Wispr Flow's sign-in for Settings; the real one by default, `--fakes` passes its own. */
  wispr?: WisprLink;
  /** Outlook's Connect for Settings; the real one by default, `--fakes` passes its own. */
  outlook?: Ms365Link;
  /** The calendar snapshot (R2.8); the fakes keep theirs in memory. */
  calendar?: CalendarStore;
}

export type RunResult =
  | { running: false; code: number }
  | {
      running: true;
      url: string;
      config: RuntimeConfig;
      server: WorkOsServer;
      store: Store;
      items: ItemFiles;
      settings: SettingsState;
      runtime: Runtime;
      labels: LabelStore;
      evals: Evals;
      actions: ActionService;
      notifications: Notifications;
      alerts: HealthAlerts;
      retention: RetentionJob;
      recovery: RecoveryReport;
      token: string;
      logger: Logger;
      lifecycle: Lifecycle;
      flush(): void;
    };

/** Vite's dev server, which proxies /api to the development instance. */
const DEV_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173';
/** app/docs/guide, when the server runs from the repo (FR-1.8). From a bundled release this points nowhere, and the app shows its built-in copy. */
const REPO_GUIDE_DIR = fileURLToPath(new URL('../../../docs/guide', import.meta.url));

export async function run(deps: RunDeps): Promise<RunResult> {
  const notifier = deps.notifier ?? silentNotifier;
  const clock = deps.clock ?? (deps.now ? { now: deps.now, mono: () => performance.now() } : systemClock);
  const now = () => clock.now();
  const underLaunchd = deps.env.WORKOS_LAUNCHD === '1';

  let config: RuntimeConfig;
  try {
    config = resolveConfig(deps.env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    process.stderr.write(`Work OS did not start: ${e.message}\n`);
    await notifier.notify({ title: 'Work OS did not start', message: e.message });
    return { running: false, code: exitCode(EXIT.config, underLaunchd) };
  }

  if (apiKeySet(deps.env)) return { running: false, code: await refuseApiKey(config, notifier, now()) };

  let extraRoutes: ((app: FastifyInstance) => void) | undefined;
  if (deps.fakes) {
    const { fakeAnchor, fakesRefusal, fakeWorld } = await import('./fakes');
    const refusal = fakesRefusal(config);
    if (refusal) {
      process.stderr.write(`Work OS did not start: ${refusal}\n`);
      return { running: false, code: exitCode(EXIT.config, underLaunchd) };
    }
    // The made-up threads are anchored to the first start, so a restart sees the same ones.
    const world = fakeWorld(await fakeAnchor(config.dataDir, now()));
    armCrash(deps.env.WORKOS_CRASH_AT);
    deps = { ...deps, secrets: world.secrets, fetch: world.fetch, confluenceFetch: world.confluenceFetch, exec: world.exec, sources: world.sources, claude: world.claude, wispr: world.wisprLink, outlook: world.outlookLink, calendar: world.calendar };
    extraRoutes = world.routes;
  }

  const defaults = defaultSettings(config.dataDir);
  if (deps.fakes) {
    const fakes = await import('./fakes');
    defaults.vaultPath = join(config.dataDir, 'fake-vault');
    await fakes.seedFakeVault(defaults.vaultPath);
    const page = fakes.FAKE_CONFLUENCE_PAGE;
    defaults.confluence = { siteUrl: page.siteUrl, spaceKey: page.spaceKey, roots: [page.root], labels: [], exclude: [], pages: [] };
  }
  const init = await initDataDir(config.dataDir, { settings: defaults, rules: DEFAULT_RULES, files: PROMPT_FILES.map((f) => ({ file: f.file, text: f.defaultText, previous: f.previousDefaults })) });
  const { logger, flush } = createLogger({ dir: paths(config.dataDir).logs, echo: deps.echoLogs, now, base: { instance: config.instance } });
  if (init.created.length) logger.info({ created: init.created }, 'Created default config');
  if (init.upgraded.length) logger.info({ upgraded: init.upgraded }, 'Replaced untouched prompt files with the new defaults');

  const lockRes = await acquireLock(paths(config.dataDir).lock, { instance: config.instance, port: config.port, version: config.version }, deps.probe ?? systemProbe, now);
  if (!lockRes.ok) {
    const msg = `Work OS is already running at http://127.0.0.1:${lockRes.holder.port} (pid ${lockRes.holder.pid}).`;
    logger.warn({ holder: lockRes.holder }, msg);
    process.stderr.write(`${msg}\n`);
    flush();
    return { running: false, code: exitCode(EXIT.lockHeld, config.underLaunchd) };
  }
  if (lockRes.tookOver) logger.warn({ stale: lockRes.tookOver }, 'Took over a stale lock');
  const lifecycle = new Lifecycle((name, err) => logger.error({ err, hook: name }, 'Stop hook failed'));
  lifecycle.onStop('lock', () => lockRes.lock.release());
  lifecycle.onStop('log', () => flush());
  await clearRefusal(config.dataDir);

  // A run that ends without a clean stop counts as a crash; too many and the scheduler stays off.
  const runs = await recordStart(config.dataDir, now());
  let crashed = false;
  lifecycle.onStop('crash-loop', () => (crashed ? undefined : recordCleanStop(config.dataDir)));
  if (runs.safeMode) {
    logger.error({ crashes: runs.crashes }, 'Safe mode: crashed too often, polling is off');
    await notifier.notify({ title: 'Work OS is in safe mode', message: `It crashed ${runs.crashes} times in 10 minutes. Polling is off; open Work OS and choose Check again.` });
  }
  const zone = (deps.followZone ?? followSystemZone)();
  if (zone) logger.info({ zone }, 'Using the system time zone');

  const load = await loadSettings(config.dataDir);
  if (load.status !== 'ok') {
    logger.warn({ issues: load.issues }, load.status === 'fallback' ? 'Settings invalid: using the last good copy' : 'Settings invalid and no good copy: sources paused');
  }
  const settings = await SettingsState.create(config.dataDir, load, config.forceDryRun);
  const secrets = deps.secrets ?? macKeychain();
  const { token, persisted } = await loadApiToken(secrets, config.instance, logger);

  // Recover the store before binding, so the first request already sees the replayed inbox.
  const { store, recovery } = await Store.open({ dataDir: config.dataDir, logger, now });
  lifecycle.onStop('store', () => store.close());
  const items = new ItemFiles(join(config.dataDir, 'items'));
  const cursors = await CursorFile.open(paths(config.dataDir).cursors);
  const usage = await UsageLog.open(paths(config.dataDir).logs, now);
  lifecycle.onStop('usage', () => usage.close());
  // One Slack client and directory for the life of the process: the adapter is rebuilt when
  // settings change, but the token, Frank's identity and names stay cached.
  const slackDirectory = new SlackDirectory(new SlackApi(secrets, deps.fetch ?? fetch));
  const earlier = new EarlierMessages(slackDirectory);
  // Items stored with an empty message (an app's post read before its blocks were) are read again
  // on the next poll. Found once at start, in the background; the merge then re-triages them.
  const refetch = new Set<string>();
  const takeRefetch = (source: string) => {
    if (source !== 'slack' || !refetch.size) return [];
    const ids = [...refetch];
    refetch.clear();
    return ids;
  };
  void (async () => {
    for (const it of Object.values(store.projection.items)) {
      if (it.source !== 'slack' || it.status === 'done') continue;
      const stored = await items.read(it.source, it.id).catch(() => undefined);
      if (stored?.item.messages.some((m) => m.text === '')) refetch.add(it.id);
    }
    if (refetch.size) logger.info({ items: refetch.size }, 'Reading items with empty messages again on the next poll');
  })();
  // A group DM's members, asked for once in the background when the inbox shows it unnamed (after a
  // restart, before a poll); the inbox is told to refresh once they are known.
  const warming = new Set<string>();
  const warmMembers = (channel: string) => {
    if (warming.has(channel) || !channel.startsWith('C') && !channel.startsWith('G')) return;
    warming.add(channel);
    void slackDirectory
      .dmMembersById(channel)
      .then((ids) => ids && publish({ topic: 'inbox' }))
      .catch((err: unknown) => logger.debug?.({ channel, err: String(err) }, 'Could not read group DM members'))
      .finally(() => setTimeout(() => warming.delete(channel), 10 * 60_000).unref());
  };
  // Wispr Flow (R2.7): one sign-in store and MCP client for the process, like Slack's directory.
  const wisprAuth = new WisprAuth(secrets, `http://127.0.0.1:${config.port}/oauth/wispr/callback`);
  const wisprMcp = new WisprMcp(httpConnector(wisprAuth, config.version, deps.fetch ?? fetch));
  // Claude (M2): one adapter for the process; triage reads the prompt file on every run.
  const claude = new ClaudeAdapter({
    usage,
    settings: () => settings.editable.settings,
    secrets,
    now,
    logger,
    cwd: join(config.dataDir, 'sandbox'),
    client: `work-os/${config.version}`,
    // Belt and braces: a test that forgot its fake fails instead of calling Claude for real.
    query: deps.claude ?? (process.env.VITEST ? noClaude : undefined),
  });
  // Outlook (R2.5): mail through the claude.ai Microsoft 365 connector, relayed by Claude. The
  // emails read lately are kept for the process, and seeded at start from the stored threads, so
  // the poll's overlap doesn't read them again after a restart.
  const ms365 = (id?: string) => new Ms365Relay({ claude, connectorId: () => id ?? settings.editable.settings.connectors?.ms365?.id, logger });
  const outlookRecent = new RecentEmails();
  void (async () => {
    const since = new Date(now().getTime() - 2 * FIRST_POLL_MS).toISOString();
    for (const it of Object.values(store.projection.items)) {
      if (it.source !== 'outlook' || it.lastActivityAt < since) continue;
      const stored = await items.read(it.source, it.id).catch(() => undefined);
      for (const m of stored?.item.messages ?? []) outlookRecent.add(m.id);
    }
  })();
  // Outlook Calendar (R2.8): the same connector; the window as last seen lives in state/calendar.json.
  const calendar = deps.calendar ?? (await CalendarStore.open(paths(config.dataDir).calendar));
  // Wispr Flow meetings joined to their calendar events (R2.8): as Wispr reads them, and after each
  // calendar poll for those the calendar didn't have yet. Nothing changes while the calendar is off.
  const calendarMe = () => (sourceSchedule(settings.editable.settings, 'calendar').enabled ? meOf(settings.editable.settings.connectors?.ms365?.account) : undefined);
  const joinCalendar = (fetched: Item[]) => {
    const me = calendarMe();
    const snap = calendar.snapshot;
    return me && snap ? fetched.map((i) => withCalendar(i, snap, me)) : fetched;
  };
  calendar.onPublish(async (snap) => {
    const me = calendarMe();
    if (me) await relinkMeetings({ store, items, logger }, snap, me).catch((err: unknown) => logger.warn({ err }, 'Joining Wispr Flow meetings to the calendar failed'));
  });
  const factories = deps.sources ?? {
    slack: slackFactory(slackDirectory, logger),
    outlook: outlookFactory(ms365(), logger, outlookRecent, () => (calendarMe() ? calendar.snapshot : undefined)),
    calendar: calendarFactory(ms365(), calendar, logger),
    wispr: wisprFactory(wisprMcp, logger),
  };
  const triageDeps: TriageDeps = {
    store,
    items,
    claude,
    now,
    logger,
    config: () => ({ settings: settings.editable.settings, rules: settings.rules }),
    me: (source: SourceId = 'slack') => meFrom(runtime.whoAmI(source)),
    prompt: () => loadPromptFile(config.dataDir, 'triage'),
    topicsPrompt: () => loadPromptFile(config.dataDir, 'topics'),
    // Today's meetings, for deadlines such as "before the exec sync" (cockpit CK-3.9).
    meetings: (at) => (calendarMe() ? meetingsToday(calendar.snapshot?.events ?? [], at) : []),
    earlier: (item, signal) => earlier.forItem(item, signal),
    budgetHit: () => {
      const b = budgetsOf(usage.records(), settings.editable.settings, now());
      return b.triage.hit || b.cost.hit;
    },
  };
  const settleDeps: SettleDeps = { ...triageDeps, prompt: () => loadPromptFile(config.dataDir, 'settle') };
  const labels = await LabelStore.open(paths(config.dataDir).labels);
  lifecycle.onStop('labels', () => labels.close());
  const correct = (id: string, input: Parameters<typeof correctTriage>[2]) =>
    correctTriage({ store, items, labels, now, me: triageDeps.me, keepLastMessages: () => settings.editable.settings.triage.keepLastMessages }, id, input);
  const evals = await Evals.open({
    logsDir: paths(config.dataDir).logs,
    labels: () => labels.all(),
    logger,
    run: async (records, signal) => {
      try {
        return await runEval({ claude, settings: settings.editable.settings, prompt: await triageDeps.prompt(), now, signal, logger }, records);
      } catch (err) {
        if (err instanceof ClaudeError) await runtime.reportFailure('claude', err.failure);
        throw err;
      }
    },
  });
  lifecycle.onStop('evals', () => evals.stop());
  // Actions (M3): drafted when Claude may be called, written by the outbox after approval.
  let publish: (n: Notice) => void = () => undefined; // the SSE hub, once the server exists
  const drafts = new DraftStore(join(config.dataDir, 'drafts'));
  // Belt and braces, as for Claude: a test without a fake Confluence fails instead of calling one.
  const confluenceApi = new ConfluenceApi(secrets, () => settings.editable.settings.confluence.siteUrl, deps.confluenceFetch ?? (process.env.VITEST ? noConfluence : fetch));
  const actions = new ActionService({
    store,
    items,
    drafts,
    claude,
    dataDir: config.dataDir,
    now,
    logger,
    settings: () => settings.editable.settings,
    dryRun: () => settings.settings?.dryRun ?? true,
    me: (source) => triageDeps.me(source),
    draftsBudgetHit: () => {
      const b = budgetsOf(usage.records(), settings.editable.settings, now());
      return b.drafts.hit || b.cost.hit;
    },
    claudeReady: () => runtime.claudeReady(),
    canWrite: () => runtime.canUseClaude(),
    signal: () => runtime.sleepSignal,
    reportFailure: (dep, f) => runtime.reportFailure(dep, f),
    depReady: (dep) => runtime.health.ready(dep),
    reportOk: (dep) => {
      if (runtime.health.state(dep) !== 'ok') runtime.health.ok(dep);
    },
    online: () => runtime.health.state('network') !== 'offline',
    confluence: confluenceApi,
    prompt: (id) => loadPromptFile(config.dataDir, id),
    // Filing guidance: config/vault-conventions.md and config/psg-context-builder.md, or their defaults.
    routing: async () => (await loadPromptFile(config.dataDir, 'confluence-routing')).text,
    conventions: async () => (await loadPromptFile(config.dataDir, 'vault-conventions')).text,
    transcript: async (item, signal) => buildSources(settings.settings, factories).find((s) => s.id === item.source)?.transcript?.(item, signal),
    notify: (n) => publish(n),
  });
  await actions.recover();
  lifecycle.onStop('actions', () => actions.stop());
  // Notifications (FR-11.x): new Now items, and health problems that need Frank.
  let baseUrl: string | undefined = undefined; // set once the server listens
  const notifications = new Notifications({ store, items, notifier, settings: () => settings.editable.settings, now, baseUrl: () => baseUrl, publish: (n) => publish(n), logger });
  const alerts = new HealthAlerts({
    notifier,
    settings: () => settings.editable.settings,
    health: (dep) => runtime.health.get(dep),
    now,
    mono: () => clock.mono(),
    baseUrl: () => baseUrl,
    settingsPaused: () => !settings.settings,
    logger,
  });
  // Retention (FR-12.1): nightly, on the first tick after 03:00.
  const retention = new RetentionJob({ dataDir: config.dataDir, store, items, drafts, settings: () => settings.editable.settings, now, logger });
  lifecycle.onStop('retention', () => retention.settled());
  lifecycle.onStop('notifications', async () => {
    notifications.stop();
    await Promise.all([notifications.settled(), alerts.settled()]);
  });
  // At midnight, This week items due today move into Needs you (cockpit CK-3.10): tell open tabs.
  const newDay = newDayWatcher(() => publish({ topic: 'inbox' }));
  const runtime: Runtime = new Runtime({
    clock,
    store,
    settings,
    logger,
    sources: () => buildSources(settings.settings, factories),
    // After triage, the settle checks on Frank's replies (cockpit CK-2.2): the same run, so they
    // share its breaker, its one-at-a-time and its timing after every poll.
    triage: async (signal, only) => {
      const r = await runTriage(triageDeps, signal, { only });
      if (only) return r;
      const settled = await runSettle(settleDeps, signal);
      return { ...r, calls: r.calls + settled.calls };
    },
    regroup: (signal, conversation) => routeTopics({ ...triageDeps, topicsPrompt: triageDeps.topicsPrompt! }, signal, { regroup: conversation }),
    onTick: () => Promise.all([actions.pump(), notifications.tick(), alerts.tick(), retention.tick()]),
    onTriaged: (catchUp) => notifications.afterTriage(catchUp),
    onHealthChange: (c) => alerts.onChange(c),
    // The sidebar shows which sources are polling (FR-2.6).
    onPollChange: () => publish({ topic: 'inbox' }),
    poll: (s, reason, signal) => pollSource({ store, items, cursors, now, logger, rules: () => ({ rules: settings.rules, settings: settings.editable.settings }), refetch: takeRefetch, enrich: joinCalendar }, s, reason, signal),
    due: (at) => (newDay(at), returnSnoozed(store, at)),
    probe: (signal) => probeNetwork(deps.fetch ?? fetch, signal),
    checks: () => runChecks({ exec: deps.exec ?? systemExec, secrets, instance: config.instance, settingsCheck: () => settingsCheck(settings), claude: () => runtime.health.get('claude') }),
    wakeTime: deps.wakeTime ?? readWakeTime,
    followZone: deps.followZone ?? followSystemZone,
    safeMode: runs.safeMode,
    clearSafeMode: () => clearCrashes(config.dataDir),
    tokenPersisted: persisted,
  });

  const server = await createServer({
    config,
    logger,
    lifecycle,
    store,
    items,
    settings,
    runtime,
    recovery,
    token,
    tokenPersisted: persisted,
    now,
    meId: (source = 'slack') => runtime.identity(source),
    earlier: (item, signal) => earlier.forItem(item, signal),
    // Where the guidance files' sources live (FR-1.7); never the real home folder in tests or fakes.
    promptSources: deps.fakes || process.env.VITEST ? undefined : () => ({ home: homedir(), vault: actions.vaultRoot() }),
    people: (signal) => slackDirectory.listPeople(signal),
    catalogue: (signal) => buildCatalogue(confluenceApi, settings.editable.settings.confluence, signal),
    wispr: deps.wispr ?? (deps.sources ? undefined : wisprLink(wisprAuth, wisprMcp, deps.fetch ?? fetch)),
    outlook: deps.outlook ?? (deps.sources ? undefined : ms365Link(ms365)),
    calendar: () => calendar.snapshot,
    channels: async (signal) => [...(await slackDirectory.conversations(signal)).values()].filter((c) => !c.is_im && !c.is_mpim && c.name).map((c) => `#${c.name}`),
    slackTeamId: () => slackDirectory.identityKnown?.team_id,
    dmTitle: (itemId) => {
      const channel = itemId.split(':')[1];
      const c = slackDirectory.conversation(channel);
      if (c?.is_mpim && slackDirectory.knownMembers(c.id)) return slackDirectory.title(c, []);
      warmMembers(channel);
      return undefined;
    },
    members: async (item, signal) => {
      const ids = await slackDirectory.dmMembersById(item.id.split(':')[1], signal);
      return ids?.map((id) => ({ id, name: slackDirectory.name(id) }));
    },
    usage: () => usage.records(),
    labels,
    correct,
    evals,
    actions,
    webDir: deps.env.WORKOS_WEB_DIR ? resolve(deps.env.WORKOS_WEB_DIR) : undefined,
    // The guide's Markdown: set by agent:install for prod; development reads the repo's copy.
    guideDir: deps.env.WORKOS_GUIDE_DIR ? resolve(deps.env.WORKOS_GUIDE_DIR) : config.instance === 'dev' ? REPO_GUIDE_DIR : undefined,
    extraRoutes,
    devOrigins: config.instance === 'dev' ? (deps.env.WORKOS_DEV_ORIGINS ?? DEV_ORIGINS).split(',') : [],
  });
  publish = (n) => server.hub.publish(n);
  let url: string;
  try {
    url = await server.listen();
  } catch (e) {
    logger.error({ err: e }, 'Could not bind the HTTP port');
    crashed = true; // launchd retries, and it counts towards safe mode
    await lifecycle.stop('bind_failed');
    // Not a deliberate stop: launchd retries after its throttle interval.
    return { running: false, code: EXIT.crash };
  }
  baseUrl = url;
  logger.info({ url, version: config.version, dataDir: config.dataDir, safeMode: runs.safeMode, notifier: notifier.kind }, 'Work OS started');
  await store.append({ type: 'system.started', data: { version: config.version, instance: config.instance } });
  // Stops first: in-flight calls abort before the HTTP server and the store (which snapshots) close.
  lifecycle.onStop('runtime', async (reason) => {
    await runtime.stop();
    await store.append({ type: 'system.stopped', data: { reason } }).catch((err) => logger.error({ err }, 'Could not log the stop'));
  });
  runtime.start();
  // Read the inbox's short texts after the server is up, so a cold start stays fast (NF-11).
  const listed = Object.values(store.projection.items).filter((i) => i.status !== 'done');
  items.preload(listed).catch((err) => logger.warn({ err }, 'Could not preload item texts'));
  return { running: true, url, config, server, store, items, settings, runtime, labels, evals, actions, notifications, alerts, retention, recovery, token, logger, lifecycle, flush };
}
