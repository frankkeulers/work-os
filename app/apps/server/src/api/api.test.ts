import { brotliCompressSync, gunzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { categoryColor, type AgendaView, type ApiErrorBody, type EarlierView, type EventData, type EventDraft, type InboxView, type Item, type ItemView, type OutlookColor, type OutlookStatusView, type PromptFileView, type Settings, type SettingsView, type UsageView, type WorkEvent } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initDataDir, paths } from '../config/dataDir';
import { DEFAULT_RULES, defaultSettings } from '../config/defaults';
import { resolveConfig } from '../config/env';
import { memoryKeychain, type SecretStore } from '../config/keychain';
import { loadSettings } from '../config/settings';
import { SettingsState } from '../config/settingsState';
import { createLogger } from '../log';
import { Lifecycle } from '../runtime/lifecycle';
import { createServer, type WorkOsServer } from '../server';
import type { CalendarSnapshot, SnapEvent } from '../sources/calendar/store';
import { FAKE_CONNECTOR_ID, FakeMs365 } from '../sources/ms365/fakeMs365';
import { ms365Link } from '../sources/ms365/link';
import { ItemFiles, fileNameFor } from '../store/items';
import { Store } from '../store/store';
import { bearerMatches, hostAllowed, loadApiToken, tokenAccount } from './auth';
import { NoticeHub, noticesFor } from './sse';
import type { ViewDeps } from './views';

const TOKEN = 'test-token-0123456789abcdefghijklmnopqrstuvwxyz';
const auth = { authorization: `Bearer ${TOKEN}` };
const ITEM = 'slack:C1:1791189720.000100';
const NOW = new Date('2026-10-05T09:00:00.000Z');

let dir: string;
let server: WorkOsServer;
let store: Store;
let items: ItemFiles;
let lifecycle: Lifecycle;
let storeClock: Date; // when events happen; the views always look at NOW

