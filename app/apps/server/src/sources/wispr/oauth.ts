import { randomBytes } from 'node:crypto';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { WISPR_OAUTH_ACCOUNT, type SecretStore } from '../../config/keychain';
import { WISPR_MCP_URL } from './types';

// Wispr Flow sign-in (R2.7, P0-11): OAuth with dynamic client registration and PKCE, redirected
// back to this server's loopback address. The client registration and tokens are one Keychain
// item, never a file or a log line. Wispr rotates the refresh token on every refresh, so every
// write replaces the item, one at a time, from this process only.
//
// Only Connect in Settings may start a browser sign-in. A poll that finds the sign-in gone gets a
// non-interactive provider: it refuses to redirect, so the poll fails as signed out and never
// overwrites the state and PKCE verifier of a sign-in Frank has just started.

interface Stored {
  client?: OAuthClientInformationMixed;
  redirect?: string; // the redirect the client was registered with
  tokens?: OAuthTokens;
  savedAt?: string;
  pending?: { state: string; verifier?: string }; // a sign-in in progress
  account?: string; // the signed-in name, for Settings
}

/** Thrown by the non-interactive provider where the SDK would open a browser. */
export class SignInNeeded extends Error {
  constructor() {
    super('Wispr Flow needs you to sign in again.');
    this.name = 'SignInNeeded';
  }
}

export class WisprAuth {
  private cache?: Stored;
  private queue: Promise<unknown> = Promise.resolve();
  private authUrl?: URL;

  constructor(
    private readonly secrets: SecretStore,
    /** e.g. http://127.0.0.1:4318/oauth/wispr/callback */
    readonly redirect: string,
  ) {}

  /** Throws if the Keychain can't be read. */
  async load(): Promise<Stored> {
    if (!this.cache) this.cache = JSON.parse((await this.secrets.get(WISPR_OAUTH_ACCOUNT)) || '{}') as Stored;
    return this.cache;
  }

  private patch(p: Partial<Stored>): Promise<void> {
    const run = this.queue.then(async () => {
      const next = { ...(await this.load()), ...p };
      for (const k of Object.keys(p) as (keyof Stored)[]) if (p[k] === undefined) delete next[k];
      await this.secrets.set(WISPR_OAUTH_ACCOUNT, JSON.stringify(next));
      this.cache = next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Connected means there are tokens; whether they still work, only a call can tell. */
  async status(): Promise<{ connected: boolean; account?: string }> {
    const s = await this.load();
    return { connected: !!s.tokens, account: s.account };
  }

  setAccount(account: string) {
    return this.patch({ account });
  }

  /** Disconnect: forget the client and tokens. Wispr Flow keeps nothing to revoke here. */
  async forget() {
    await this.queue;
    await this.secrets.set(WISPR_OAUTH_ACCOUNT, '{}');
    this.cache = {};
  }

  /** The SDK's view of this store. */
  provider(interactive: boolean): OAuthClientProvider {
    return {
      redirectUrl: this.redirect,
      clientMetadata: this.metadata(),
      state: async () => {
        if (!interactive) throw new SignInNeeded();
        const state = randomBytes(16).toString('base64url');
        await this.patch({ pending: { state } });
        return state;
      },
      // A registration made for another redirect (the port changed) is not reused.
      clientInformation: async () => {
        const s = await this.load();
        return s.redirect === this.redirect ? s.client : undefined;
      },
      saveClientInformation: (client) => this.patch({ client, redirect: this.redirect }),
      tokens: async () => (await this.load()).tokens,
      saveTokens: (tokens) => this.patch({ tokens, savedAt: new Date().toISOString() }),
      redirectToAuthorization: (url) => {
        if (!interactive) throw new SignInNeeded();
        this.authUrl = url;
      },
      saveCodeVerifier: async (verifier) => {
        if (!interactive) throw new SignInNeeded();
        const s = await this.load();
        await this.patch({ pending: { state: s.pending?.state ?? '', verifier } });
      },
      codeVerifier: async () => {
        const v = (await this.load()).pending?.verifier;
        if (!v) throw new Error('No sign-in in progress. Choose Connect again.');
        return v;
      },
      invalidateCredentials: async (scope) => {
        if (scope === 'all') return this.forget();
        if (scope === 'tokens') return this.patch({ tokens: undefined });
        if (scope === 'client') return this.patch({ client: undefined, redirect: undefined });
        if (scope === 'verifier') return this.patch({ pending: undefined });
      },
    };
  }

  private metadata(): OAuthClientMetadata {
    return {
      client_name: 'Work OS',
      redirect_uris: [this.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  /** Connect: the sign-in page to open, or nothing when the stored sign-in still works. */
  async begin(fetchFn: FetchLike): Promise<{ url?: string }> {
    this.authUrl = undefined;
    const r = await auth(this.provider(true), { serverUrl: WISPR_MCP_URL, fetchFn });
    if (r === 'AUTHORIZED') return {};
    const url = this.authUrl as URL | undefined; // set by redirectToAuthorization during auth()
    if (!url) throw new Error('Wispr Flow did not return a sign-in page.');
    return { url: url.href };
  }

  /** The browser came back: check the state, then swap the code for tokens. */
  async finish(code: string, state: string, fetchFn: FetchLike): Promise<void> {
    const pending = (await this.load()).pending;
    if (!pending?.state || pending.state !== state) throw new Error('This sign-in link is stale or was not started here. Choose Connect again.');
    await auth(this.provider(true), { serverUrl: WISPR_MCP_URL, authorizationCode: code, fetchFn });
    await this.patch({ pending: undefined });
  }
}
