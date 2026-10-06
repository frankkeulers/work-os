import { SettingsSave, SnoozeInput, seenChanges, type EvalReport } from '@work-os/shared';
import type { FastifyInstance } from 'fastify';
import { SettingsValidationError } from '../config/settingsState';
import type { Lifecycle } from '../runtime/lifecycle';
import { HttpError } from './errors';
import { healthView, inboxView, itemView, settingsView, usageView, type ViewDeps } from './views';

// One route per WorkOsApi method (PLAN.md API table). Triage, draft and eval commands arrive with
// M2 and M3.

export function registerRoutes(app: FastifyInstance, d: ViewDeps & { lifecycle: Lifecycle }) {
  const noStore = { 'cache-control': 'no-store' };

  app.get('/api/health', async (_req, reply) => reply.headers(noStore).send(healthView(d, d.lifecycle.isStopping)));

  // "Check again" (FR-12.2): reruns the checks and lets every breaker try once.
  app.post('/api/health/recheck', async (_req, reply) => {
    if (!d.runtime) throw new HttpError('unavailable', 'The runtime is not running.');
    await d.runtime.recheck();
    return reply.code(204).send();
  });

  // "Poll now" (FR-2.6): queued behind any poll in progress; the result arrives over SSE.
  app.post('/api/poll', async (_req, reply) => {
    const rt = d.runtime;
    if (!rt) throw new HttpError('unavailable', 'The runtime is not running.');
    if (rt.safeMode) throw new HttpError('unavailable', 'Safe mode: polling is off after repeated crashes. Choose Check again first.');
    const slack = rt.health.get('slack');
    if (slack.state === 'auth_failed') throw new HttpError('forbidden', 'Slack rejected the token. Fix it in the Keychain, then poll again.');
    if (slack.state === 'rate_limited' && slack.retryAt && slack.retryAt > d.now().toISOString()) {
      throw new HttpError('conflict', 'Slack is rate-limiting. The next poll runs after Retry-After.');
    }
    rt.pollNow();
    return reply.code(202).send();
  });

  // Done, reopen and snooze (FR-8.2): local only, so they work offline. Each is one fsynced event.
  const item = (id: string) => {
    if (!d.store.projection.items[id]) throw new HttpError('not_found', 'Item not found. It may have been removed by retention.');
    return id;
  };
  app.post<{ Params: { id: string } }>('/api/items/:id/done', async (req, reply) => {
    await d.store.append({ type: 'item.done', itemId: item(req.params.id), data: undefined });
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>('/api/items/:id/reopen', async (req, reply) => {
    await d.store.append({ type: 'item.reopened', itemId: item(req.params.id), data: undefined });
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>('/api/items/:id/snooze', async (req, reply) => {
    const id = item(req.params.id);
    const body = SnoozeInput.safeParse(req.body);
    if (!body.success) throw new HttpError('validation', 'Send { until } as an ISO time.', [{ path: 'until', message: 'Pick a time' }]);
    const until = new Date(body.data.until).toISOString();
    if (until <= d.now().toISOString()) throw new HttpError('validation', 'Pick a time in the future.', [{ path: 'until', message: 'Pick a time in the future' }]);
    await d.store.append({ type: 'item.snoozed', itemId: id, data: { until } });
    return reply.code(204).send();
  });

  app.get('/api/inbox', async (_req, reply) => reply.headers(noStore).send(inboxView(d)));

  app.get<{ Params: { id: string } }>('/api/items/:id', async (req, reply) => {
    const view = await itemView(d, req.params.id);
    // Opening an item counts as seeing it; logged only when it clears a flag.
    const it = d.store.projection.items[req.params.id];
    if (it && seenChanges(it)) {
      await d.store.append({ type: 'item.seen', itemId: it.id, data: undefined });
    }
    return reply.headers(noStore).send(view);
  });

  app.get('/api/usage', async (_req, reply) => reply.headers(noStore).send(usageView(d)));

  app.get('/api/evals', async (_req, reply) => reply.headers(noStore).send([] as EvalReport[]));

  app.get('/api/settings', async (_req, reply) => reply.headers(noStore).send(await settingsView(d)));

  app.put('/api/settings', async (req, reply) => {
    const body = SettingsSave.safeParse(req.body);
    if (!body.success) throw new HttpError('validation', 'Send { settings, rules }.');
    let saved;
    try {
      saved = await d.settings.save(body.data, d.now());
    } catch (e) {
      if (e instanceof SettingsValidationError) throw new HttpError('validation', e.message, e.issues);
      throw e;
    }
    const events = [];
    if (saved.settingsChanged) events.push({ type: 'settings.changed' as const, data: { dryRun: saved.settings.dryRun } });
    if (saved.rulesChanged) events.push({ type: 'rules.changed' as const, data: { count: saved.rules.length } });
    if (events.length) await d.store.append(...events);
    if (saved.settingsChanged) d.runtime?.settingsChanged();
    return reply.headers(noStore).send({ savedAt: d.settings.savedAt });
  });
}
