import { classifyError, classifyResponse, classifySlackError } from '../../net/classify';
import { DEADLINES, deadline } from '../../net/http';
import type { FetchFn } from '../../net/probe';
import { SLACK_TOKEN_ACCOUNT, type SecretStore } from '../../config/keychain';
import { SourceError } from '../errors';

// A small Slack Web API client on fetch (FR-2.1, FR-2.2, FR-2.9). No retries of its own: a failed
// call throws a classified SourceError and the breaker decides when to try again. Every call has
// the 20 s deadline and also stops when the Mac sleeps.
//
// The token is read from the Keychain once and kept in memory, so a Keychain locked later in the
// day doesn't stop polling. After an auth failure it is read again, in case Frank replaced it.

export const SLACK_API = 'https://slack.com/api/';

type Params = Record<string, string | number | boolean | undefined>;

export class SlackApi {
  private token?: string;

  constructor(
    private readonly secrets: SecretStore,
    private readonly fetchFn: FetchFn = fetch,
    private readonly base = SLACK_API,
  ) {}

  private async getToken(): Promise<string> {
    if (this.token) return this.token;
    let token: string | undefined;
    try {
      token = await this.secrets.get(SLACK_TOKEN_ACCOUNT);
    } catch {
      throw new SourceError('keychain', { state: 'degraded', reason: 'unreadable' }, 'The Keychain is locked, so the Slack token could not be read.');
    }
    if (!token) throw new SourceError('slack', { state: 'auth_failed', reason: 'token_missing' }, `No Slack token in the Keychain (${SLACK_TOKEN_ACCOUNT}).`);
    return (this.token = token);
  }

  /** Calls a read method. Returns the parsed body when Slack says ok:true. */
  async call<T>(method: string, params: Params, signal?: AbortSignal): Promise<T> {
    const token = await this.getToken();
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v));
    let res: Response;
    try {
      res = await this.fetchFn(this.base + method, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
        body,
        redirect: 'manual',
        signal: deadline(DEADLINES.slack, signal),
      });
    } catch (err) {
      throw new SourceError('slack', classifyError(err), `Slack ${method}: ${classifyError(err).reason}`);
    }
    const http = classifyResponse(res);
    if (http) {
      await res.body?.cancel().catch(() => undefined);
      if (http.state === 'auth_failed') this.token = undefined;
      throw new SourceError('slack', http, `Slack ${method}: ${http.reason}`);
    }
    let json: { ok?: boolean; error?: string } & Record<string, unknown>;
    try {
      json = (await res.json()) as typeof json;
    } catch (err) {
      // A body cut off mid-way is a network failure, not a Slack one.
      const f = classifyError(err);
      throw new SourceError('slack', f.reason === 'error' ? { state: 'degraded', reason: 'bad_json' } : f, `Slack ${method}: unreadable answer`);
    }
    if (json.ok !== true) {
      const f = classifySlackError(json.error ?? 'unknown_error', res.headers.get('retry-after'));
      if (f.state === 'auth_failed') this.token = undefined;
      throw new SourceError('slack', f, `Slack ${method}: ${f.reason}`);
    }
    return json as T;
  }
}
