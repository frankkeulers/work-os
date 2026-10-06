import { ConfigError, EXIT, exitCode, resolveConfig, type RuntimeConfig } from './config/env';
import { initDataDir, paths } from './config/dataDir';
import { DEFAULT_RULES, defaultSettings } from './config/defaults';
import { applyOverrides, loadSettings } from './config/settings';
import { createLogger, type Logger } from './log';
import { silentNotifier, type Notifier } from './notify/macos';
import { Lifecycle } from './runtime/lifecycle';
import { acquireLock, systemProbe, type ProcessProbe } from './runtime/lock';
import { apiKeySet, clearRefusal, refuseApiKey } from './runtime/refuse';
import { createServer, type WorkOsServer } from './server';

// The startup order (PLAN.md robustness §6): refuse an API key, take the lock, load settings
// (falling back if invalid), then bind HTTP. Checks that need the network run after the server
// is ready, so a slow or offline start still shows the UI.

export interface RunDeps {
  env: NodeJS.ProcessEnv;
  notifier?: Notifier;
  probe?: ProcessProbe;
  now?: () => Date;
  echoLogs?: boolean;
}

export type RunResult =
  | { running: false; code: number }
  | { running: true; url: string; config: RuntimeConfig; server: WorkOsServer; logger: Logger; lifecycle: Lifecycle; flush(): void };

export async function run(deps: RunDeps): Promise<RunResult> {
  const notifier = deps.notifier ?? silentNotifier;
  const now = deps.now ?? (() => new Date());
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

  const init = await initDataDir(config.dataDir, { settings: defaultSettings(config.dataDir), rules: DEFAULT_RULES });
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

  const settings = applyOverrides(await loadSettings(config.dataDir), { forceDryRun: config.forceDryRun });
  if (settings.status !== 'ok') {
    logger.warn({ issues: settings.issues }, settings.status === 'fallback' ? 'Settings invalid: using the last good copy' : 'Settings invalid and no good copy: sources paused');
  }

  const server = createServer({ config, logger, settings, lifecycle, now });
  let url: string;
  try {
    url = await server.listen();
  } catch (e) {
    logger.error({ err: e }, 'Could not bind the HTTP port');
    await lifecycle.stop('bind_failed');
    // Not a deliberate stop: launchd retries after its throttle interval.
    return { running: false, code: EXIT.crash };
  }
  logger.info({ url, version: config.version, dataDir: config.dataDir }, 'Work OS started');
  return { running: true, url, config, server, logger, lifecycle, flush };
}
