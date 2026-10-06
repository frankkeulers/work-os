import { brotliCompressSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiErrorBody, EventData, EventDraft, InboxView, Item, ItemView, SettingsView, WorkEvent } from '@work-os/shared';
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
import { ItemFiles, fileNameFor } from '../store/items';
import { Store } from '../store/store';
import { bearerMatches, hostAllowed, loadApiToken, tokenAccount } from './auth';
import { NoticeHub, noticesFor } from './sse';

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

async function build(opts: { webDir?: string } = {}) {
  await initDataDir(dir, { settings: defaultSettings(dir), rules: DEFAULT_RULES });
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
    expect(res.json()).toEqual({ savedAt: NOW.toISOString() });
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
