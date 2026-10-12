import { ApproveRequest, AttentionDismiss, CorrectionBody, DraftEdit, DraftRequest, FilingFeedbackBody, ItemIds, PROPOSAL_MIN_LABELS, STAGE_OF, effectiveTriage, SourceId, mergeEdit, OutlookConnect, PromptReset, PromptSave, SettingsSave, SnoozeInput, anchorOf, seenChanges, sourceSchedule, type ConfluenceCatalogueView, type EarlierView, type GuidanceChange, type Notice, type OutlookStatusView, type PersonOption, type SettingsSaved, type WisprConnectView, type WisprStatusView } from '@work-os/shared';
import type { FastifyInstance } from 'fastify';
import { ConfluenceError, SEARCH_MAX } from '../actions/confluenceApi';
import type { CatalogueEntry } from '../actions/confluenceCatalogue';
import { PROMPT_FILES, promptFile, promptFileView, withCurrentSourceHashes, writePromptFile, type PromptFile, type SourceEnv } from '../claude/promptFiles';
import { SettingsValidationError } from '../config/settingsState';
import { Ms365LinkError } from '../sources/ms365/link';
import type { Lifecycle } from '../runtime/lifecycle';
import { RebuildError } from '../store/store';
import { HttpError } from './errors';
import { readGuide } from './guide';
import { sendJson } from './send';
import { agendaView, attentionView, budgets, filedView, healthView, inboxView, itemView, knownCategories, settingsView, sourceView, usageView, weekView, type ViewDeps } from './views';

// One route per WorkOsApi method (PLAN.md API table).

