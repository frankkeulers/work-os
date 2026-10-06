import type { Notice } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './errors';
import { HttpApi } from './http';

type Call = { url: string; init: RequestInit };

/** A fetch that answers JSON routes and hands out controllable event streams. */
function fakeServer() {
  const calls: Call[] = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const routes = new Map<string, () => Response>();
  let down = false;
  const enc = new TextEncoder();
  const fetchFn = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    if (down) throw new TypeError('fetch failed');
    if (String(url).endsWith('/api/events')) {
      const body = new ReadableStream<Uint8Array>({ start: (c) => void streams.push(c) });
      init.signal?.addEventListener('abort', () => {
        try {
          streams.find((s) => s === streams.at(-1))?.error(init.signal?.reason);
        } catch {
          // already closed
        }
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    const r = routes.get(`${init.method ?? 'GET'} ${String(url)}`);
    return r ? r() : new Response(JSON.stringify({ code: 'not_found', message: 'No such API route.' }), { status: 404 });
  });
  return {
    calls,
    routes,
    fetchFn,
    send: (chunk: string) => streams.at(-1)!.enqueue(enc.encode(chunk)),
    end: () => streams.at(-1)!.close(),
    setDown: (v: boolean) => void (down = v),
    streamCount: () => streams.length,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
let srv: ReturnType<typeof fakeServer>;
let api: HttpApi;
let reloads: number;

beforeEach(() => {
  srv = fakeServer();
  reloads = 0;
  api = new HttpApi('', 'tok', srv.fetchFn as typeof fetch, () => void reloads++);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('requests', () => {
  it('sends the bearer token and JSON, and maps routes from WorkOsApi', async () => {
    srv.routes.set('POST /api/items/slack%3AC1%3A1.2/snooze', () => new Response(null, { status: 204 }));
    await api.snooze('slack:C1:1.2', '2026-10-06T10:00:00.000Z');
    const c = srv.calls.at(-1)!;
    expect(c.init.headers).toMatchObject({ authorization: 'Bearer tok', 'content-type': 'application/json' });
    expect(JSON.parse(String(c.init.body))).toEqual({ until: '2026-10-06T10:00:00.000Z' });
  });

  it('turns error bodies into ApiErrors with their field issues', async () => {
    srv.routes.set('PUT /api/settings', () => new Response(JSON.stringify({ code: 'validation', message: '1 field needs fixing', issues: [{ path: 'slack.vips.0', message: 'Bad' }] }), { status: 422 }));
    const err = await api.saveSettings({} as never, []).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'validation', status: 422, issues: [{ path: 'slack.vips.0', message: 'Bad' }] });
  });

  it('reports an unreachable server as a network error', async () => {
    srv.setDown(true);
    await expect(api.getInbox()).rejects.toMatchObject({ code: 'network' });
  });

  it('reloads the page on 401: the token changed under it', async () => {
    srv.routes.set('GET /api/inbox', () => new Response(JSON.stringify({ code: 'unauthorized', message: 'x' }), { status: 401 }));
    await expect(api.getInbox()).rejects.toMatchObject({ code: 'unauthorized' });
    expect(reloads).toBe(1);
  });

  it('revalidates the inbox with its ETag and reuses the copy it holds on 304', async () => {
    const view = { items: [{ id: 'a' }] };
    let etag = '"v1"';
    srv.routes.set('GET /api/inbox', () => {
      const sent = srv.calls.at(-1)!.init.headers as Record<string, string>;
      if (sent['if-none-match'] === etag) return new Response(null, { status: 304, headers: { etag } });
      return new Response(JSON.stringify(view), { status: 200, headers: { etag, 'content-type': 'application/json' } });
    });
    const first = await api.getInbox();
    expect(srv.calls.at(-1)!.init.headers).not.toHaveProperty('if-none-match');
    expect(await api.getInbox()).toBe(first);
    expect(srv.calls.at(-1)!.init.headers).toMatchObject({ 'if-none-match': '"v1"' });
    etag = '"v2"';
    view.items = [{ id: 'b' }];
    expect((await api.getInbox()).items).toEqual([{ id: 'b' }]);
  });

  it('describes an unreachable server as a health view, so the UI can say so', async () => {
    srv.setDown(true);
    expect((await api.getHealth()).connection).toBe('reconnecting');
  });
});

describe('event stream', () => {
  it('delivers notices, remembers the last id and resumes from it', async () => {
    const got: Notice[] = [];
    api.subscribe((n) => got.push(n));
    await flush();
    expect(api.connection).toBe('up');
    srv.send(': connected\n\n');
    srv.send('id: boot1.1\ndata: {"topic":"inbox"}\n\nid: boot1.2\ndata: {"topic":"item","id":"x"}\n\n: ping\n\n');
    await flush();
    expect(got.filter((n) => n.topic !== 'health')).toEqual([{ topic: 'inbox' }, { topic: 'item', id: 'x' }]);
    srv.end();
    await vi.waitFor(() => expect(srv.streamCount()).toBe(2), { timeout: 2000 });
    expect(srv.calls.filter((c) => c.url.endsWith('/api/events')).at(-1)?.init.headers).toMatchObject({ 'last-event-id': 'boot1.2' });
  });

  it('handles a message split across chunks', async () => {
    const got: Notice[] = [];
    api.subscribe((n) => got.push(n));
    await flush();
    srv.send('id: b.1\nda');
    srv.send('ta: {"topic":"us');
    srv.send('age"}\n\n');
    await flush();
    expect(got).toContainEqual({ topic: 'usage' });
  });

  it('refetches everything on reset', async () => {
    const got: Notice[] = [];
    api.subscribe((n) => got.push(n));
    await flush();
    srv.send('event: reset\ndata: {}\n\n');
    await flush();
    expect(got.map((n) => n.topic)).toEqual(expect.arrayContaining(['health', 'inbox', 'usage', 'settings', 'evals']));
  });

  it('goes reconnecting, then down after 15 s, then up again with a full refresh', async () => {
    vi.useFakeTimers();
    const topics: string[] = [];
    api.subscribe((n) => topics.push(n.topic));
    await vi.advanceTimersByTimeAsync(0);
    expect(api.connection).toBe('up');
    srv.setDown(true);
    srv.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(api.connection).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(20_000); // decided at the retry after 15 s (18.5 s)
    expect(api.connection).toBe('down');
    topics.length = 0;
    srv.setDown(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(api.connection).toBe('up');
    expect(topics).toEqual(expect.arrayContaining(['health', 'inbox', 'usage', 'settings']));
  });

  it('treats 45 s of silence as a dead connection', async () => {
    vi.useFakeTimers();
    api.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(srv.streamCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(45_000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(srv.streamCount()).toBe(2);
  });

  it('closes the stream when the last subscriber leaves', async () => {
    const off = api.subscribe(() => undefined);
    await flush();
    const signal = srv.calls.find((c) => c.url.endsWith('/api/events'))!.init.signal!;
    off();
    expect(signal.aborted).toBe(true);
  });
});
