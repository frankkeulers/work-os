import { ConfigError, EXIT, exitCode, resolveConfig, type RuntimeConfig } from './config/env';
import { initDataDir, paths } from './config/dataDir';
import { DEFAULT_RULES, defaultSettings } from './config/defaults';
import { join, resolve } from 'node:path';
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
import { returnSnoozed } from './pipeline/due';
import { pollSource } from './pipeline/poll';
import { buildSources, type AdapterFactory } from './sources/registry';
import { slackFactory } from './sources/slack/adapter';
import { SlackApi } from './sources/slack/api';
import { SlackDirectory } from './sources/slack/directory';
import { EarlierMessages } from './sources/slack/earlier';
import { createServer, type WorkOsServer } from './server';
import { budgetsOf, type SourceId } from '@work-os/shared';
import { ClaudeAdapter, type QueryFn } from './claude/adapter';
import { noClaude } from './claude/fakeClaude';
import { DEFAULT_CONFLUENCE_PROMPT, DEFAULT_PEOPLE_CHECK_PROMPT, DEFAULT_TRIAGE_PROMPT, DEFAULT_VAULT_PROMPT, loadPrompt } from './claude/prompts';
import { ConfluenceApi } from './actions/confluenceApi';
import { noConfluence } from './actions/fakeConfluence';
import { homedir } from 'node:os';
import { UsageLog } from './claude/usage';
import { meFrom } from './pipeline/rules';
import { runTriage, type TriageDeps } from './pipeline/triage';
import { correctTriage } from './pipeline/corrections';
import { Evals, runEval } from './pipeline/eval';
import { LabelStore } from './store/labels';
import { DraftStore } from './store/drafts';
import { ActionService } from './actions/service';
import { readFile } from 'node:fs/promises';
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

/** The draft prompts, written to config/prompts/ on first run and read from there on every call. */
const PROMPTS = { 'draft-vault.md': DEFAULT_VAULT_PROMPT, 'draft-confluence.md': DEFAULT_CONFLUENCE_PROMPT, 'people-check.md': DEFAULT_PEOPLE_CHECK_PROMPT };

/** Vite's dev server, which proxies /api to the development instance. */
const DEV_ORIGINS = 'http://localhost:5173,http://127.0.0.1:5173';

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
    deps = { ...deps, secrets: world.secrets, fetch: world.fetch, confluenceFetch: world.confluenceFetch, exec: world.exec, sources: world.sources, claude: world.claude };
    extraRoutes = world.routes;
  }

  const defaults = defaultSettings(config.dataDir);
  if (deps.fakes) {
    const fakes = await import('./fakes');
    defaults.vaultPath = join(config.dataDir, 'fake-vault');
    await fakes.seedFakeVault(defaults.vaultPath);
    const page = fakes.FAKE_CONFLUENCE_PAGE;
    defaults.confluence = { siteUrl: page.siteUrl, spaceKey: page.spaceKey, pages: [{ id: page.id, title: page.title }] };
  }
  const init = await initDataDir(config.dataDir, { settings: defaults, rules: DEFAULT_RULES, prompts: { 'triage.md': DEFAULT_TRIAGE_PROMPT, ...PROMPTS } });
  const { logger, flush } = createLogger({ dir: paths(config.dataDir).logs, echo: deps.echoLogs, now, base: { instance: config.instance } });
  if (init.created.length) logger.info({ created: init.created }, 'Created default config');

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
  const factories = deps.sources ?? { slack: slackFactory(slackDirectory, logger) };
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
  const triageDeps: TriageDeps = {
    store,
    items,
    claude,
    now,
    logger,
    config: () => ({ settings: settings.editable.settings, rules: settings.rules }),
    me: () => meFrom(runtime.whoAmI('slack')),
    prompt: () => loadPrompt(config.dataDir, 'triage.md', DEFAULT_TRIAGE_PROMPT),
    budgetHit: () => {
      const b = budgetsOf(usage.records(), settings.editable.settings, now());
      return b.triage.hit || b.cost.hit;
    },
  };
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
    me: () => triageDeps.me(),
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
    // Belt and braces, as for Claude: a test without a fake Confluence fails instead of calling one.
    confluence: new ConfluenceApi(secrets, () => settings.editable.settings.confluence.siteUrl, deps.confluenceFetch ?? (process.env.VITEST ? noConfluence : fetch)),
    prompt: (name) => loadPrompt(config.dataDir, name, PROMPTS[name]),
    // The routing guidance: a copy in config/, else the installed skill (never in tests or fakes).
    routing: () =>
      readFile(join(config.dataDir, 'config/psg-context-builder.md'), 'utf8').catch(() =>
        deps.fakes || process.env.VITEST ? '' : readFile(join(homedir(), '.claude/skills/psg-context-builder/SKILL.md'), 'utf8').catch(() => ''),
      ),
    conventions: () => readFile(join(config.dataDir, 'config/vault-conventions.md'), 'utf8').catch(() => ''),
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
  const runtime: Runtime = new Runtime({
    clock,
    store,
    settings,
    logger,
    sources: () => buildSources(settings.settings, factories),
    triage: (signal, only) => runTriage(triageDeps, signal, { only }),
    onTick: () => Promise.all([actions.pump(), notifications.tick(), alerts.tick(), retention.tick()]),
    onTriaged: (catchUp) => notifications.afterTriage(catchUp),
    onHealthChange: (c) => alerts.onChange(c),
    poll: (s, reason, signal) => pollSource({ store, items, cursors, now, logger, rules: () => ({ rules: settings.rules, settings: settings.editable.settings }) }, s, reason, signal),
    due: (at) => returnSnoozed(store, at),
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
    meId: () => runtime.identity('slack'),
    earlier: (item, signal) => earlier.forItem(item, signal),
    usage: () => usage.records(),
    labels,
    correct,
    evals,
    actions,
    webDir: deps.env.WORKOS_WEB_DIR ? resolve(deps.env.WORKOS_WEB_DIR) : undefined,
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
