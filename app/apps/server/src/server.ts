import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { HealthView, StartupCheck } from '@work-os/shared';
import type { RuntimeConfig } from './config/env';
import type { SettingsLoad } from './config/settings';
import type { Logger } from './log';
import type { Lifecycle } from './runtime/lifecycle';

// createServer(deps) builds the HTTP server from injected parts, so tests run it against fakes.
// Routes beyond /api/health arrive with the API step (M1 step 6).

export interface ServerDeps {
  config: RuntimeConfig;
  logger: Logger;
  settings: SettingsLoad;
  lifecycle: Lifecycle;
  now?: () => Date;
}

export interface WorkOsServer {
  app: FastifyInstance;
  /** Binds 127.0.0.1 and returns the base URL. */
  listen(): Promise<string>;
}

function settingsCheck(load: SettingsLoad): StartupCheck {
  const first = load.status === 'ok' ? undefined : load.issues[0];
  const where = first ? `${first.path}: ${first.message}` : '';
  if (load.status === 'ok') return { id: 'settings', label: 'Settings', status: 'ok', note: 'settings.json and rules.json are valid.' };
  if (load.status === 'fallback') return { id: 'settings', label: 'Settings', status: 'warn', note: `Using the last good settings. Fix ${where}` };
  return { id: 'settings', label: 'Settings', status: 'fail', note: `Every source is paused until the settings are fixed. ${where}` };
}

export function createServer(deps: ServerDeps): WorkOsServer {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }), // a line per request would swamp the log
    bodyLimit: 1024 * 1024,
  });

  // While stopping, refuse new work; reads still answer so the UI can show the state (FR-14.6).
  app.addHook('onRequest', async (req, reply) => {
    if (deps.lifecycle.isStopping && req.method !== 'GET') {
      return reply.code(503).send({ code: 'unavailable', message: 'Work OS is shutting down.' });
    }
  });

  app.get('/api/health', async (): Promise<HealthView> => {
    const checks = [settingsCheck(deps.settings)];
    return {
      connection: 'up',
      mode: deps.settings.status === 'ok' ? 'normal' : 'degraded',
      phase: deps.lifecycle.isStopping ? 'stopping' : 'running',
      deps: [],
      checks,
      checkedAt: startedAt,
      outbox: { approved: 0, waiting: 0 },
      instance: deps.config.instance,
      version: deps.config.version,
      startedAt,
    };
  });

  deps.lifecycle.onStop('http', () => app.close());

  return {
    app,
    listen: () => app.listen({ host: deps.config.host, port: deps.config.port }),
  };
}
