import type { FetchFn } from '../net/probe';

// A made-up Confluence for tests and `--fakes` runs: the REST v2 page read and save filing uses,
// with versions, version messages and a 409 when a save is not exactly the next version, and the
// v1 CQL search the catalogue uses, for the CQL the catalogue writes. Every page sits under the
// space home (not a page here). Never the real site.

export const FAKE_CONFLUENCE_CREDS = 'frank@example.com:fake-confluence-token';

/** The space home every page sits under; the first ancestor in a search answer. */
export const FAKE_SPACE_HOME = { id: '1000000', title: 'Space home' };

interface FakePage {
  title: string;
  version: number;
  message: string;
  storage: string;
  parent?: string;
  labels: string[];
}

export class FakeConfluence {
  pages = new Map<string, FakePage>();
  /** Page reads and saves, in order. */
  calls: { method: string; id: string; version?: number }[] = [];
  /** The CQL of every search, in order. */
  searches: string[] = [];
  /** Answers the next calls with these HTTP statuses instead, in order. */
  failNext: number[] = [];
  /** Throws (as a dropped connection would) on the next call. */
  dropNext = false;
  /** Answers as the real site does for a token it doesn't accept: an anonymous user who sees nothing. */
  anonymous = false;
  /** Results per search page, so tests can exercise paging. */
  pageSize = 100;

  constructor(readonly space = 'MVI') {}

  page(id: string, title: string, storage: string, version = 7, opts: { parent?: string; labels?: string[] } = {}) {
    this.pages.set(id, { title, version, message: '', storage, parent: opts.parent, labels: opts.labels ?? [] });
    return this;
  }

  /** Someone else saves the page. */
  edit(id: string, storage: string) {
    const p = this.pages.get(id)!;
    this.pages.set(id, { ...p, storage, version: p.version + 1, message: 'Edited in Confluence' });
  }

  /** Root first, starting with the space home. */
  ancestors(id: string): { id: string; title: string }[] {
    const chain: { id: string; title: string }[] = [];
    for (let p = this.pages.get(id)?.parent; p && chain.length < 50; p = this.pages.get(p)?.parent) {
      const page = this.pages.get(p);
      if (page) chain.unshift({ id: p, title: page.title });
    }
    return [FAKE_SPACE_HOME, ...chain];
  }

  fetch: FetchFn = async (url, init) => {
    const method = init?.method ?? 'GET';
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (this.dropNext) {
      this.dropNext = false;
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    }
    const forced = this.failNext.shift();
    if (forced) return json(forced, { message: `forced ${forced}` });
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== `Basic ${Buffer.from(FAKE_CONFLUENCE_CREDS).toString('base64')}`) return json(401, { message: 'Unauthorized' });

    const u = new URL(url);
    if (u.pathname.endsWith('/wiki/rest/api/user/current')) return json(200, this.anonymous ? { type: 'anonymous' } : { type: 'known', displayName: 'Frank' });
    if (u.pathname.endsWith('/wiki/rest/api/content/search')) {
      const cql = u.searchParams.get('cql') ?? '';
      const start = Number(u.searchParams.get('start') ?? 0);
      if (!start) this.searches.push(cql);
      let match: (p: Ctx) => boolean;
      try {
        match = parseCql(cql);
      } catch (e) {
        return json(400, { message: (e as Error).message });
      }
      const all = this.anonymous ? [] : [...this.pages.entries()].filter(([id, p]) => match({ id, page: p, space: this.space, ancestors: this.ancestors(id) }));
      const slice = all.slice(start, start + this.pageSize);
      const next = start + this.pageSize < all.length ? `/rest/api/content/search?${new URLSearchParams({ cql, start: String(start + this.pageSize) })}` : undefined;
      return json(200, {
        results: slice.map(([id, p]) => ({ id, type: 'page', title: p.title, ancestors: this.ancestors(id), metadata: { labels: { results: p.labels.map((name) => ({ name })) } } })),
        size: slice.length,
        _links: { base: `${u.origin}/wiki`, ...(next && { next }) },
      });
    }

