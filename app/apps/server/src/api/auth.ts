import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Instance } from '../config/env';
import type { SecretStore } from '../config/keychain';
import type { Logger } from '../log';
import { sendError } from './errors';

// FR-3.3: the API answers only to the app itself. Three checks on every request:
// - Host must be 127.0.0.1 or localhost, so a DNS-rebinding page can't reach the server.
// - A request with a foreign Origin is refused, so another site can't send commands.
// - /api/* needs the per-install bearer token, which only the served page carries.

export const tokenAccount = (instance: Instance) => `api-token-${instance}`;

/**
 * The bearer token, kept in the Keychain so open tabs survive a restart. If the Keychain can't
 * be read, the server still starts with a token for this run only, and says so.
 */
export async function loadApiToken(secrets: SecretStore, instance: Instance, logger?: Logger): Promise<{ token: string; persisted: boolean }> {
  const account = tokenAccount(instance);
  try {
    const existing = await secrets.get(account);
    if (existing && existing.length >= 32) return { token: existing, persisted: true };
    const token = randomBytes(32).toString('base64url');
    await secrets.set(account, token);
    return { token, persisted: true };
  } catch (err) {
    logger?.warn({ err }, 'Keychain unavailable: using a token for this run only; open tabs will need a reload after a restart');
    return { token: randomBytes(32).toString('base64url'), persisted: false };
  }
}

export function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

export function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, '');
  return LOCAL_HOSTS.has(name);
}

export interface GuardOptions {
  token: string;
  /** Origins the UI is served from: the server's own, plus Vite's in development. */
  origins: () => Set<string>;
}

export function requestGuard(opts: GuardOptions) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!hostAllowed(req.headers.host)) return sendError(reply, 'forbidden', 'Requests must use 127.0.0.1 or localhost.');
    const origin = req.headers.origin;
    if (origin !== undefined && !opts.origins().has(origin)) return sendError(reply, 'forbidden', 'Cross-origin requests are not allowed.');
    if (req.url.startsWith('/api/') && !bearerMatches(req.headers.authorization, opts.token)) {
      return sendError(reply, 'unauthorized', 'Missing or wrong API token. Reload the page.');
    }
  };
}

/** The origins a page served by this server (or by Vite in development) sends. */
export function localOrigins(port: number, extra: string[] = []): Set<string> {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...extra]);
}