export function registerRoutes(app: FastifyInstance, d: ViewDeps & { lifecycle: Lifecycle; publish?: (...n: Notice[]) => void }) {
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
  // Many at once (a channel's items, or all of Low priority): one write, skipping those already there,
  // and those a Done or reopen is already on its way for: a double click is one event (RV-S2).
  // Frank's Done or Undo may say the settle check was wrong: labelled from the state before (CK-2.6).
  const changing = new Set<string>();
  const doneOrReopen = async (type: 'item.done' | 'item.reopened', given: string[]) => {
    const ids = [...new Set(given.map(item))].filter((id) => !changing.has(id) && (type === 'item.done' ? d.store.projection.items[id].status !== 'done' : d.store.projection.items[id].status !== 'open'));
    if (!ids.length) return 0;
    for (const id of ids) changing.add(id);
    try {
      await write(type, ids);
    } finally {
      for (const id of ids) changing.delete(id);
    }
    return ids.length;
  };
  const write = async (type: 'item.done' | 'item.reopened', ids: string[]) => {
    const before = ids.map((id) => ({ ...d.store.projection.items[id] }));
    await d.store.append(...ids.map((itemId) => ({ type, itemId, data: undefined })));
    await d.settleLabels?.label(d, before, type === 'item.done' ? 'done' : 'reopened').catch(() => 0); // a label is never worth failing the click
    // Done on a topic that looks finished: the suggestion was right (CK-2.10).
    if (type === 'item.done') for (const it of before) if (it.looksFinished) await d.finishLabels?.labelFinish(d, it, true).catch(() => false);
    // Done from To file with nothing filed: it didn't belong there (FR-15.7).
    if (type === 'item.done') await d.filingFeedback?.doneUnfiled(before).catch(() => 0);
  };
  const many = (type: 'item.done' | 'item.reopened') => async (req: { body: unknown }) => {
    const body = ItemIds.safeParse(req.body);
    if (!body.success) throw new HttpError('validation', 'Send { ids } with at least one item ID.', [{ path: 'ids', message: 'Pick at least one item' }]);
    // Bulk reopen is Undo of a bulk Done: only what is done comes back, not what is snoozed.
    const ids = type === 'item.reopened' ? body.data.ids.filter((id) => d.store.projection.items[id]?.status !== 'snoozed') : body.data.ids;
    return { count: await doneOrReopen(type, ids) };
  };
  app.post('/api/items/done', many('item.done'));
  app.post('/api/items/reopen', many('item.reopened'));
  app.post<{ Params: { id: string } }>('/api/items/:id/done', async (req, reply) => {
    await doneOrReopen('item.done', [req.params.id]);
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>('/api/items/:id/reopen', async (req, reply) => {
    await doneOrReopen('item.reopened', [req.params.id]);
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

  // "Reply in …" (cockpit CK-2.4): the item is read again at +2 and +6 min, so the settle check sees
  // Frank's reply before the next poll. A topic is read through its latest piece too.
  app.post<{ Params: { id: string } }>('/api/items/:id/replied', async (req, reply) => {
    const id = item(req.params.id);
    const p = d.store.projection.items;
    const latest = (p[id].parts ?? [])
      .map((x) => p[x])
      .filter((x) => !!x)
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))[0];
    const ids = [...new Set([id, req.params.id, ...(latest ? [latest.id] : [])])];
    const scheduled = ids.map((x) => d.runtime?.replied(x, p[x].source) ?? false).some(Boolean);
    return reply.headers(noStore).send({ scheduled });
  });

  // Topics (amendment). Ticking off one ask, splitting a piece out of its topic, and Regroup,
  // which asks routing to merge a conversation's open topics.
  app.post<{ Params: { id: string; askId: string } }>('/api/items/:id/asks/:askId/done', async (req, reply) => {
    await d.store.append({ type: 'topic.askDone', itemId: item(req.params.id), data: { askId: req.params.askId } });
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>('/api/items/:id/split', async (req, reply) => {
    item(req.params.id);
    const from = d.store.projection.items[req.params.id].topicOf;
    if (!from) throw new HttpError('conflict', 'This piece is the topic itself, so it can’t be split out. Split out the other pieces instead.');
    await d.store.append({ type: 'topic.routed', itemId: req.params.id, data: { from, by: 'user' } });
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
  // "Not finished" (cockpit CK-2.10): the topic still needs Frank. The suggestion's check was wrong,
  // and so was triage's None: a label for each, and the item goes back to Today.
  app.post<{ Params: { id: string } }>('/api/items/:id/not-finished', async (req, reply) => {
    const id = item(req.params.id);
    if (!d.correct) throw new HttpError('unavailable', 'Corrections are not available.');
    const it = { ...d.store.projection.items[id] };
    if (!it.looksFinished || it.status !== 'open') throw new HttpError('conflict', 'This item is not suggested as finished.');
    await d.finishLabels?.labelFinish(d, it, false).catch(() => false);
    return reply.headers(noStore).send(await d.correct(id, { attention: 'today', confluence: false, vault: false }));
  });
  // "Triage was right": the decision joins the labelled set as it stands.
  app.post<{ Params: { id: string } }>('/api/items/:id/confirm', async (req, reply) => {
    const id = item(req.params.id);
    if (!d.confirm) throw new HttpError('unavailable', 'Confirming triage is not available.');
    return reply.headers(noStore).send(await d.confirm(id));
  });

  // E14 (FR-15.6): Frank dismissed the to-do the policy suggested; it shows again only for a newer revision.
  app.post<{ Params: { id: string } }>('/api/items/:id/todo/dismiss', async (req, reply) => {
    const id = item(req.params.id);
    const it = d.store.projection.items[id];
    if (!it.decision?.todo) throw new HttpError('conflict', 'No to-do is suggested for this item.');
    await d.store.append({ type: 'todo.dismissed', itemId: id, data: { revision: it.decision.itemRevision } });
    await d.filingFeedback?.todo(id, false).catch(() => false);
    return reply.code(204).send();
  });

  // E14 (FR-15.7): Frank's word on the filing policy's call. "Not for filing" is a correction that
  // turns the filings off, so the item leaves To file; the rest only teach the policy.
  app.post<{ Params: { id: string } }>('/api/items/:id/filing-feedback', async (req, reply) => {
    const id = item(req.params.id);
    const f = d.filingFeedback;
    if (!f) throw new HttpError('unavailable', 'Filing feedback is not available.');
    const body = FilingFeedbackBody.safeParse(req.body);
    if (!body.success) throw new HttpError('validation', 'Send { signal: "not_for_filing" | "no_predraft" | "should_be_ready" | "not_ready" }, and { type } for one filing.');
    const it = d.store.projection.items[id];
    const eff = effectiveTriage(it.decision, it.correction);
    const off = (t: 'confluence_entry' | 'vault_note') => !body.data.type || body.data.type === t;
    const signal = body.data.signal;
    if (signal !== 'not_for_filing') {
      // Label first, as for a correction; then the item moves (in or out of Ready, drafted ahead or not).
      const res = await f.feedback(id, body.data);
      const revision = it.decision?.itemRevision ?? it.revision;
      const types = (['confluence_entry', 'vault_note'] as const).filter((t) => off(t) && eff?.[t === 'confluence_entry' ? 'confluence' : 'vault']);
      if (types.length) await d.store.append(...types.map((type) => ({ type: 'filing.staged' as const, itemId: id, data: { revision, type, ...STAGE_OF[signal] } })));
      return reply.headers(noStore).send(res);
    }
    if (!d.correct) throw new HttpError('unavailable', 'Corrections are not available.');
    if (!eff || (!eff.confluence && !eff.vault)) throw new HttpError('conflict', 'This item has nothing to file.');
    await d.correct(id, { attention: eff.attention, confluence: eff.confluence && !off('confluence_entry'), vault: eff.vault && !off('vault_note') });
    return reply.headers(noStore).send({ labelCount: f.counts.labels });
  });

  // Actions (FR-9.x): drafted in the background, written by the outbox after approval.
  const actions = () => {
    if (!d.actions) throw new HttpError('unavailable', 'Actions are not available.');
    return d.actions;
  };
  app.post<{ Params: { id: string } }>('/api/items/:id/actions', async (req, reply) => {
    const id = item(req.params.id);
    const body = DraftRequest.safeParse(req.body);
    if (!body.success) throw new HttpError('validation', 'Send { type: "vault_note" | "confluence_entry" | "todo" }, { quiet } for a draft made ahead in a batch, and { steps } for a to-do’s lines or { suggested: true } for the to-do triage suggested.');
    return reply
      .code(201)
      .headers(noStore)
      .send(await actions().request(id, body.data.type, { quiet: body.data.quiet, steps: body.data.steps, suggested: body.data.suggested }));
  });
  app.post<{ Params: { id: string } }>('/api/actions/:id/cancel', async (req, reply) => {
    await actions().cancel(req.params.id);
    return reply.code(204).send();
  });
  app.put<{ Params: { id: string } }>('/api/actions/:id/draft', async (req, reply) => {
    const body = DraftEdit.safeParse(req.body);
    if (!body.success) throw new HttpError('validation', 'Send { content }, and { part } for a draft that files into several notes.');
    await actions().edit(req.params.id, body.data.content, body.data.part);
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
    const body = ApproveRequest.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError('validation', 'Send nothing, or { markDoneWhenFiled }.');
    await actions().approve(req.params.id, body.data);
    return reply.code(202).send();
  });

  app.post<{ Params: { id: string } }>('/api/actions/:id/retry-write', async (req, reply) => {
    await actions().retryWrite(req.params.id);
    return reply.code(202).send();
  });

  app.get('/api/inbox', async (req, reply) => sendJson(req, reply, inboxView(d)));
  app.get('/api/calendar/agenda', async (_req, reply) => reply.headers(noStore).send(await agendaView(d)));
  // A source's history (cockpit CK-5.1) and the calendar week (CK-5.6).
  app.get<{ Params: { source: string } }>('/api/sources/:source/items', async (req, reply) => {
    const source = SourceId.safeParse(req.params.source);
    if (!source.success) throw new HttpError('not_found', 'No such source.');
    return reply.headers(noStore).send(sourceView(d, source.data));
  });
  app.get<{ Querystring: { start?: string } }>('/api/calendar/week', async (req, reply) => reply.headers(noStore).send(await weekView(d, req.query.start)));

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

  // People for the VIP search: Slack's list when it answers, plus everyone already in the inbox from
  // Slack and Outlook, and the VIPs themselves. One entry per name; Slack's carries the real name.
  app.get('/api/people', async (_req, reply) => {
    const live = (await d.people?.().catch(() => undefined)) ?? [];
    const me = { slack: d.meId?.('slack'), outlook: d.meId?.('outlook') };
    const known = Object.values(d.store.projection.items)
      .flatMap((i) => (i.source === 'slack' || i.source === 'outlook' ? i.participants.filter((p) => p.id !== me[i.source as 'slack' | 'outlook']) : []))
      .filter((p) => p.name && p.name !== p.id)
      .map((p): PersonOption => ({ name: p.name }));
    const vips = d.settings.editable.settings.people.vips.map((name): PersonOption => ({ name }));
    const byName = new Map<string, PersonOption>();
    for (const p of [...live, ...known, ...vips]) if (!byName.has(p.name.toLowerCase())) byName.set(p.name.toLowerCase(), p);
    const people = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    return reply.headers(noStore).send(people);
  });

  // The live Confluence catalogue, for Settings' preview: every page the drafter could pick now.
  app.get('/api/confluence/catalogue', async (_req, reply) => {
    if (!d.catalogue) throw new HttpError('unavailable', 'Confluence is not available.');
    let pages: CatalogueEntry[];
    try {
      pages = await d.catalogue();
    } catch (err) {
      if (err instanceof ConfluenceError) throw new HttpError('unavailable', `Couldn’t read the catalogue: ${err.message}`);
      throw err;
    }
    const view: ConfluenceCatalogueView = {
      pages: pages.map(({ id, title, path, rootId, labels, hub }) => ({ id, title, path, ...(rootId && { rootId }), labels, hub })),
      truncated: pages.length >= SEARCH_MAX,
    };
    return reply.headers(noStore).send(view);
  });

  // The user guide as it is on disk now (FR-1.8), so an edited page shows without a deploy.
  app.get('/api/guide', async (_req, reply) => reply.headers(noStore).send(await readGuide(d.guideDir)));

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

  // The filing eval (FR-15.8): the same, over the filing labels.
  app.get('/api/filing-evals', async (_req, reply) => reply.headers(noStore).send((await d.filingEvals?.list()) ?? []));
  app.post('/api/filing-evals', async (_req, reply) => {
    if (!d.filingEvals) throw new HttpError('unavailable', 'The filing eval is not available.');
    if (!d.filingEvals.running && d.runtime && !d.runtime.claudeReady()) {
      throw new HttpError('unavailable', d.runtime.health.get('claude').fix ?? 'Claude can’t be called right now. Try the eval again later.');
    }
    const r = await d.filingEvals.start();
    if (r === 'no_labels') throw new HttpError('conflict', 'No filing labels yet. Use Filing… on an item, or approve and discard drafts, to add some.');
    return reply.code(202).send();
  });

  app.get('/api/settings', async (_req, reply) => reply.headers(noStore).send(await settingsView(d)));

  // A source turned on or off from its own page, as if Frank had saved Settings with it changed.
  /** Turns sources on or off in one save. */
  const setSourceEnabled = async (ids: SourceId | SourceId[], enabled: boolean) => {
    const { settings: cur, rules } = d.settings.editable;
    const change = [ids].flat().filter((id) => sourceSchedule(cur, id).enabled !== enabled);
    if (!change.length) return;
    const sources = { ...cur.sources };
    for (const id of change) sources[id] = { ...cur.sources?.[id], enabled };
    const saved = await d.settings.save({ settings: { ...cur, sources }, rules }, d.now());
    if (!saved.settingsChanged) return;
    await d.store.append({ type: 'settings.changed', data: { dryRun: saved.settings.dryRun } });
    d.runtime?.settingsChanged();
  };

  // Wispr Flow (R2.7): Connect opens Wispr's sign-in in the browser, which comes back to the
  // callback below; a working sign-in turns the source on and polls it at once.
  const wispr = () => {
    if (!d.wispr) throw new HttpError('unavailable', 'Wispr Flow is not available in this run.');
    return d.wispr;
  };
  const wisprConnected = async () => {
    d.runtime?.health.ok('wisprMcp');
    await setSourceEnabled('wispr', true);
    d.runtime?.pollNow(['wispr']);
  };
  app.get('/api/sources/wispr', async (_req, reply) => reply.headers(noStore).send((await wispr().status()) satisfies WisprStatusView));
  app.post('/api/sources/wispr/connect', async (_req, reply) => {
    let r: WisprConnectView;
    try {
      r = await wispr().begin();
    } catch (e) {
      throw new HttpError('unavailable', `Could not reach Wispr Flow's sign-in: ${(e as Error).message}`);
    }
    if (!r.url) await wisprConnected();
    return reply.headers(noStore).send(r);
  });
  app.post('/api/sources/wispr/disconnect', async (_req, reply) => {
    await wispr().forget();
    await setSourceEnabled('wispr', false);
    return reply.code(204).send();
  });
  // Outside /api: the browser arrives here from Wispr's sign-in page, without the bearer token.
  // The OAuth state, issued by Connect and checked by finish(), is what makes it safe.
  app.get('/oauth/wispr/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    let ok = false;
    let message: string;
    if (q.error || !q.code || !q.state) message = `Wispr Flow did not sign you in${q.error ? ` (${q.error_description ?? q.error})` : ''}. Go back to Work OS and choose Connect again.`;
    else {
      try {
        await wispr().finish(q.code, q.state);
        await wisprConnected();
        ok = true;
        message = 'Wispr Flow is connected. You can close this tab and go back to Work OS.';
      } catch (e) {
        message = `${(e as Error).message}`;
      }
    }
    return reply.code(ok ? 200 : 400).headers({ ...noStore, 'content-type': 'text/html; charset=utf-8' }).send(callbackPage(ok, message));
  });

  // Outlook (R2.5): mail is read through the claude.ai Microsoft 365 connector. Connect finds it
  // (or takes the ID Frank entered), asks it who it reads mail as, saves both, turns the source on
  // and polls it at once. Disconnect only turns the source off: the connector stays on claude.ai.
  const CONNECT_MS = 180_000; // finding the connector, its status, then a get_me run
  const outlookView = (): OutlookStatusView => {
    const cur = d.settings.editable.settings;
    const c = cur.connectors?.ms365;
    const categories = knownCategories(d);
    return { ...(c && { connectorId: c.id }), ...(c?.account && { account: { name: c.account.name, address: c.account.address } }), enabled: sourceSchedule(cur, 'outlook').enabled, ...(categories.length && { categories }) };
  };
  app.get('/api/sources/outlook', async (_req, reply) => reply.headers(noStore).send(outlookView()));
  app.post('/api/sources/outlook/connect', async (req, reply) => {
    if (!d.outlook) throw new HttpError('unavailable', 'Outlook is not available in this run.');
    const body = OutlookConnect.safeParse(req.body ?? {});
    if (!body.success) throw new HttpError('validation', 'That isn’t a connector ID: it has only letters, digits, - and _.');
    // Testing the connector is a (small) Claude run.
    if (d.runtime && !d.runtime.claudeReady()) throw new HttpError('unavailable', d.runtime.health.get('claude').fix ?? 'Claude can’t be called right now. Try Connect again later.');
    let found;
    try {
      found = await d.outlook.connect(body.data.connectorId, AbortSignal.timeout(CONNECT_MS));
    } catch (e) {
      if (e instanceof Ms365LinkError) throw new HttpError('unavailable', e.message);
      throw e;
    }
    const { settings: cur, rules } = d.settings.editable;
    const saved = await d.settings.save(
      { settings: { ...cur, connectors: { ...cur.connectors, ms365: found }, sources: { ...cur.sources, outlook: { ...cur.sources?.outlook, enabled: true } } }, rules },
      d.now(),
    );
    if (saved.settingsChanged) {
      await d.store.append({ type: 'settings.changed', data: { dryRun: saved.settings.dryRun } });
      d.runtime?.settingsChanged();
    }
    d.runtime?.health.ok('ms365');
    d.runtime?.pollNow(['outlook']);
    return reply.headers(noStore).send(outlookView());
  });
  app.post('/api/sources/outlook/disconnect', async (_req, reply) => {
    await setSourceEnabled(['outlook', 'calendar'], false); // both read through the connector
    return reply.code(204).send();
  });

  app.put('/api/settings', async (req, reply) => {
    const body = SettingsSave.safeParse(req.body);
    if (!body.success) throw new HttpError('validation', 'Send { settings, rules }.');
    let saved;
    try {
      // Only what Frank changed from the files the form had: a change made meanwhile (Connect
      // turning Outlook on, Wispr Flow's sign-in) is kept, though the form hadn't caught up with it.
      const cur = d.settings.editable;
      const { base } = body.data;
      const merged = base ? { settings: mergeEdit<unknown>(cur.settings, base.settings, body.data.settings), rules: mergeEdit<unknown>(cur.rules, base.rules, body.data.rules) } : body.data;
      // The connector is set by Outlook's Connect alone: no save can change it.
      const { connectors } = cur.settings;
      const sent = merged.settings;
      const settings = sent && typeof sent === 'object' && !Array.isArray(sent) ? { ...(sent as object), connectors } : sent;
      saved = await d.settings.save({ settings, rules: merged.rules }, d.now());
    } catch (e) {
      if (e instanceof SettingsValidationError) throw new HttpError('validation', e.message, e.issues);
      throw e;
    }
    const events = [];
    if (saved.settingsChanged) events.push({ type: 'settings.changed' as const, data: { dryRun: saved.settings.dryRun } });
    if (saved.rulesChanged) events.push({ type: 'rules.changed' as const, data: { count: saved.rules.length } });
    if (events.length) await d.store.append(...events);
    if (saved.settingsChanged) d.runtime?.settingsChanged();
    return reply.headers(noStore).send({ savedAt: d.settings.savedAt, settings: saved.settings, rules: saved.rules } satisfies SettingsSaved);
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
  const writePrompt = async (f: PromptFile, baseVersion: string, text: string | ((current: string) => Promise<string>), reset: boolean, proposalId?: string) => {
    const current = await promptFileView(dataDir, f);
    if (current.version !== baseVersion) {
      throw new HttpError(
        'conflict',
        proposalId ? `${f.label} changed since this was proposed (now ${current.version}). Propose again from the policy as it is now.` : `${f.label} changed since you opened it (now ${current.version}). Reload it, then make your change again.`,
      );
    }
    await writePromptFile(dataDir, f, typeof text === 'string' ? text : await text(current.text));
    const saved = await promptFileView(dataDir, f, env());
    await d.store.append({ type: 'prompt.changed', data: { id: f.id, version: saved.version, reset, ...(proposalId && { proposalId }) } });
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

  // Proposed filing policies (FR-15.9): started only on Frank's request; applied only by him, through
  // the prompt save path, so a policy edited since the proposal is never overwritten.
  const proposalsOf = () => {
    if (!d.proposals || !d.proposing || !d.filingLabels) throw new HttpError('unavailable', 'Policy proposals are not available.');
    return { store: d.proposals, run: d.proposing, labels: d.filingLabels };
  };
  app.get('/api/proposals', async (_req, reply) => reply.headers(noStore).send(d.proposals ? await d.proposals.list() : []));
  app.post('/api/learning/filing/propose', async (_req, reply) => {
    const { run, labels } = proposalsOf();
    if (!run.running && d.runtime && !d.runtime.claudeReady()) {
      throw new HttpError('unavailable', d.runtime.health.get('claude').fix ?? 'Claude can’t be called right now. Try again later.');
    }
    if (!run.running && budgets(d).cost.hit) throw new HttpError('budget', 'Today’s cost budget is reached. Propose again tomorrow, or raise the budget in Settings › Budgets.');
    const n = labels.counts.labels;
    if (!run.running && n < PROPOSAL_MIN_LABELS) throw new HttpError('conflict', `A proposal needs ${PROPOSAL_MIN_LABELS} labelled items to learn from and to test on; there are ${n}.`);
    await run.start();
    return reply.code(202).send();
  });
  const openProposal = async (id: string) => {
    const p = await proposalsOf().store.get(id);
    if (!p) throw new HttpError('not_found', 'There is no such proposal.');
    if (p.status !== 'open' || !p.text) throw new HttpError('conflict', 'This proposal is no longer open.');
    return p;
  };
  app.post<{ Params: { id: string } }>('/api/proposals/:id/apply', async (req, reply) => {
    const p = await openProposal(req.params.id);
    const saved = await writePrompt(promptOf(p.promptId), p.baseVersion, p.text!, false, p.id);
    await proposalsOf().store.update(p.id, (x) => ({ ...x, status: 'applied', decidedAt: d.now().toISOString(), appliedVersion: saved.version }));
    d.publish?.({ topic: 'settings' }, { topic: 'attention' });
    return reply.headers(noStore).send(saved);
  });
  app.post<{ Params: { id: string } }>('/api/proposals/:id/dismiss', async (req, reply) => {
    const p = await openProposal(req.params.id);
    await proposalsOf().store.update(p.id, (x) => ({ ...x, status: 'dismissed', decidedAt: d.now().toISOString() }));
    d.publish?.({ topic: 'settings' }, { topic: 'attention' });
    return reply.code(204).send();
  });

  // The bell (FR-11.3–11.5): what needs Frank, and dismissing an entry.
  const guidance = guidanceWatch(dataDir, env, d);
  app.get('/api/attention', async (_req, reply) => reply.headers(noStore).send(await attentionView(d, await guidance())));
  app.get('/api/filed', async (_req, reply) => reply.headers(noStore).send(await filedView(d)));
  // Settings › Rebuild state (FR-1.4, Story 1.1): what `npm run rebuild-state` does, for the running server.
  app.post('/api/admin/rebuild-state', async () => {
    try {
      const { events } = await d.store.rebuild();
      d.publish?.({ topic: 'inbox' }, { topic: 'attention' }, { topic: 'health' });
      return { events };
    } catch (err) {
      if (err instanceof RebuildError) throw new HttpError('conflict', err.message);
      throw err;
    }
  });

  app.post('/api/attention/dismiss', async (req, reply) => {
    const body = AttentionDismiss.safeParse(req.body);
    if (!body.success) throw new HttpError('validation', 'Send { key }.');
    if (!d.store.projection.dismissed?.[body.data.key]) await d.store.append({ type: 'attention.dismissed', data: { key: body.data.key } });
    return reply.code(204).send();
  });
}

/** Reading the guidance files' sources hashes files, so the bell keeps the answer this long, or until a prompt file changes. */
export const GUIDANCE_TTL_MS = 10 * 60_000;

/** Guidance files whose sources changed since they were distilled (FR-1.7), for the bell; `since` is when this server first saw it. */
function guidanceWatch(dataDir: string, env: () => SourceEnv | undefined, d: Pick<ViewDeps, 'store' | 'now'>): () => Promise<GuidanceChange[]> {
  let cached: { at: number; value: GuidanceChange[] } | undefined;
  const since = new Map<string, string>();
  d.store.subscribe((events) => {
    if (events.some((e) => e.type === 'prompt.changed')) cached = undefined;
  });
  return async () => {
    const e = env();
    if (!e) return [];
    const now = d.now();
    if (cached && now.getTime() - cached.at < GUIDANCE_TTL_MS) return cached.value;
    const views = await Promise.all(PROMPT_FILES.map((f) => promptFileView(dataDir, f, e)));
    const value: GuidanceChange[] = [];
    for (const v of views) {
      const changed = v.sources.filter((s) => s.state === 'changed').map((s) => s.label);
      if (!changed.length) continue;
      const key = `${v.id}:${changed.join(',')}`;
      if (!since.has(key)) since.set(key, now.toISOString());
      value.push({ id: v.id, label: v.label, changed, since: since.get(key)! });
    }
    cached = { at: now.getTime(), value };
    return value;
  };
}

const escapeHtml = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page the browser lands on after Wispr Flow's sign-in. */
function callbackPage(ok: boolean, message: string): string {
  const title = ok ? 'Wispr Flow connected' : 'Wispr Flow not connected';
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>${title} · Work OS</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#f7f7f8;color:#1d1d1f}main{max-width:28rem;padding:2rem}h1{font-size:1.15rem;margin:0 0 .5rem}@media (prefers-color-scheme:dark){body{background:#161618;color:#ececef}}</style></head><body><main><h1>${title}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}