async function build(opts: { webDir?: string; guideDir?: string; earlier?: ViewDeps['earlier']; promptSources?: ViewDeps['promptSources']; sources?: Settings['sources']; connectors?: Settings['connectors']; wispr?: ViewDeps['wispr']; outlook?: ViewDeps['outlook']; calendar?: ViewDeps['calendar']; categoryColors?: Record<string, OutlookColor>; meetingLeadMinutes?: number } = {}) {
  await initDataDir(dir, { settings: { ...defaultSettings(dir), ...(opts.sources && { sources: opts.sources }), ...(opts.connectors && { connectors: opts.connectors }), ...(opts.categoryColors && { calendar: { categoryColors: opts.categoryColors } }), ...(opts.meetingLeadMinutes && { notifications: { ...defaultSettings(dir).notifications, meetingLeadMinutes: opts.meetingLeadMinutes } }) }, rules: DEFAULT_RULES });
  const config = { ...resolveConfig({ WORKOS_DATA_DIR: dir, WORKOS_PORT: '0' }), forceDryRun: false };
  const { logger } = createLogger({ dir: join(dir, 'logs') });
  lifecycle = new Lifecycle();
  storeClock = NOW;
  ({ store } = await Store.open({ dataDir: dir, now: () => storeClock }));
  lifecycle.onStop('store', () => store.close());
  items = new ItemFiles(join(dir, 'items'));
  const settings = await SettingsState.create(dir, await loadSettings(dir), false);
  server = await createServer({
    config,
    logger,
    lifecycle,
    store,
    items,
    settings,
    token: TOKEN,
    tokenPersisted: true,
    now: () => NOW,
    webDir: opts.webDir,
    guideDir: opts.guideDir,
    earlier: opts.earlier,
    promptSources: opts.promptSources,
    wispr: opts.wispr,
    outlook: opts.outlook,
    calendar: opts.calendar,
    devOrigins: ['http://localhost:5173'],
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workos-api-'));
});
afterEach(async () => {
  await lifecycle?.stop('test');
  await rm(dir, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = auth) => server.app.inject({ method: 'GET', url, headers });
const put = (url: string, payload: unknown) => server.app.inject({ method: 'PUT', url, headers: auth, payload: payload as object });

const upsert = (over: Partial<EventData<'item.upserted'>> = {}): EventDraft => ({
  type: 'item.upserted',
  itemId: ITEM,
  data: {
    source: 'slack',
    kind: 'thread',
    title: '#product',
    permalink: 'https://example.slack.com/archives/C1/p1791189720000100',
    participants: [{ id: 'U1', name: 'Dana Lee' }],
    lastActivityAt: '2026-10-05T08:40:00.000Z',
    revision: 1,
    messageCount: 2,
    fromMeOnly: false,
    ...over,
  },
});
const storedItem = (): Item => ({
  id: ITEM,
  source: 'slack',
  kind: 'thread',
  title: '#product',
  permalink: 'https://example.slack.com/archives/C1/p1791189720000100',
  participants: [{ id: 'U1', name: 'Dana Lee' }],
  messages: [{ id: 'm1', authorId: 'U1', ts: '2026-10-05T08:30:00.000Z', text: 'Can we confirm the renewal price?' }],
  messageCount: 2,
  lastActivityAt: '2026-10-05T08:40:00.000Z',
  revision: 1,
  schemaVersion: 1,
});

describe('request guard (FR-3.3)', () => {
  beforeEach(() => build());

  it('needs the bearer token on every API route', async () => {
    const none = await get('/api/inbox', {});
    expect(none.statusCode).toBe(401);
    expect(none.json<ApiErrorBody>()).toMatchObject({ code: 'unauthorized' });
    expect((await get('/api/inbox', { authorization: 'Bearer wrong' })).statusCode).toBe(401);
    expect((await get('/api/inbox')).statusCode).toBe(200);
  });

  it('lists every enabled source in the inbox and usage health, Slack first (R2.1)', async () => {
    expect((await get('/api/inbox')).json<InboxView>().sources.map((x) => x.id)).toEqual(['slack']);
    await lifecycle.stop('test');
    await rm(dir, { recursive: true, force: true });
    dir = await mkdtemp(join(tmpdir(), 'workos-api-'));
    await build({ sources: { wispr: { enabled: true } } });
    const inbox = (await get('/api/inbox')).json<InboxView>();
    expect(inbox.sources.map((x) => x.id)).toEqual(['slack', 'wispr']);
    expect(inbox.sources[1]).toMatchObject({ id: 'wispr', status: 'never', message: 'Not polled yet.' });
    expect(inbox.sources[1].mode).toBeUndefined();
    expect(inbox.source).toMatchObject({ id: 'slack', mode: 'search' });
    expect((await get('/api/usage')).json<UsageView>().sources.map((x) => x.id)).toEqual(['slack', 'wispr']);
  });

  it('refuses a foreign Host, which is how DNS rebinding arrives', async () => {
    const res = await get('/api/inbox', { ...auth, host: 'evil.example:4318' });
    expect(res.statusCode).toBe(403);
    expect((await get('/', { host: 'evil.example' })).statusCode).toBe(403);
    expect((await get('/api/inbox', { ...auth, host: 'localhost:4318' })).statusCode).toBe(200);
  });

  it('refuses a foreign Origin, and sends no CORS headers', async () => {
    const foreign = await server.app.inject({ method: 'PUT', url: '/api/settings', headers: { ...auth, origin: 'https://evil.example' }, payload: {} });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    expect((await get('/api/inbox', { ...auth, origin: 'http://localhost:5173' })).statusCode).toBe(200);
  });

  it('compares tokens in constant time and only as a Bearer header', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(TOKEN, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(hostAllowed('127.0.0.1:4317')).toBe(true);
    expect(hostAllowed('127.0.0.1.evil.example')).toBe(false);
    expect(hostAllowed(undefined)).toBe(false);
  });

  it('answers unknown API routes with a JSON 404', async () => {
    const res = await get('/api/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'not_found' });
  });
});

describe('API token', () => {
  it('is created once and kept in the Keychain, so tabs survive a restart', async () => {
    const kc = memoryKeychain();
    const first = await loadApiToken(kc, 'prod');
    expect(first.persisted).toBe(true);
    expect(kc.values[tokenAccount('prod')]).toBe(first.token);
    expect((await loadApiToken(kc, 'prod')).token).toBe(first.token);
    expect((await loadApiToken(kc, 'dev')).token).not.toBe(first.token);
  });

  it('falls back to a token for this run when the Keychain is locked', async () => {
    const locked: SecretStore = { get: () => Promise.reject(new Error('locked')), set: () => Promise.reject(new Error('locked')) };
    const t = await loadApiToken(locked, 'prod');
    expect(t.persisted).toBe(false);
    expect(t.token.length).toBeGreaterThanOrEqual(43);
  });
});

describe('static files', () => {
  it('serves the app with the token in a meta tag, and hashed assets as immutable', async () => {
    const web = join(dir, 'web');
    await mkdir(join(web, 'assets'), { recursive: true });
    await writeFile(join(web, 'index.html'), '<!doctype html><html><head><title>Work OS</title></head><body></body></html>');
    const js = 'console.log("work os")'.repeat(20);
    await writeFile(join(web, 'assets/index-abc.js'), js);
    await writeFile(join(web, 'assets/index-abc.js.br'), brotliCompressSync(js));
    await build({ webDir: web });

    for (const path of ['/', '/inbox/slack:C1:1']) {
      const page = await get(path, {});
      expect(page.statusCode).toBe(200);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.body).toContain(`<meta name="workos-token" content="${TOKEN}">`);
    }
    const asset = await get('/assets/index-abc.js', { 'accept-encoding': 'gzip, br' });
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.headers['content-encoding']).toBe('br');
    expect((await get('/assets/index-abc.js', {})).body).toBe(js);
  });

  it('explains itself when the web app isn’t built in', async () => {
    await build();
    const res = await get('/', {});
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatch(/Vite/);
  });
});

describe('views', () => {
  beforeEach(() => build());

  it('lists items newest first with their summary text, and leaves out old done items', async () => {
    await store.append(upsert(), { type: 'triage.decided', itemId: ITEM, data: { decision: { itemId: ITEM, itemRevision: 1, attention: 'today', confluence: { suggested: false }, vault: { suggested: true }, containsPeopleObservations: false, decidedBy: 'model', decidedAt: NOW.toISOString() } } });
    await items.write({ item: storedItem(), text: { summary: 'Renewal price question', reason: 'Asks Frank directly' }, schemaVersion: 1 });
    const old = 'slack:C2:1790000000.000100';
    storeClock = new Date('2026-09-27T09:00:00.000Z'); // done eight days ago
    await store.append({ ...upsert({ lastActivityAt: '2026-09-27T08:00:00.000Z' }), itemId: old }, { type: 'item.done', itemId: old, data: undefined });
    const recent = 'slack:C3:1790000000.000100';
    storeClock = new Date('2026-09-29T09:00:00.000Z'); // done six days ago
    await store.append({ ...upsert({ lastActivityAt: '2026-09-29T08:00:00.000Z' }), itemId: recent }, { type: 'item.done', itemId: recent, data: undefined });

    const inbox = (await get('/api/inbox')).json<InboxView>();
    expect(inbox.items.map((i) => i.id)).toEqual([ITEM, recent]);
    expect(inbox.items[0]).toMatchObject({ lane: 'today', summary: 'Renewal price question', reason: 'Asks Frank directly' });
    expect(inbox).toMatchObject({ firstRun: true, dryRun: true, source: { id: 'slack', status: 'never' } });
  });

  it('shows an item with its messages, or as expired once its file is gone (FR-12.1)', async () => {
    await store.append(upsert());
    await items.write({ item: storedItem(), schemaVersion: 1 });
    const view = (await get(`/api/items/${encodeURIComponent(ITEM)}`)).json<ItemView>();
    expect(view.item.messages).toHaveLength(1);
    expect(view.summary.summary).toBe('Can we confirm the renewal price?');

    await items.remove('slack', ITEM);
    const expired = (await get(`/api/items/${encodeURIComponent(ITEM)}`)).json<ItemView>();
    expect(expired.item).toMatchObject({ contentExpired: true, messages: [], permalink: storedItem().permalink });
    expect((await get('/api/items/slack%3Anope')).statusCode).toBe(404);
  });

  it('reads the messages before an item from the source, and none without one', async () => {
    await store.append(upsert());
    await items.write({ item: storedItem(), schemaVersion: 1 });
    const url = `/api/items/${encodeURIComponent(ITEM)}/earlier`;
    expect((await get(url)).json<EarlierView>()).toEqual({ messages: [], people: [] });
    await lifecycle.stop('test');

    const earlier: EarlierView = { messages: [{ id: '1', authorId: 'U1', ts: NOW.toISOString(), text: 'The question' }], people: [{ id: 'U1', name: 'Dana Lee' }] };
    let asked: string | undefined;
    await build({ earlier: async (item) => ((asked = item.id), earlier) });
    expect((await get(url)).json<EarlierView>()).toEqual(earlier);
    expect(asked).toBe(ITEM);
    expect((await get('/api/items/slack%3Anope/earlier')).statusCode).toBe(404);
  });

  it('marks many items done in one write, skipping ones already done, and reopens them', async () => {
    const other = 'slack:C9:1790000000.000100';
    await store.append(upsert(), { ...upsert(), itemId: other }, { type: 'item.done', itemId: other, data: undefined });
    const post = (url: string, payload: unknown) => server.app.inject({ method: 'POST', url, headers: auth, payload: payload as object });
    expect((await post('/api/items/done', { ids: [ITEM, other, ITEM] })).json()).toEqual({ count: 1 });
    expect(store.projection.items[ITEM].status).toBe('done');
    expect((await post('/api/items/reopen', { ids: [ITEM, other] })).json()).toEqual({ count: 2 });
    expect((await post('/api/items/done', { ids: [] })).statusCode).toBe(422);
    expect((await post('/api/items/done', { ids: ['slack:nope'] })).statusCode).toBe(404);
  });

  it('hides items from channels excluded after they were fetched, and drops repeated names from DM titles', async () => {
    await store.append(upsert({ title: '#tech-all' }), { ...upsert({ kind: 'dm', title: 'Matt, Matt, Ankush' }), itemId: 'slack:G1:1790000000.000100' });
    const s = (await get('/api/settings')).json<SettingsView>();
    await put('/api/settings', { settings: { ...s.settings, slack: { ...s.settings.slack, excludeChannels: ['#tech-all'] } }, rules: s.rules });
    const inbox = (await get('/api/inbox')).json<InboxView>();
    expect(inbox.items.map((i) => i.title)).toEqual(['Matt, Ankush']);
  });

  it('logs item.seen when opening clears a flag, and only then', async () => {
    await store.append(upsert(), { type: 'item.snoozed', itemId: ITEM, data: { until: '2026-10-05T08:59:00.000Z' } }, { type: 'item.unsnoozed', itemId: ITEM, data: undefined });
    const view = (await get(`/api/items/${encodeURIComponent(ITEM)}`)).json<ItemView>();
    expect(view.summary.backFromSnooze).toBe(true);
    expect(store.projection.items[ITEM].backFromSnooze).toBe(false);
    const seq = store.lastSeq;
    await get(`/api/items/${encodeURIComponent(ITEM)}`);
    expect(store.lastSeq).toBe(seq);
  });
});

describe('settings (FR-1.5)', () => {
  beforeEach(() => build());

  it('rejects invalid settings and rules with field paths', async () => {
    const { settings, rules } = (await get('/api/settings')).json<SettingsView>();
    settings.schedule.intervalWorkMinutes = 0;
    rules[3] = { ...rules[3], conditions: [{ type: 'keyword', pattern: '/[oops/' }] };
    const res = await put('/api/settings', { settings, rules });
    expect(res.statusCode).toBe(422);
    expect(res.json<ApiErrorBody>().issues?.map((i) => i.path)).toEqual(['settings.schedule.intervalWorkMinutes', 'rules.3.conditions.0.pattern']);
    expect((await put('/api/settings', [])).statusCode).toBe(422);
  });

  it('saves both files, keeps them as the last good copy and logs what changed', async () => {
    const view = (await get('/api/settings')).json<SettingsView>();
    const seen: WorkEvent[] = [];
    store.subscribe((es) => seen.push(...es));
    const settings = { ...view.settings, dryRun: false };
    const res = await put('/api/settings', { settings, rules: view.rules });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ savedAt: NOW.toISOString(), settings, rules: view.rules });
    expect(seen.map((e) => e.type)).toEqual(['settings.changed']);
    expect(JSON.parse(await readFile(paths(dir).settings, 'utf8')).dryRun).toBe(false);
    expect(JSON.parse(await readFile(paths(dir).settingsLastGood, 'utf8')).dryRun).toBe(false);
    expect((await get('/api/inbox')).json<InboxView>().dryRun).toBe(false);

    await put('/api/settings', { settings, rules: view.rules.slice(1) });
    expect(seen.map((e) => e.type)).toEqual(['settings.changed', 'rules.changed']);
    await put('/api/settings', { settings, rules: view.rules.slice(1) });
    expect(seen).toHaveLength(2); // nothing changed, nothing logged
  });
});