    const m = /\/wiki\/api\/v2\/pages\/([^/?]+)/.exec(u.pathname);
    const id = decodeURIComponent(m?.[1] ?? '');
    const page = this.anonymous ? undefined : this.pages.get(id);
    if (!m || !page) return json(404, { message: 'Not found' });
    if (method === 'GET') {
      this.calls.push({ method, id });
      return json(200, { id, title: page.title, version: { number: page.version, message: page.message }, body: { storage: { value: page.storage, representation: 'storage' } } });
    }
    if (method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as { title: string; body: { value: string }; version: { number: number; message: string } };
      this.calls.push({ method, id, version: body.version.number });
      if (body.version.number !== page.version + 1) return json(409, { message: 'Version conflict' });
      this.pages.set(id, { ...page, title: body.title, version: body.version.number, message: body.version.message, storage: body.body.value });
      return json(200, { id, title: body.title, version: { number: body.version.number, message: body.version.message } });
    }
    return json(405, { message: 'Method not allowed' });
  };
}

/** For runs that must never reach Confluence: any call fails loudly. */
export const noConfluence: FetchFn = () => Promise.reject(new Error('This run may not call Confluence.'));

// ---------------------------------------------------------------- a little CQL

interface Ctx {
  id: string;
  page: FakePage;
  space: string;
  ancestors: { id: string }[];
}

/**
 * Enough CQL for the catalogue: space, type, id, ancestor and label with =, !=, in and not in,
 * joined by AND, OR, NOT and parentheses (AND binds tighter). Anything else is an error, as a typo
 * would be on the real site.
 */
export function parseCql(cql: string): (c: Ctx) => boolean {
  const tokens = cql.match(/"(?:[^"\\]|\\.)*"|!=|[(),=]|[A-Za-z0-9_.~-]+/g) ?? [];
  let i = 0;
  const peek = () => tokens[i]?.toLowerCase();
  const take = (want?: string) => {
    const t = tokens[i++];
    if (t === undefined || (want && t.toLowerCase() !== want)) throw new Error(`CQL: expected ${want ?? 'more'} at ${t ?? 'the end'}`);
    return t;
  };
  const value = (t: string) => (t.startsWith('"') ? t.slice(1, -1).replace(/\\(.)/g, '$1') : t);
  const values = () => {
    take('(');
    const out = [value(take())];
    while (peek() === ',') {
      take(',');
      out.push(value(take()));
    }
    take(')');
    return out;
  };
  const field = (name: string, c: Ctx): string[] => {
    switch (name) {
      case 'space':
        return [c.space];
      case 'type':
        return ['page'];
      case 'id':
        return [c.id];
      case 'ancestor':
        return c.ancestors.map((a) => a.id);
      case 'label':
        return c.page.labels;
      default:
        throw new Error(`CQL: unknown field ${name}`);
    }
  };
  const clause = (): ((c: Ctx) => boolean) => {
    const name = take().toLowerCase();
    let op = take().toLowerCase();
    if (op === 'not') op = `not ${take('in')}`;
    const vs = op === 'in' || op === 'not in' ? values() : [value(take())];
    field(name, { id: '', page: { title: '', version: 0, message: '', storage: '', labels: [] }, space: '', ancestors: [] }); // unknown fields fail at parse time
    const has = (c: Ctx) => field(name, c).some((f) => vs.includes(f));
    if (op === '=' || op === 'in') return has;
    if (op === '!=' || op === 'not in') return (c) => !has(c);
    throw new Error(`CQL: unknown operator ${op}`);
  };
  const factor = (): ((c: Ctx) => boolean) => {
    if (peek() === 'not') {
      take();
      const f = factor();
      return (c) => !f(c);
    }
    if (peek() === '(') {
      take('(');
      const e = expr();
      take(')');
      return e;
    }
    return clause();
  };
  const term = () => {
    const fs = [factor()];
    while (peek() === 'and') {
      take();
      fs.push(factor());
    }
    return (c: Ctx) => fs.every((f) => f(c));
  };
  const expr = (): ((c: Ctx) => boolean) => {
    const ts = [term()];
    while (peek() === 'or') {
      take();
      ts.push(term());
    }
    return (c: Ctx) => ts.some((t) => t(c));
  };
  const e = expr();
  if (i < tokens.length) throw new Error(`CQL: unexpected ${tokens[i]}`);
  return e;
}
