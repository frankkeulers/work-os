import { randomBytes } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { Notice, WorkEvent } from '@work-os/shared';
import type { FastifyInstance } from 'fastify';

// Server-sent events (FR-3.2). Notices are coalesced for 25 ms, so a poll that touches 20 items
// sends each topic once. Every message has an id `<bootId>.<n>`; a reconnecting client sends
// Last-Event-ID and gets what it missed from a buffer of the last 1,000, or `event: reset` when
// that isn't possible (a restart, or too long away), and then reloads its views.

export const COALESCE_MS = 25;
export const BUFFER_SIZE = 1000;
export const PING_MS = 20_000;
const MAX_BUFFERED_BYTES = 1024 * 1024; // a client this far behind is dropped; it reconnects and resets

type Message = { n: number; data: string };

export class NoticeHub {
  readonly bootId = randomBytes(4).toString('hex');
  private n = 0;
  private buffer: Message[] = [];
  private pending = new Map<string, Notice>();
  private timer?: ReturnType<typeof setTimeout>;
  private clients = new Set<ServerResponse>();
  private ping?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(private readonly opts: { coalesceMs?: number; size?: number; pingMs?: number } = {}) {}

  get clientCount() {
    return this.clients.size;
  }

  publish(...notices: Notice[]) {
    if (this.closed) return;
    for (const n of notices) this.pending.set(JSON.stringify(n), n);
    this.timer ??= setTimeout(() => this.flush(), this.opts.coalesceMs ?? COALESCE_MS);
  }

  /** Sends what is pending now, without waiting for the coalescing window. */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const size = this.opts.size ?? BUFFER_SIZE;
    for (const data of this.pending.keys()) {
      const msg = { n: ++this.n, data };
      this.buffer.push(msg);
      if (this.buffer.length > size) this.buffer.shift();
      for (const c of this.clients) this.write(c, this.format(msg));
    }
    this.pending.clear();
  }

  /** Messages after `lastEventId`, or undefined if the client must reset. */
  since(lastEventId: string | undefined): Message[] | undefined {
    if (!lastEventId) return [];
    const [boot, raw] = lastEventId.split('.');
    const n = Number(raw);
    if (boot !== this.bootId || !Number.isInteger(n) || n > this.n) return undefined;
    if (n === this.n) return [];
    const first = this.buffer[0]?.n ?? this.n + 1;
    if (n + 1 < first) return undefined; // fell out of the buffer
    return this.buffer.filter((m) => m.n > n);
  }

  attach(res: ServerResponse, lastEventId: string | undefined) {
    const backlog = this.since(lastEventId);
    if (backlog === undefined) this.write(res, 'event: reset\ndata: {}\n\n');
    else for (const m of backlog) this.write(res, this.format(m));
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
    this.ping ??= setInterval(() => {
      for (const c of this.clients) this.write(c, ': ping\n\n');
    }, this.opts.pingMs ?? PING_MS);
    this.ping.unref();
  }

  /** Tells every client the server is going away, then ends the streams (SIGTERM). */
  close() {
    this.flush();
    this.closed = true;
    clearInterval(this.ping);
    for (const c of this.clients) c.end('event: shutdown\ndata: {}\n\n');
    this.clients.clear();
  }

  private format(m: Message) {
    return `id: ${this.bootId}.${m.n}\ndata: ${m.data}\n\n`;
  }

  private write(res: ServerResponse, chunk: string) {
    if (res.writableLength > MAX_BUFFERED_BYTES) {
      res.destroy();
      this.clients.delete(res);
      return;
    }
    res.write(chunk);
  }
}

/** The views each event makes stale. Pipeline code publishes notifications and draft_ready itself. */
export function noticesFor(events: WorkEvent[]): Notice[] {
  const out: Notice[] = [];
  for (const e of events) {
    const [area] = e.type.split('.');
    if ((area === 'item' || area === 'triage' || area === 'action') && e.itemId) {
      out.push({ topic: 'item', id: e.itemId }, { topic: 'inbox' });
      if (e.type === 'triage.corrected') out.push({ topic: 'settings' }); // the labelled count
      else if (e.type === 'triage.decided' || e.type === 'triage.failed') out.push({ topic: 'usage' }); // a call was made
    } else if (e.type === 'topic.routed' && e.itemId) {
      // The piece, the topic it joined and the topic it left all show different content now.
      for (const id of new Set([e.itemId, e.data.into, e.data.from])) if (id) out.push({ topic: 'item', id });
      out.push({ topic: 'inbox' });
    } else if (e.type === 'topic.askDone' && e.itemId) out.push({ topic: 'item', id: e.itemId }, { topic: 'inbox' });
    else if (area === 'source') out.push({ topic: 'inbox' }, { topic: 'usage' });
    else if (area === 'settings' || area === 'rules') out.push({ topic: 'settings' }, { topic: 'inbox' }, { topic: 'usage' });
    else if (area === 'prompt') out.push({ topic: 'settings' });
    else if (area === 'health' || area === 'system') out.push({ topic: 'health' });
  }
  return out;
}

export function registerSse(app: FastifyInstance, hub: NoticeHub) {
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': connected\n\n');
    const last = req.headers['last-event-id'];
    hub.attach(res, Array.isArray(last) ? last[0] : last);
  });
}
