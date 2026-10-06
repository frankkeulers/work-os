import { CONFLUENCE_TOKEN_ACCOUNT, type SecretStore } from '../config/keychain';
import { classifyError, classifyResponse, type Failure } from '../net/classify';
import { DEADLINES, deadline } from '../net/http';
import type { FetchFn } from '../net/probe';

// Confluence Cloud REST API v2, the two calls filing needs (FR-10.5, P0-8): read a page with its
// storage body and version, and update it with the next version number. No retries of its own: a
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

  private url(path: string) {
    return `${this.siteUrl().replace(/\/+$/, '')}/wiki/api/v2/${path}`;
  }

  private async call(method: 'GET' | 'PUT', path: string, timeoutMs: number, signal?: AbortSignal, body?: unknown): Promise<PageJson> {
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
      return (await res.json()) as PageJson;
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
    return this.page(await this.call('GET', `pages/${encodeURIComponent(id)}?body-format=storage`, DEADLINES.confluenceGet, signal), id);
  }

  /** Saves `storage` as version `version` (the current one plus one). A 409 means it lost a race. */
  async updatePage(p: { id: string; title: string; storage: string; version: number; message: string }, signal?: AbortSignal): Promise<{ version: number }> {
    const j = await this.call('PUT', `pages/${encodeURIComponent(p.id)}`, DEADLINES.confluencePut, signal, {
      id: p.id,
      status: 'current',
      title: p.title,
      body: { representation: 'storage', value: p.storage },
      version: { number: p.version, message: p.message },
    });
    return { version: j.version?.number ?? p.version };
  }
}
