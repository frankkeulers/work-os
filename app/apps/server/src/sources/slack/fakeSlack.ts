import type { FetchFn } from '../../net/probe';
import { cmpTs } from './normalise';
import type { Conversation, SlackMessage } from './types';

// An in-memory Slack workspace behind a fetch function, for tests and for `--fakes` runs. It
// answers the read methods the adapter uses, the way Slack does: history newest first and without
// thread replies, search matches without thread_ts (the thread is only in the permalink).

export interface FakeChannel extends Conversation {
  member: boolean;
  members?: string[];
  messages: SlackMessage[];
}

export type Injected = { status?: number; headers?: Record<string, string>; body?: unknown; throws?: unknown; times?: number };

export class FakeSlack {
  readonly team = 'https://polestar.slack.com/';
  readonly me = 'UFRANK';
  channels = new Map<string, FakeChannel>();
  users = new Map<string, string>([[this.me, 'Frank']]);
  calls: { method: string; params: Record<string, string>; token?: string }[] = [];
  failures = new Map<string, Injected>();
  token = 'xoxp-fake-token';
  inFlight = 0;
  maxInFlight = 0;
  /** How long each call takes; raised by `npm run perf` to look like the real Slack. */
  latencyMs = 1;

  channel(c: Omit<FakeChannel, 'messages' | 'member'> & { member?: boolean }): this {
    this.channels.set(c.id, { member: true, messages: [], ...c });
    return this;
  }

  post(channel: string, m: SlackMessage): this {
    this.channels.get(channel)!.messages.push(m);
    return this;
  }

  fail(method: string, f: Injected): this {
    this.failures.set(method, { times: 1, ...f });
    return this;
  }

  count = (method: string) => this.calls.filter((c) => c.method === method).length;

  readonly fetch: FetchFn = async (url, init) => {
    const method = url.replace(/^.*\/api\//, '');
    const params = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    this.calls.push({ method, params, token: auth?.replace(/^Bearer /, '') });
    this.inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((r) => setTimeout(r, this.latencyMs));
      const f = this.failures.get(method);
      if (f) {
        if (--f.times! <= 0) this.failures.delete(method);
        if (f.throws) throw f.throws;
        const body = typeof f.body === 'string' ? f.body : JSON.stringify(f.body ?? { ok: false, error: 'fatal_error' });
        return new Response(body, { status: f.status ?? 200, headers: { 'content-type': 'application/json', ...f.headers } });
      }
      if (auth !== `Bearer ${this.token}`) return json({ ok: false, error: 'invalid_auth' });
      return json({ ok: true, ...this.answer(method, params) });
    } finally {
      this.inFlight--;
    }
  };

  private answer(method: string, p: Record<string, string>): object {
    switch (method) {
      case 'auth.test':
        return { url: this.team, user: 'frank', user_id: this.me, team: 'Pole Star', team_id: 'T0POLE' };
      case 'users.info':
        return { user: { id: p.user, profile: { display_name: this.users.get(p.user) ?? '' }, name: p.user.toLowerCase() } };
      case 'conversations.members': {
        const c = this.channels.get(p.channel)!;
        return page(c.members ?? [...new Set([this.me, ...(c.user ? [c.user] : []), ...c.messages.flatMap((m) => (m.user ? [m.user] : []))])], p, 'members');
      }
      case 'users.conversations':
        return page([...this.channels.values()].filter((c) => c.member).map(strip), p, 'channels');
      case 'conversations.replies': {
        const c = this.channels.get(p.channel)!;
        const thread = c.messages.filter((m) => m.ts === p.ts || m.thread_ts === p.ts).sort((a, b) => cmpTs(a.ts, b.ts));
        return page(thread.map((m) => this.withReplies(c, m)), p, 'messages');
      }
      case 'conversations.history': {
        const c = this.channels.get(p.channel)!;
        const inclusive = p.inclusive === '1';
        const top = c.messages
          .filter((m) => !m.thread_ts || m.thread_ts === m.ts || m.subtype === 'thread_broadcast')
          .filter((m) => !p.oldest || (inclusive ? cmpTs(m.ts, p.oldest) >= 0 : cmpTs(m.ts, p.oldest) > 0))
          .filter((m) => !p.latest || (inclusive ? cmpTs(m.ts, p.latest) <= 0 : cmpTs(m.ts, p.latest) < 0))
          .sort((a, b) => cmpTs(b.ts, a.ts));
        return page(top.map((m) => this.withReplies(c, m)), p, 'messages');
      }
      case 'search.messages': {
        const after = /after:(\d{4}-\d{2}-\d{2})/.exec(p.query)?.[1];
        const from = after ? Date.parse(`${after}T00:00:00Z`) / 1000 + 86_400 : 0;
        const all = [...this.channels.values()]
          .filter((c) => !c.is_private || c.member)
          .flatMap((c) =>
            c.messages
              .filter((m) => Number(m.ts.split('.')[0]) >= from)
              .map(({ thread_ts, reply_count: _r, latest_reply: _l, ...m }) => ({
                ...m,
                channel: { id: c.id, name: c.name, is_im: c.is_im, is_mpim: c.is_mpim, is_private: c.is_private },
                permalink: `${this.team}archives/${c.id}/p${m.ts.replace('.', '')}${thread_ts && thread_ts !== m.ts ? `?thread_ts=${thread_ts}&cid=${c.id}` : ''}`,
              })),
          )
          .sort((a, b) => (p.sort_dir === 'asc' ? cmpTs(a.ts, b.ts) : cmpTs(b.ts, a.ts)));
        const count = Number(p.count ?? 20);
        const n = Number(p.page ?? 1);
        return { messages: { matches: all.slice((n - 1) * count, n * count), paging: { page: n, pages: Math.max(1, Math.ceil(all.length / count)), count, total: all.length } } };
      }
      default:
        return {};
    }
  }

  private withReplies(c: FakeChannel, m: SlackMessage): SlackMessage {
    const replies = c.messages.filter((r) => r.thread_ts === m.ts && r.ts !== m.ts);
    if (!replies.length) return m;
    return { ...m, thread_ts: m.ts, reply_count: replies.length, latest_reply: replies.map((r) => r.ts).sort(cmpTs).at(-1) };
  }
}

const json = (body: object) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const strip = ({ member: _m, members: _mb, messages: _ms, ...c }: FakeChannel): Conversation => c;

function page<T>(all: T[], p: Record<string, string>, key: string): object {
  const limit = Number(p.limit ?? 100);
  const start = Number(p.cursor ?? 0);
  const next = start + limit < all.length ? String(start + limit) : '';
  return { [key]: all.slice(start, start + limit), has_more: !!next, response_metadata: { next_cursor: next } };
}
