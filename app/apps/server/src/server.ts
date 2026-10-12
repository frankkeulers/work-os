import type { AddressInfo } from 'node:net';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { localOrigins, requestGuard } from './api/auth';
import { errorHandler, sendError } from './api/errors';
import { registerRoutes } from './api/routes';
import { NoticeHub, noticesFor, registerSse } from './api/sse';
import { registerStatic } from './api/static';
import type { ViewDeps } from './api/views';
import type { Logger } from './log';
import type { Lifecycle } from './runtime/lifecycle';

// createServer(deps) builds the HTTP server from injected parts, so tests run it against fakes.

export interface ServerDeps extends Omit<ViewDeps, 'startedAt'> {
  logger: Logger;
  lifecycle: Lifecycle;
  token: string;
  webDir?: string; // the built web app; development serves it from Vite instead
  devOrigins?: string[]; // Vite's origin in development
  extraRoutes?: (app: FastifyInstance) => void; // --fakes only
}

export interface WorkOsServer {
  app: FastifyInstance;
  hub: NoticeHub;
  /** Binds 127.0.0.1 and returns the base URL. */
  listen(): Promise<string>;
}

export async function createServer(deps: ServerDeps): Promise<WorkOsServer> {
  const startedAt = deps.now().toISOString();
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    logController: new LogController({ disableRequestLogging: true }), // a line per request would swamp the log
    bodyLimit: 1024 * 1024,
  });
  app.setErrorHandler(errorHandler);

  const port = () => (app.server.address() as AddressInfo | null)?.port ?? deps.config.port;
  let origins: Set<string> | undefined;
  app.addHook('onRequest', requestGuard({ token: deps.token, origins: () => (origins ??= localOrigins(port(), deps.devOrigins)) }));

  // While stopping, refuse new work; reads still answer so the UI can show the state (FR-14.6).
  app.addHook('onRequest', async (req, reply) => {
    if (deps.lifecycle.isStopping && req.method !== 'GET') return sendError(reply, 'unavailable', 'Work OS is shutting down.');
  });

  const hub = new NoticeHub();
  deps.store.subscribe((events) => hub.publish(...noticesFor(events)));
  deps.evals?.onChange(() => hub.publish({ topic: 'usage' }, { topic: 'evals' }));
  deps.filingEvals?.onChange(() => hub.publish({ topic: 'settings' }, { topic: 'evals' }));
  for (const run of Object.values(deps.proposing ?? {})) run.onChange(() => hub.publish({ topic: 'settings' }, { topic: 'attention' }));

  registerRoutes(app, { ...deps, startedAt, publish: (...n) => hub.publish(...n) });
  deps.extraRoutes?.(app);
  registerSse(app, hub);
  await registerStatic(app, { dir: deps.webDir, token: deps.token });

  // Stop hooks run newest first: SSE streams end before the HTTP server waits for requests.
  deps.lifecycle.onStop('http', () => app.close());
  deps.lifecycle.onStop('sse', () => hub.close());

  return {
    app,
    hub,
    listen: () => app.listen({ host: deps.config.host, port: deps.config.port }),
  };
}