describe('prompt files (FR-1.7)', () => {
  beforeEach(() => build());
  const post = (url: string, payload: unknown, headers: Record<string, string> = auth) => server.app.inject({ method: 'POST', url, headers, payload: payload as object });
  const prompts = async () => (await get('/api/prompts')).json<PromptFileView[]>();

  it('lists the eight files, serving the built-in default when a file is missing', async () => {
    const list = await prompts();
    expect(list.map((p) => p.id)).toEqual(['triage', 'topics', 'draft-vault', 'pick-confluence', 'draft-confluence', 'people-check', 'vault-conventions', 'confluence-routing']);
    const routing = list.find((p) => p.id === 'confluence-routing')!;
    expect(routing).toMatchObject({ path: 'config/psg-context-builder.md', edited: false, version: routing.defaultVersion });
    expect(routing.text).toMatch(/^<!-- prompt: confluence-routing v3 -->/);
  });

  it('saves against the version it was edited from, logs it, and refuses a stale version', async () => {
    const seen: WorkEvent[] = [];
    store.subscribe((es) => seen.push(...es));
    const before = (await prompts()).find((p) => p.id === 'vault-conventions')!;
    const res = await put('/api/prompts/vault-conventions', { text: '<!-- prompt: vault-conventions v3 -->\nMine.\n\n', baseVersion: before.version });
    expect(res.statusCode).toBe(200);
    const saved = res.json<PromptFileView>();
    expect(saved).toMatchObject({ text: '<!-- prompt: vault-conventions v3 -->\nMine.', edited: true, version: expect.stringMatching(/^vault-conventions v3#/) });
    expect(await readFile(join(dir, 'config/vault-conventions.md'), 'utf8')).toBe('<!-- prompt: vault-conventions v3 -->\nMine.\n');
    expect(seen.map((e) => [e.type, e.data])).toEqual([['prompt.changed', { id: 'vault-conventions', version: saved.version, reset: false }]]);
    expect(noticesFor(seen)).toEqual([{ topic: 'settings' }]);

    // Edited elsewhere since it was opened: a conflict, and the file is untouched.
    const stale = await put('/api/prompts/vault-conventions', { text: 'Other', baseVersion: before.version });
    expect(stale.statusCode).toBe(409);
    expect(stale.json<ApiErrorBody>().message).toMatch(/changed since you opened it/);
    expect(await readFile(join(dir, 'config/vault-conventions.md'), 'utf8')).toBe('<!-- prompt: vault-conventions v3 -->\nMine.\n');

    const reset = await post('/api/prompts/vault-conventions/reset', { baseVersion: saved.version });
    expect(reset.json<PromptFileView>()).toMatchObject({ edited: false, version: before.defaultVersion });
    expect(seen.at(-1)?.data).toMatchObject({ reset: true });
  });

  it('flags a changed source, and Mark reviewed records it as it is now', async () => {
    await lifecycle.stop('test');
    const home = join(dir, 'home');
    await mkdir(join(home, '.claude/skills/psg-context-builder'), { recursive: true });
    await writeFile(join(home, '.claude/skills/psg-context-builder/SKILL.md'), 'A newer skill');
    await build({ promptSources: () => ({ home, vault: join(dir, 'vault') }) });
    const routing = (await prompts()).find((p) => p.id === 'confluence-routing')!;
    expect(routing.sources).toMatchObject([{ id: 'psg-context-builder', state: 'changed' }]);
    expect((await prompts()).find((p) => p.id === 'vault-conventions')!.sources.map((x) => x.state)).toEqual(['missing', 'missing', 'missing']);

    const res = await post('/api/prompts/confluence-routing/reviewed', { baseVersion: routing.version });
    expect(res.statusCode).toBe(200);
    const saved = res.json<PromptFileView>();
    expect(saved.sources).toMatchObject([{ state: 'current' }]);
    expect(saved.edited).toBe(true); // the header now differs from the built-in default
    expect(await readFile(join(dir, 'config/psg-context-builder.md'), 'utf8')).toMatch(/<!-- source: psg-context-builder sha1:[0-9a-f]{12} -->/);
    expect((await post('/api/prompts/confluence-routing/reviewed', { baseVersion: routing.version })).statusCode).toBe(409);
  });

  it('cannot mark a file reviewed where the server has no sources (tests, fakes)', async () => {
    const { version } = (await prompts()).find((p) => p.id === 'confluence-routing')!;
    expect((await post('/api/prompts/confluence-routing/reviewed', { baseVersion: version })).statusCode).toBe(503);
  });

  it('rejects empty text, unknown files and foreign origins', async () => {
    const { version } = (await prompts())[0];
    const empty = await put('/api/prompts/triage', { text: '  \n', baseVersion: version });
    expect(empty.statusCode).toBe(422);
    expect(empty.json<ApiErrorBody>().issues).toEqual([{ path: 'text', message: 'The file can’t be empty' }]);
    expect((await put('/api/prompts/nope', { text: 'x', baseVersion: version })).statusCode).toBe(404);
    expect((await post('/api/prompts/triage/reset', { baseVersion: version }, { ...auth, origin: 'https://evil.example' })).statusCode).toBe(403);
  });
});

describe('SSE (FR-3.2)', () => {
  beforeEach(() => build());

  async function connect(url: string, lastEventId?: string) {
    const ctrl = new AbortController();
    const res = await fetch(`${url}/api/events`, { headers: { ...auth, ...(lastEventId && { 'last-event-id': lastEventId }) }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    let text = '';
    const read = async (until: (t: string) => boolean) => {
      while (!until(text)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      return text;
    };
    return { res, read, close: () => ctrl.abort() };
  }
  const ids = (t: string) => [...t.matchAll(/^id: (.+)$/gm)].map((m) => m[1]);

  it('streams notices for new events, coalesced, and resumes from Last-Event-ID', async () => {
    const url = await server.listen();
    const a = await connect(url);
    expect(a.res.headers.get('content-type')).toMatch(/text\/event-stream/);
    await store.append(upsert(), { type: 'item.done', itemId: ITEM, data: undefined });
    const text = await a.read((t) => (t.match(/^data: /gm) ?? []).length >= 2);
    expect([...text.matchAll(/^data: (.+)$/gm)].map((m) => JSON.parse(m[1]))).toEqual([{ topic: 'item', id: ITEM }, { topic: 'inbox' }]);
    const last = ids(text)[0];
    a.close();

    await store.append({ type: 'settings.changed', data: { dryRun: true } });
    const b = await connect(url, last);
    const missed = await b.read((t) => (t.match(/^data: /gm) ?? []).length >= 4);
    expect(missed).toContain('"topic":"inbox"');
    expect(missed).toContain('"topic":"settings"');
    b.close();

    const c = await connect(url, 'otherboot.3');
    expect(await c.read((t) => t.includes('event: reset'))).toContain('event: reset');
    c.close();
  });

  it('sends shutdown and ends the stream when the server stops', async () => {
    const url = await server.listen();
    const a = await connect(url);
    await a.read((t) => t.includes(': connected'));
    void lifecycle.stop('SIGTERM');
    expect(await a.read((t) => t.includes('event: shutdown'))).toContain('event: shutdown');
  });
});

describe('NoticeHub', () => {
  it('sends each topic once per window and drops a client that is too far behind', () => {
    vi.useFakeTimers();
    const hub = new NoticeHub({ size: 3 });
    hub.publish({ topic: 'inbox' }, { topic: 'inbox' }, { topic: 'item', id: 'a' });
    vi.advanceTimersByTime(25);
    expect(hub.since(`${hub.bootId}.0`)?.map((m) => m.data)).toEqual(['{"topic":"inbox"}', '{"topic":"item","id":"a"}']);
    hub.publish({ topic: 'usage' }, { topic: 'settings' }, { topic: 'health' });
    hub.flush();
    expect(hub.since(`${hub.bootId}.1`)).toBeUndefined(); // seq 2 fell out of the 3-message buffer
    expect(hub.since(`${hub.bootId}.2`)).toHaveLength(3);
    expect(hub.since(`${hub.bootId}.99`)).toBeUndefined();
    vi.useRealTimers();
  });

  it('maps events to the views they make stale', () => {
    const e = (type: string, itemId?: string) => ({ type, itemId }) as unknown as WorkEvent;
    expect(noticesFor([e('triage.corrected', 'x')])).toEqual([{ topic: 'item', id: 'x' }, { topic: 'inbox' }, { topic: 'settings' }]);
    expect(noticesFor([e('health.changed')])).toEqual([{ topic: 'health' }]);
  });

  it('refreshes the inbox and every topic a routed piece touches, so Regroup and a split show at once', () => {
    const routed = (itemId: string, data: object) => ({ type: 'topic.routed', itemId, data }) as unknown as WorkEvent;
    expect(noticesFor([routed('b', { into: 'a', by: 'regroup' })])).toEqual([{ topic: 'item', id: 'b' }, { topic: 'item', id: 'a' }, { topic: 'inbox' }]);
    expect(noticesFor([routed('b', { from: 'a', by: 'user' })])).toEqual([{ topic: 'item', id: 'b' }, { topic: 'item', id: 'a' }, { topic: 'inbox' }]);
    expect(noticesFor([{ type: 'topic.askDone', itemId: 'a', data: { askId: 'x' } } as unknown as WorkEvent])).toEqual([{ topic: 'item', id: 'a' }, { topic: 'inbox' }]);
  });
});

describe('ItemFiles', () => {
  it('round-trips items, preloads inbox texts and keeps at most 64 items in memory', async () => {
    const files = new ItemFiles(join(dir, 'items'));
    const ids = Array.from({ length: 70 }, (_, i) => `slack:C1:${i}`);
    for (const id of ids) await files.write({ item: { ...storedItem(), id }, text: { summary: `s-${id}`, reason: 'r' }, schemaVersion: 1 });
    const fresh = new ItemFiles(join(dir, 'items'));
    expect(fresh.text(ids[0])).toBeUndefined();
    await fresh.preload(ids.map((id) => ({ id, source: 'slack' })));
    expect(ids.every((id) => fresh.text(id)?.summary === `s-${id}`)).toBe(true);
    expect((await fresh.read('slack', ids[69]))?.item.id).toBe(ids[69]);
    expect(await fresh.read('slack', 'slack:C9:missing')).toBeUndefined();
    expect(fresh.text('slack:C9:missing')).toEqual({});
    await expect(files.write({ item: { ...storedItem(), participants: [] }, schemaVersion: 1 })).rejects.toThrow();
  });

  it('escapes ids into safe file names', () => {
    expect(fileNameFor('slack:C1:1791189720.000100')).toBe('slack%3aC1%3a1791189720.000100.json');
    expect(fileNameFor('../../etc/passwd')).toBe('..%2f..%2fetc%2fpasswd.json');
  });
});

describe('inbox caching (NF-11)', () => {
  beforeEach(() => build());

  it('answers 304 to an unchanged inbox, 200 once it changes, and is never stored by the browser', async () => {
    await store.append(upsert());
    const first = await get('/api/inbox');
    const etag = String(first.headers.etag);
    expect(etag).toMatch(/^".+"$/);
    expect(first.headers['cache-control']).toBe('no-store');
    const same = await get('/api/inbox', { ...auth, 'if-none-match': etag });
    expect(same.statusCode).toBe(304);
    expect(same.body).toBe('');
    await store.append({ type: 'item.done', itemId: ITEM, data: undefined });
    const changed = await get('/api/inbox', { ...auth, 'if-none-match': etag });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
  });

  it('gzips a large inbox for clients that accept it', async () => {
    for (let i = 0; i < 40; i++) await store.append({ ...upsert({ title: `#channel-${i}` }), itemId: `slack:C${i}:1791189720.000100` });
    const plain = await get('/api/inbox');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.rawPayload.length).toBeGreaterThan(8 * 1024);
    const zipped = await get('/api/inbox', { ...auth, 'accept-encoding': 'gzip, br' });
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(zipped.rawPayload.length).toBeLessThan(plain.rawPayload.length / 4);
    expect(JSON.parse(gunzipSync(zipped.rawPayload).toString())).toEqual(plain.json());
  });
});

describe('GET /api/guide (FR-1.8)', () => {
  it('reads the guide folder as it is now: <slug>.md files only, nothing else', async () => {
    const guide = join(dir, 'guide');
    await mkdir(join(guide, 'nested.md'), { recursive: true });
    await writeFile(join(guide, 'rules.md'), '---\ntitle: Rules\n---\nOld');
    await writeFile(join(guide, 'README.txt'), 'not a page');
    await writeFile(join(guide, 'Bad Name.md'), 'not a page');
    await writeFile(join(guide, 'big.md'), 'x'.repeat(300 * 1024));
    await build({ guideDir: guide });
    const res = await get('/api/guide');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({ dir: guide, files: [{ slug: 'rules', source: '---\ntitle: Rules\n---\nOld' }] });

    // An edit shows on the next request, without a restart.
    await writeFile(join(guide, 'rules.md'), 'New');
    expect((await get('/api/guide')).json().files[0].source).toBe('New');
  });

  it('is unavailable without a guide folder, or with one that is missing, so the app shows its own copy', async () => {
    await build();
    const none = await get('/api/guide');
    expect(none.statusCode).toBe(503);
    expect(none.json<ApiErrorBody>().code).toBe('unavailable');
    await lifecycle.stop('test');

    await build({ guideDir: join(dir, 'nowhere') });
    const missing = await get('/api/guide');
    expect(missing.statusCode).toBe(503);
    expect(missing.json<ApiErrorBody>().message).toMatch(/nowhere is missing/);
  });

  it('needs the bearer token, like every other API route', async () => {
    await build({ guideDir: dir });
    expect((await get('/api/guide', {})).statusCode).toBe(401);
  });
});

describe('Wispr Flow connect (R2.7)', () => {
  const post = (url: string) => server.app.inject({ method: 'POST', url, headers: auth });
  const enabled = async () => (await get('/api/settings')).json<SettingsView>().settings.sources?.wispr?.enabled ?? false;
  let signedIn: boolean;
  const link = (): NonNullable<ViewDeps['wispr']> => ({
    status: async () => ({ connected: signedIn, ...(signedIn && { account: 'Frank Keulers' }) }),
    begin: async () => (signedIn ? {} : { url: 'https://mcp-auth.example/authorize?state=s1' }),
    finish: async (_code, state) => {
      if (state !== 's1') throw new Error('This sign-in link is stale or was not started here. <b>');
      signedIn = true;
    },
    forget: async () => void (signedIn = false),
  });
  beforeEach(() => (signedIn = false));

  it('Connect returns the sign-in page; the callback finishes it and turns the source on', async () => {
    await build({ wispr: link() });
    expect((await get('/api/sources/wispr')).json()).toEqual({ connected: false });
    expect((await post('/api/sources/wispr/connect')).json()).toEqual({ url: 'https://mcp-auth.example/authorize?state=s1' });
    expect(await enabled()).toBe(false);
    // The browser arrives without the bearer token.
    const cb = await get('/oauth/wispr/callback?code=c1&state=s1', {});
    expect(cb.statusCode).toBe(200);
    expect(cb.headers['content-type']).toContain('text/html');
    expect(cb.body).toContain('Wispr Flow is connected');
    expect(await enabled()).toBe(true);
    expect((await get('/api/sources/wispr')).json()).toEqual({ connected: true, account: 'Frank Keulers' });
  });

  it('a stale or refused sign-in says so, escaped, and changes nothing', async () => {
    await build({ wispr: link() });
    const stale = await get('/oauth/wispr/callback?code=c1&state=forged', {});
    expect(stale.statusCode).toBe(400);
    expect(stale.body).toContain('stale');
    expect(stale.body).toContain('&#60;b&#62;');
    const refused = await get('/oauth/wispr/callback?error=access_denied', {});
    expect(refused.statusCode).toBe(400);
    expect(refused.body).toContain('access_denied');
    expect(await enabled()).toBe(false);
  });

  it('Connect with a working sign-in turns the source on at once; Disconnect turns it off', async () => {
    signedIn = true;
    await build({ wispr: link() });
    expect((await post('/api/sources/wispr/connect')).json()).toEqual({});
    expect(await enabled()).toBe(true);
    expect((await post('/api/sources/wispr/disconnect')).statusCode).toBe(204);
    expect(await enabled()).toBe(false);
    expect((await get('/api/sources/wispr')).json()).toEqual({ connected: false });
  });

  it('is unavailable where the server has no Wispr Flow link', async () => {
    await build();
    expect((await get('/api/sources/wispr')).statusCode).toBe(503);
  });
});

describe('Outlook connect (R2.5)', () => {
  const post = (url: string, payload?: object) => server.app.inject({ method: 'POST', url, headers: auth, ...(payload && { payload }) });
  const saved = async () => (await get('/api/settings')).json<SettingsView>().settings;
  let ms365: FakeMs365;
  const link = () => ms365Link((id) => ms365.forId(id));
  const account = { name: 'Frank Keulers', address: 'frank.keulers@example.com' };
  beforeEach(() => (ms365 = new FakeMs365({ me: { displayName: 'Frank Keulers', mail: 'Frank.Keulers@example.com', userPrincipalName: 'fk@example.onmicrosoft.com' } })));

  it('Connect finds the connector, saves it with the account it reads, and turns Outlook on', async () => {
    await build({ outlook: link() });
    expect((await get('/api/sources/outlook')).json()).toEqual({ enabled: false });
    const seen: WorkEvent[] = [];
    store.subscribe((es) => seen.push(...es));
    const res = await post('/api/sources/outlook/connect', {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connectorId: FAKE_CONNECTOR_ID, account, enabled: true });
    const s = await saved();
    expect(s.connectors?.ms365).toEqual({ id: FAKE_CONNECTOR_ID, account: { ...account, upn: 'fk@example.onmicrosoft.com' } });
    expect(s.sources?.outlook?.enabled).toBe(true);
    expect(seen.map((e) => e.type)).toEqual(['settings.changed']);
    expect((await get('/api/sources/outlook')).json()).toEqual({ connectorId: FAKE_CONNECTOR_ID, account, enabled: true });
  });

  it('Connect takes an entered ID, and says so when claude.ai has no such connector', async () => {
    await build({ outlook: link() });
    const wrong = await post('/api/sources/outlook/connect', { connectorId: 'mcpsrv_nosuchconnector' });
    expect(wrong.statusCode).toBe(503);
    expect(wrong.json<ApiErrorBody>().message).toMatch(/no connector with that ID/);
    expect((await saved()).connectors?.ms365).toBeUndefined();
    expect((await saved()).sources?.outlook?.enabled ?? false).toBe(false);

    const bad = await post('/api/sources/outlook/connect', { connectorId: 'not an id!' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json<ApiErrorBody>().code).toBe('validation');

    const ok = await post('/api/sources/outlook/connect', { connectorId: FAKE_CONNECTOR_ID });
    expect(ok.json()).toEqual({ connectorId: FAKE_CONNECTOR_ID, account, enabled: true });
  });

  it('a signed-out connector says to reconnect it on claude.ai, and changes nothing', async () => {
    ms365.status_ = 'needs-auth';
    await build({ outlook: link() });
    const res = await post('/api/sources/outlook/connect', {});
    expect(res.statusCode).toBe(503);
    expect(res.json<ApiErrorBody>().message).toMatch(/signed out\. Reconnect it on claude\.ai/);
    expect((await saved()).connectors?.ms365).toBeUndefined();
  });

  it('Disconnect turns Outlook mail and calendar off and keeps the connector', async () => {
    await build({ outlook: link(), sources: { calendar: { enabled: true, intervalWorkMinutes: 30, intervalOffMinutes: 120 } } });
    await post('/api/sources/outlook/connect', {});
    expect((await post('/api/sources/outlook/disconnect')).statusCode).toBe(204);
    expect((await get('/api/sources/outlook')).json()).toEqual({ connectorId: FAKE_CONNECTOR_ID, account, enabled: false });
    expect((await saved()).sources?.calendar?.enabled).toBe(false);
  });

  it('a Settings save from a form loaded before Connect keeps the connector', async () => {
    await build({ outlook: link() });
    const before = (await get('/api/settings')).json<SettingsView>();
    await post('/api/sources/outlook/connect', {});
    const res = await put('/api/settings', { settings: { ...before.settings, dryRun: !before.settings.dryRun }, rules: before.rules });
    expect(res.statusCode).toBe(200);
    const s = await saved();
    expect(s.dryRun).toBe(!before.settings.dryRun);
    expect(s.connectors?.ms365?.id).toBe(FAKE_CONNECTOR_ID);
    // …and a save can't set one either.
    await put('/api/settings', { settings: { ...s, connectors: { ms365: { id: 'mcpsrv_other' } } }, rules: before.rules });
    expect((await saved()).connectors?.ms365?.id).toBe(FAKE_CONNECTOR_ID);
  });

  it('a Settings save from a form that hasn’t caught up with Connect keeps Outlook on, and changes only what Frank changed', async () => {
    await build({ outlook: link() });
    const before = (await get('/api/settings')).json<SettingsView>();
    expect(before.settings.sources?.outlook?.enabled).toBeFalsy();
    await post('/api/sources/outlook/connect', {});
    const base = { settings: before.settings, rules: before.rules };
    const res = await put('/api/settings', { settings: { ...before.settings, dryRun: !before.settings.dryRun }, rules: before.rules, base });
    expect(res.statusCode).toBe(200);
    const s = await saved();
    expect(s.dryRun).toBe(!before.settings.dryRun);
    expect(s.sources?.outlook?.enabled).toBe(true);
    // The reply is the files as saved, so the form can take Connect's change from it.
    expect(res.json()).toMatchObject({ settings: { dryRun: !before.settings.dryRun, sources: { outlook: { enabled: true } } }, rules: before.rules });
    // Without a base the files are replaced whole, as before.
    await put('/api/settings', { settings: before.settings, rules: before.rules });
    expect((await saved()).sources?.outlook?.enabled).toBeFalsy();
  });

  it('Connect is unavailable where the server has no Outlook link; the status still reads', async () => {
    await build();
    expect((await post('/api/sources/outlook/connect', {})).statusCode).toBe(503);
    expect((await get('/api/sources/outlook')).json()).toEqual({ enabled: false });
  });
});

describe('the agenda (R2.8)', () => {
  const connectors = { ms365: { id: FAKE_CONNECTOR_ID, account: { name: 'Frank Keulers', address: 'frank.keulers@example.com' } } };
  const sources = { calendar: { enabled: true, intervalWorkMinutes: 30, intervalOffMinutes: 120 } };
  const ev = (id: string, start: string, end: string, over: Partial<SnapEvent> = {}): SnapEvent => ({ id, uri: `calendar:///events/${id}`, subject: id, attendees: [], start, end, allDay: false, cancelled: false, isOrganizer: false, ...over });
  // NOW is Monday 5 October, 10:00 in London: today runs from 23:00 UTC on the 4th.
  const snap = (over: Partial<CalendarSnapshot> = {}): CalendarSnapshot => ({
    schemaVersion: 1,
    polledAt: '2026-10-05T08:50:00.000Z',
    from: '2026-10-03T23:00:00.000Z',
    to: '2026-10-19T23:00:00.000Z',
    events: [
      ev('Yesterday', '2026-10-04T13:00:00.000Z', '2026-10-04T14:00:00.000Z', { response: 'accepted' }),
      ev('Stand-up', '2026-10-05T08:00:00.000Z', '2026-10-05T08:15:00.000Z', { response: 'accepted', organizer: { name: 'Sam Ray', address: 'sam@example.com' }, link: 'https://outlook.office365.com/owa/?itemid=1', showAs: 'busy' }),
      ev('Declined', '2026-10-05T10:00:00.000Z', '2026-10-05T11:00:00.000Z', { response: 'declined' }),
      ev('Cancelled', '2026-10-05T11:00:00.000Z', '2026-10-05T12:00:00.000Z', { cancelled: true, response: 'accepted' }),
      ev('Weekly', '2026-10-05T15:00:00.000Z', '2026-10-05T15:30:00.000Z', { isOrganizer: true }),
      ev('Renewal review', '2026-10-06T13:00:00.000Z', '2026-10-06T14:00:00.000Z', { response: 'none', organizer: { address: 'ingrid@nordic.example' } }),
      ev('Answered elsewhere', '2026-10-06T15:00:00.000Z', '2026-10-06T16:00:00.000Z', { response: 'none' }),
      ev('Wednesday', '2026-10-06T23:00:00.000Z', '2026-10-07T00:00:00.000Z', { response: 'accepted' }),
    ],
    invites: [
      { itemId: 'calendar:renewal', eventIds: ['Renewal review'] },
      { itemId: 'calendar:done', eventIds: ['Answered elsewhere'] },
    ],
    ...over,
  });

  it('lists today and tomorrow, without cancelled or declined meetings, and links open invites', async () => {
    await build({ connectors, sources, calendar: () => snap() });
    await store.append({ ...upsert({ source: 'calendar', kind: 'event', title: 'Renewal review' }), itemId: 'calendar:renewal' }, { ...upsert({ source: 'calendar', kind: 'event', title: 'Answered elsewhere' }), itemId: 'calendar:done' });
    await store.append({ type: 'item.done', itemId: 'calendar:done', data: undefined });
    const view = (await get('/api/calendar/agenda')).json<AgendaView>();
    expect(view.state).toBe('ok');
    expect(view.polledAt).toBe('2026-10-05T08:50:00.000Z');
    expect(view.events.map((e) => e.id)).toEqual(['Stand-up', 'Weekly', 'Renewal review', 'Answered elsewhere']);
    expect(view.events[0]).toEqual({ id: 'Stand-up', title: 'Stand-up', start: '2026-10-05T08:00:00.000Z', end: '2026-10-05T08:15:00.000Z', allDay: false, showAs: 'busy', organizer: 'Sam Ray', link: 'https://outlook.office365.com/owa/?itemid=1', response: 'accepted' });
    expect(view.events[1].response).toBe('organizer');
    expect(view.events[2]).toMatchObject({ organizer: 'ingrid@nordic.example', response: 'none', inviteItemId: 'calendar:renewal' });
    expect(view.events[3]).not.toHaveProperty('inviteItemId'); // its item is done
  });

  it('links today’s meetings to their Wispr Flow notes', async () => {
    await build({ connectors, sources, calendar: () => snap() });
    const notes: Item = { ...storedItem(), id: 'wispr:m1', source: 'wispr', kind: 'meeting', title: 'Stand-up', lastActivityAt: '2026-10-05T08:20:00.000Z', meeting: { start: '2026-10-05T08:00:00.000Z', end: '2026-10-05T08:16:00.000Z', calendar: { eventId: 'Stand-up', title: 'Stand-up', invitees: [] } } };
    await items.write({ item: notes, schemaVersion: 1 });
    await store.append({ ...upsert({ source: 'wispr', kind: 'meeting', title: 'Stand-up', lastActivityAt: notes.lastActivityAt }), itemId: 'wispr:m1' });
    const view = (await get('/api/calendar/agenda')).json<AgendaView>();
    expect(view.events.find((e) => e.id === 'Stand-up')?.notesItemId).toBe('wispr:m1');
    expect(view.events.filter((e) => e.notesItemId)).toHaveLength(1);
  });

  it('gives meetings their Outlook categories in the colours chosen in Settings, and lists the categories for Settings › Outlook', async () => {
    const s = snap();
    s.events = s.events.map((e) => (e.id === 'Stand-up' ? { ...e, categories: ['Customer', 'Focus'] } : e));
    await build({ connectors, sources, calendar: () => s, categoryColors: { customer: 'darkRed', Board: 'black' } });
    const view = (await get('/api/calendar/agenda')).json<AgendaView>();
    expect(view.events[0].categories).toEqual([
      { name: 'Customer', color: 'darkRed' }, // chosen, whatever the case
      { name: 'Focus', color: categoryColor('Focus', undefined) }, // its own until one is chosen
    ]);
    expect(view.events[1]).not.toHaveProperty('categories');
    expect((await get('/api/sources/outlook')).json<OutlookStatusView>().categories).toEqual(['Board', 'Customer', 'Focus']);

    // A Wispr Flow meeting joined to the event: the event's categories now, while the snapshot has it, else those it kept.
    const joined = (eventId: string): Item => ({ ...storedItem(), id: `wispr:${eventId}`, source: 'wispr', kind: 'meeting', title: eventId, lastActivityAt: '2026-10-05T08:20:00.000Z', meeting: { start: '2026-10-05T08:00:00.000Z', end: '2026-10-05T08:16:00.000Z', calendar: { eventId, title: eventId, invitees: [], categories: ['Customer'] } } });
    for (const it of [joined('Stand-up'), joined('Last week')]) {
      await items.write({ item: it, schemaVersion: 1 });
      await store.append({ ...upsert({ source: 'wispr', kind: 'meeting', title: it.title, lastActivityAt: it.lastActivityAt }), itemId: it.id });
    }
    expect((await get(`/api/items/${encodeURIComponent('wispr:Stand-up')}`)).json<ItemView>().calendarCategories).toEqual(view.events[0].categories);
    expect((await get(`/api/items/${encodeURIComponent('wispr:Last week')}`)).json<ItemView>().calendarCategories).toEqual([{ name: 'Customer', color: 'darkRed' }]);
  });

  it('is off while the calendar is off, or Outlook was never connected', async () => {
    await build({ connectors, calendar: () => snap() });
    expect((await get('/api/calendar/agenda')).json()).toEqual({ state: 'off', events: [], leadMinutes: 5 });
  });

  it('is off without a connector, even with the calendar switched on', async () => {
    await build({ sources, calendar: () => snap() });
    expect((await get('/api/calendar/agenda')).json()).toEqual({ state: 'off', events: [], leadMinutes: 5 });
  });

  it('says when the calendar has not been read yet', async () => {
    await build({ connectors, sources, calendar: () => undefined });
    expect((await get('/api/calendar/agenda')).json()).toEqual({ state: 'never', events: [], leadMinutes: 5 });
  });

  it('says the agenda is stale once the last read is over three polls old', async () => {
    await build({ connectors, sources, calendar: () => snap({ polledAt: '2026-10-05T07:29:00.000Z' }) });
    expect((await get('/api/calendar/agenda')).json<AgendaView>().state).toBe('stale');
  });

  it('says how long before a meeting it shows as next: 5 minutes, or what Settings has', async () => {
    await build({ connectors, sources, calendar: () => snap(), meetingLeadMinutes: 10 });
    expect((await get('/api/calendar/agenda')).json<AgendaView>().leadMinutes).toBe(10);
  });
});
