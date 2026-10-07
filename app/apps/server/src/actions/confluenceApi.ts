import { CONFLUENCE_TOKEN_ACCOUNT, type SecretStore } from '../config/keychain';
import { classifyError, classifyResponse, type Failure } from '../net/classify';
import { DEADLINES, deadline } from '../net/http';
import type { FetchFn } from '../net/probe';

// Confluence Cloud REST API, the calls filing needs (FR-10.2, FR-10.5, P0-8): a CQL search for the
// catalogue (v1, the only API with CQL), read a page with its storage body and version, and update
// it with the next version number (v2). No retries of its own: a
// failure is classified, health hears about it, and the outbox decides when to try again. The
// credentials are "email:token" under the Keychain account `confluence-api-token`, read once and
// kept in memory; they are never written to settings, logs or prompts.

export interface Page {
  id: string;
  title: string;
  version: number;
  versionMessage: string;
  storage: string;
}

/** A failed call. `conflict` is a 409 on update: someone saved a newer version first. */
export class ConfluenceError extends Error {
  constructor(
    readonly failure: Failure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ConfluenceError';
  }
  get conflict() {
    return this.status === 409;
  }
  get notFound() {
    return this.status === 404;
  }
}

type PageJson = { id?: string; title?: string; version?: { number?: number; message?: string }; body?: { storage?: { value?: string } } };

/** A page as a CQL search finds it: its ancestors (root first) and labels. */
export interface FoundPage {
  id: string;
  title: string;
  ancestors: { id: string; title: string }[];
  labels: string[];
}

type SearchJson = {
  results?: { id?: string; type?: string; title?: string; ancestors?: { id?: string; title?: string }[]; metadata?: { labels?: { results?: { name?: string }[] } } }[];
  _links?: { next?: string };
};

/** At most this many pages from one search; the PSG tree has about 150. */
export const SEARCH_MAX = 1000;
const SEARCH_PAGE = 100;

export class ConfluenceApi {
  private auth?: string;

  constructor(
    private readonly secrets: SecretStore,
    private readonly siteUrl: () => string,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private async authHeader(): Promise<string> {
    if (this.auth) return this.auth;
    let creds: string | undefined;
    try {
      creds = await this.secrets.get(CONFLUENCE_TOKEN_ACCOUNT);
    } catch {
      throw new ConfluenceError({ state: 'degraded', reason: 'keychain_unreadable' }, 'The Keychain is locked, so the Confluence token could not be read.');
    }
    if (!creds || !creds.includes(':')) {
      throw new ConfluenceError({ state: 'auth_failed', reason: 'token_missing' }, `No Confluence credentials in the Keychain (${CONFLUENCE_TOKEN_ACCOUNT}, as email:token).`);
    }
    return (this.auth = `Basic ${Buffer.from(creds).toString('base64')}`);
  }

  /** `path` below /wiki, e.g. `api/v2/pages/1`, or a search's `_links.next` (which may repeat /wiki). */
  private url(path: string) {
    return `${this.siteUrl().replace(/\/+$/, '')}/wiki/${path.replace(/^\/+/, '').replace(/^wiki\//, '')}`;
  }

  private async call<T = PageJson>(method: 'GET' | 'PUT', path: string, timeoutMs: number, signal?: AbortSignal, body?: unknown): Promise<T> {
    const auth = await this.authHeader();
    let res: Response;
    try {
      res = await this.fetchFn(this.url(path), {
        method,
        headers: { authorization: auth, accept: 'application/json', ...(body !== undefined && { 'content-type': 'application/json' }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: deadline(timeoutMs, signal),
      });
    } catch (err) {
      const f = classifyError(err);
      throw new ConfluenceError(f, `Confluence ${method}: ${f.reason}`);
    }
    // Not a health problem: the page moved on (409) or is gone (404). The outbox decides.
    if (res.status === 409 || res.status === 404) {
      await res.body?.cancel().catch(() => undefined);
      throw new ConfluenceError({ state: 'degraded', reason: `http_${res.status}` }, `Confluence ${method}: ${res.status}`, res.status);
    }
    const http = classifyResponse(res);
    if (http) {
      await res.body?.cancel().catch(() => undefined);
      if (http.state === 'auth_failed') this.auth = undefined;
      throw new ConfluenceError(http, `Confluence ${method}: ${http.reason}`, res.status);
    }
    try {
      return (await res.json()) as T;
    } catch (err) {
      const f = classifyError(err);
      throw new ConfluenceError(f.reason === 'error' ? { state: 'degraded', reason: 'bad_json' } : f, `Confluence ${method}: unreadable answer`);
    }
  }

  private page(j: PageJson, id: string): Page {
    const version = j.version?.number;
    if (!version || typeof j.body?.storage?.value !== 'string') throw new ConfluenceError({ state: 'degraded', reason: 'bad_page' }, `Confluence page ${id}: no version or body in the answer`);
    return { id: j.id ?? id, title: j.title ?? id, version, versionMessage: j.version?.message ?? '', storage: j.body.storage.value };
  }

  async getPage(id: string, signal?: AbortSignal): Promise<Page> {
    return this.page(await this.call('GET', `api/v2/pages/${encodeURIComponent(id)}?body-format=storage`, DEADLINES.confluenceGet, signal), id);
  }

  /** Saves `storage` as version `version` (the current one plus one). A 409 means it lost a race. */
  async updatePage(p: { id: string; title: string; storage: string; version: number; message: string }, signal?: AbortSignal): Promise<{ version: number }> {
    const j = await this.call('PUT', `api/v2/pages/${encodeURIComponent(p.id)}`, DEADLINES.confluencePut, signal, {
      id: p.id,
      status: 'current',
      title: p.title,
      body: { representation: 'storage', value: p.storage },
      version: { number: p.version, message: p.message },
    });
    return { version: j.version?.number ?? p.version };
  }

  /**
   * Every page a CQL query finds, with ancestors and labels, following the result pages. Confluence
   * answers a token it doesn't accept as an anonymous user with no results rather than a 401, so an
   * empty answer is checked against the current user before it is believed.
   */
  async search(cql: string, signal?: AbortSignal): Promise<FoundPage[]> {
    const out: FoundPage[] = [];
    let path: string | undefined = `rest/api/content/search?${new URLSearchParams({ cql, expand: 'ancestors,metadata.labels', limit: String(SEARCH_PAGE) })}`;
    while (path && out.length < SEARCH_MAX) {
      const j: SearchJson = await this.call<SearchJson>('GET', path, DEADLINES.confluenceGet, signal);
      for (const r of j.results ?? []) {
        if (!r.id || (r.type && r.type !== 'page')) continue;
        out.push({
          id: r.id,
          title: r.title ?? r.id,
          ancestors: (r.ancestors ?? []).filter((a) => a.id).map((a) => ({ id: a.id!, title: a.title ?? a.id! })),
          labels: (r.metadata?.labels?.results ?? []).map((l) => l.name ?? '').filter(Boolean),
        });
      }
      path = j._links?.next;
    }
    if (!out.length) await this.checkSignedIn(signal);
    return out;
  }

  private async checkSignedIn(signal?: AbortSignal) {
    const me = await this.call<{ type?: string }>('GET', 'rest/api/user/current', DEADLINES.confluenceGet, signal);
    if (me.type === 'anonymous') {
      this.auth = undefined;
      throw new ConfluenceError({ state: 'auth_failed', reason: 'token_rejected' }, `Confluence did not accept the credentials in the Keychain (${CONFLUENCE_TOKEN_ACCOUNT}); it answered as an anonymous user. Create a classic API token and store it as email:token.`);
    }
  }
}
