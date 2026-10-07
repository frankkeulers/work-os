import { CorrectionBody, DraftEdit, DraftRequest, ItemIds, PromptReset, PromptSave, SettingsSave, SnoozeInput, anchorOf, seenChanges, type EarlierView } from '@work-os/shared';
import type { FastifyInstance } from 'fastify';
import { PROMPT_FILES, promptFile, promptFileView, withCurrentSourceHashes, writePromptFile, type PromptFile } from '../claude/promptFiles';
import { SettingsValidationError } from '../config/settingsState';
import type { Lifecycle } from '../runtime/lifecycle';
import { HttpError } from './errors';
import { sendJson } from './send';
import { healthView, inboxView, itemView, settingsView, usageView, type ViewDeps } from './views';

// One route per WorkOsApi method (PLAN.md API table).

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
    if (slack.state === 'auth_failed') throw new HttpError('forbidden', 'Slack has no working token. Fix it in the Keychain, then choose Check again.');
    if (slack.state === 'rate_limited' && slack.retryAt && slack.retryAt > d.now().toISOString()) {
      throw new HttpError('conflict', 'Slack is rate-limiting. The next poll runs after Retry-After.');
    }
    rt.pollNow();
    return reply.code(202).send();
  });

  // Done, reopen and snooze (FR-8.2): local only, so they work offline. Each is one fsynced event.
  // A part of a topic stands for its topic: these act on the anchor.
  const item = (id: string) => {
    if (!d.store.projection.items[id]) throw new HttpError('not_found', 'Item not found. It may have been removed by retention.');
    return anchorOf(d.store.projection.items, id);
  };
  // Many at once (a channel's items, or all of Low priority): one write, skipping those already there.
  const many = (type: 'item.done' | 'item.reopened') => async (req: { body: unknown }) => {
    const body = ItemIds.safeParse(req.body);
    if (!body.success) throw new HttpError('validation', 'Send { ids } with at least one item ID.', [{ path: 'ids', message: 'Pick at least one item' }]);
    const ids = [...new Set(body.data.ids)].map(item).filter((id) => (d.store.projection.items[id].status === 'done') === (type === 'item.reopened'));
    if (ids.length) await d.store.append(...ids.map((itemId) => ({ type, itemId, data: undefined })));
    return { count: ids.length };
  };
  app.post('/api/items/done', many('item.done'));
  app.post('/api/items/reopen', many('item.reopened'));
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

  // "Try again" on an item (CL-7): triaged now, whatever its quiet window. Answers once it is done.
  app.post<{ Params: { id: string } }>('/api/items/:id/retry-triage', async (req, reply) => {
    const id = item(req.params.id);
    if (!d.runtime) throw new HttpError('unavailable', 'The runtime is not running.');
    const r = await d.runtime.retryTriage(id);
    if (!r.ok) throw new HttpError(r.reason, r.message);
    return reply.code(204).send();
  });

  // Topics (amendment). Ticking off one ask, splitting a piece out of its topic, and Regroup,
  // which asks routing to merge a conversation's open topics.
  app.post<{ Params: { id: string; askId: string } }>('/api/items/:id/asks/:askId/done', async (req, reply) => {
    await d.store.append({ type: 'topic.askDone', itemId: item(req.params.id), data: { askId: req.params.askId } });
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>('/api/items/:id/split', async (req, reply) => {
    item(req.params.id);
    if (!d.store.projection.items[req.params.id].topicOf) throw new HttpError('conflict', 'This piece is the topic itself, so it can’t be split out. Split out the other pieces instead.');
    await d.store.append({ type: 'topic.routed', itemId: req.params.id, data: { by: 'user' } });
    d.runtime?.wantTriage();
    return reply.code(204).send();
  });
  app.post('/api/topics/regroup', async (req, reply) => {
    const conversation = (req.body as { conversation?: unknown } | undefined)?.conversation;
    if (typeof conversation !== 'string' || !conversation) throw new HttpError('validation', 'Send { conversation } with a Slack channel or DM ID.');
    if (!d.runtime) throw new HttpError('unavailable', 'The runtime is not running.');
    const r = await d.runtime.regroup(conversation);
    if (!r.ok) throw new HttpError(r.reason, r.message);
    return reply.headers(noStore).send({ merged: r.merged });
  });

  // "Correct triage" (FR-6.2): the inbox moves the item and the labelled set gains a line.
  app.post<{ Params: { id: string } }>('/api/items/:id/correction', async (req, reply) => {
    const id = item(req.params.id);
    if (!d.correct) throw new HttpError('unavailable', 'Corrections are not available.');
    const body = CorrectionBody.safeParse(req.body);
    if (!body.success) throw new HttpError('validation', 'Send { attention, confluence, vault }.');
    return reply.headers(noStore).send(await d.correct(id, body.data));
  });

  // Actions (FR-9.x): drafted in the background, written by the outbox after approval.
  const actions = () => {
    if (!d.actions) throw new HttpError('unavailable', 'Actions are not available.');
    return d.actions;
  };
  app.post<{ Params: { id: string } }>('/api/items/:id/actions', async (req, reply) => {
    const id = item(req.params.id);
    const body = DraftRequest.safeParse(req.body);
    if (!body.success) throw new HttpError('validation', 'Send { type: "vault_note" | "confluence_entry" }.');
    return reply
      .code(201)
      .headers(noStore)
      .send(await actions().request(id, body.data.type));
  });
  app.post<{ Params: { id: string } }>('/api/actions/:id/cancel', async (req, reply) => {
    await actions().cancel(req.params.id);
    return reply.code(204).send();
  });
  app.put<{ Params: { id: string } }>('/api/actions/:id/draft', async (req, reply) => {
    const body = DraftEdit.safeParse(req.body);
    if (!body.success) throw new HttpError('validation', 'Send { content }.');
    await actions().edit(req.params.id, body.data.content);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>('/api/actions/:id/redraft', async (req, reply) =>
    reply
      .code(201)
      .headers(noStore)
      .send(await actions().redraft(req.params.id)),
  );
  app.post<{ Params: { id: string } }>('/api/actions/:id/discard', async (req, reply) => {
    await actions().discard(req.params.id);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>('/api/actions/:id/approve', async (req, reply) => {
    await actions().approve(req.params.id);
    return reply.code(202).send();
  });

  app.get('/api/inbox', async (req, reply) => sendJson(req, reply, inboxView(d)));

  app.get<{ Params: { id: string } }>('/api/items/:id', async (req, reply) => {
    const view = await itemView(d, req.params.id);
    // Opening an item counts as seeing it; logged only when it clears a flag.
    const it = d.store.projection.items[view.summary.id];
    if (it && seenChanges(it)) {
      await d.store.append({ type: 'item.seen', itemId: it.id, data: undefined });
    }
    return reply.headers(noStore).send(view);
  });

  app.get<{ Params: { id: string } }>('/api/items/:id/earlier', async (req, reply) => {
    const stored = d.store.projection.items[req.params.id] && (await d.items.read(d.store.projection.items[req.params.id].source, req.params.id));
    if (!stored) throw new HttpError('not_found', 'Item not found. It may have been removed by retention.');
    const view: EarlierView = d.earlier ? await d.earlier(stored.item) : { messages: [], people: [] };
    return reply.headers(noStore).send(view);
  });

  // Channel names for the rule editor's search: Slack's list when it answers, plus the channels
  // already in the inbox and settings, so the search still helps while Slack is unreachable.
  app.get('/api/channels', async (_req, reply) => {
    const live = await d.channels?.().catch(() => []);
    const slack = d.settings.editable.settings.slack;
    const known = Object.values(d.store.projection.items)
      .filter((i) => i.source === 'slack' && i.kind !== 'dm' && i.title.startsWith('#'))
      .map((i) => i.title);
    const all = [...(live ?? []), ...known, ...slack.includeChannels, ...slack.excludeChannels, ...slack.customerChannels, ...(slack.appChannels ?? [])]
      .map((c) => (c.startsWith('#') ? c : `#${c}`));
    const names: string[] = [...new Set(all)].sort((a, b) => a.localeCompare(b));
    return reply.headers(noStore).send(names);
  });

  app.get('/api/usage', async (_req, reply) => reply.headers(noStore).send(usageView(d)));

  app.get('/api/evals', async (_req, reply) => reply.headers(noStore).send((await d.evals?.list()) ?? []));

  // "Run eval" (FR-6.1): in the background; the usage and evals views say when it is done.
  app.post('/api/evals', async (_req, reply) => {
    if (!d.evals) throw new HttpError('unavailable', 'The eval is not available.');
    if (!d.evals.running && d.runtime && !d.runtime.claudeReady()) {
      throw new HttpError('unavailable', d.runtime.health.get('claude').fix ?? 'Claude can’t be called right now. Try the eval again later.');
    }
    const r = await d.evals.start();
    if (r === 'no_labels') throw new HttpError('conflict', 'No labelled threads yet. Correct a triage in the inbox to add one.');
    return reply.code(202).send();
  });

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

  // Prompt and guidance files (FR-1.7). Every Claude call reads its file fresh, so a save takes
  // effect on the next call. A save names the version it was edited from; if the file changed on
  // disk since then, it fails as a conflict instead of overwriting.
  const dataDir = d.config.dataDir;
  const promptOf = (id: string) => {
    const f = promptFile(id);
    if (!f) throw new HttpError('not_found', `There is no prompt file called ${id}.`);
    return f;
  };
  const env = () => d.promptSources?.();
  const writePrompt = async (f: PromptFile, baseVersion: string, text: string | ((current: string) => Promise<string>), reset: boolean) => {
    const current = await promptFileView(dataDir, f);
    if (current.version !== baseVersion) {
      throw new HttpError('conflict', `${f.label} changed since you opened it (now ${current.version}). Reload it, then make your change again.`);
    }
    await writePromptFile(dataDir, f, typeof text === 'string' ? text : await text(current.text));
    const saved = await promptFileView(dataDir, f, env());
    await d.store.append({ type: 'prompt.changed', data: { id: f.id, version: saved.version, reset } });
    return saved;
  };

  app.get('/api/prompts', async (_req, reply) => reply.headers(noStore).send(await Promise.all(PROMPT_FILES.map((f) => promptFileView(dataDir, f, env())))));

  app.put<{ Params: { id: string } }>('/api/prompts/:id', async (req, reply) => {
    const f = promptOf(req.params.id);
    const body = PromptSave.safeParse(req.body);
    if (!body.success) throw new HttpError('validation', 'Send { text, baseVersion } with some text.', [{ path: 'text', message: body.error.issues[0]?.message ?? 'Invalid' }]);
    return reply.headers(noStore).send(await writePrompt(f, body.data.baseVersion, body.data.text, false));
  });

  app.post<{ Params: { id: string } }>('/api/prompts/:id/reset', async (req, reply) => {
    const f = promptOf(req.params.id);
    const body = PromptReset.safeParse(req.body);
    if (!body.success) throw new HttpError('validation', 'Send { baseVersion }.');
    return reply.headers(noStore).send(await writePrompt(f, body.data.baseVersion, f.defaultText, true));
  });

  // "Mark reviewed": the guidance has been checked against its changed sources; record them as they are now.
  app.post<{ Params: { id: string } }>('/api/prompts/:id/reviewed', async (req, reply) => {
    const f = promptOf(req.params.id);
    const body = PromptReset.safeParse(req.body);
    if (!body.success) throw new HttpError('validation', 'Send { baseVersion }.');
    const e = env();
    if (!e) throw new HttpError('unavailable', 'This server can’t read the sources (tests or fakes).');
    return reply.headers(noStore).send(await writePrompt(f, body.data.baseVersion, (text) => withCurrentSourceHashes(text, e), false));
  });
}
