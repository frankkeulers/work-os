import type { DepState } from '@work-os/shared';

// Turns a failed call into what it means for the dependency (PLAN.md robustness §4). Network-level
// failures are ambiguous until a probe says whether the machine is offline or only that service is
// struggling, so they are marked `needsProbe`.

export interface Failure {
  state: Exclude<DepState, 'ok' | 'unknown' | 'paused'>;
  reason: string;
  retryAfterMs?: number;
  needsProbe?: boolean; // offline or degraded: the probe decides
}

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'EPIPE',
  'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

// Certificate errors on a public API usually mean a captive portal is intercepting the request.
const TLS_CODES = /^(CERT_|ERR_TLS_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT)/;

const SLACK_AUTH = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive', 'no_permission', 'missing_scope']);

/** The error code, looking through `cause` (undici wraps socket errors in a TypeError). */
export function errorCode(err: unknown): string | undefined {
  for (let e = err as { code?: unknown; cause?: unknown; name?: unknown } | undefined, depth = 0; e && depth < 5; e = e.cause as typeof e, depth++) {
    if (typeof e.code === 'string') return e.code;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return e.name;
  }
  return undefined;
}

export function classifyError(err: unknown): Failure {
  const code = errorCode(err);
  if (code && TLS_CODES.test(code)) return { state: 'offline', reason: 'captive_portal' };
  if (code === 'TimeoutError') return { state: 'degraded', reason: 'timeout', needsProbe: true };
  if (code === 'AbortError') return { state: 'degraded', reason: 'aborted', needsProbe: true };
  if (code && NETWORK_CODES.has(code)) return { state: 'degraded', reason: code.toLowerCase(), needsProbe: true };
  return { state: 'degraded', reason: 'error' };
}

/** Reads Retry-After as seconds or an HTTP date. */
export function retryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export function classifyResponse(res: { status: number; headers: { get(name: string): string | null } }, expectJson = true): Failure | undefined {
  const type = res.headers.get('content-type') ?? '';
  if (res.status === 429) return { state: 'rate_limited', reason: 'http_429', retryAfterMs: retryAfterMs(res.headers.get('retry-after')) };
  if (res.status === 401 || res.status === 403) return { state: 'auth_failed', reason: `http_${res.status}` };
  // A redirect or an HTML page where JSON was expected: something between us and the API.
  if (expectJson && ((res.status >= 300 && res.status < 400) || (res.status < 300 && /text\/html/i.test(type)))) return { state: 'offline', reason: 'captive_portal' };
  if (res.status >= 500) return { state: 'degraded', reason: `http_${res.status}` };
  if (res.status >= 400) return { state: 'degraded', reason: `http_${res.status}` };
  return undefined;
}

/** Slack answers 200 with { ok: false, error } for most failures. */
export function classifySlackError(error: string, retryAfterHeader?: string | null): Failure {
  if (SLACK_AUTH.has(error)) return { state: 'auth_failed', reason: error };
  if (error === 'ratelimited') return { state: 'rate_limited', reason: error, retryAfterMs: retryAfterMs(retryAfterHeader) };
  return { state: 'degraded', reason: error };
}
