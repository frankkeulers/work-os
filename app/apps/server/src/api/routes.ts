import { SettingsSave, seenChanges, type EvalReport } from '@work-os/shared';
import type { FastifyInstance } from 'fastify';
import { SettingsValidationError } from '../config/settingsState';
import type { Lifecycle } from '../runtime/lifecycle';
import { HttpError } from './errors';
import { healthView, inboxView, itemView, settingsView, usageView, type ViewDeps } from './views';

// One route per WorkOsApi method (PLAN.md API table). Commands arrive with the steps that
// implement them; this step has the reads and saving settings.

export function registerRoutes(app: FastifyInstance, d: ViewDeps & { lifecycle: Lifecycle }) {
  const noStore = { 'cache-control': 'no-store' };

  app.get('/api/health', async (_req, reply) => reply.headers(noStore).send(healthView(d, d.lifecycle.isStopping)));

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
    return reply.headers(noStore).send({ savedAt: d.settings.savedAt });
  });
}
