import { describe, expect, it } from 'vitest';
import { Breaker, DEFAULT_POLICY, nextBackoff } from './breaker';
import { classifyError, classifyResponse, classifySlackError, errorCode, retryAfterMs, type Failure } from './classify';
import { Health, type HealthChange } from './health';
import { deadline } from './http';
import { probeNetwork, type FetchFn } from './probe';

const res = (status: number, headers: Record<string, string> = {}) => ({ status, headers: new Headers(headers) });
const sysErr = (code: string) => Object.assign(new Error(code), { code });
const offline: Failure = { state: 'offline', reason: 'enotfound' };
const degraded: Failure = { state: 'degraded', reason: 'http_503' };

describe('classify', () => {
  it('finds the code inside undici’s wrapped errors', () => {
    const wrapped = new TypeError('fetch failed', { cause: sysErr('ECONNRESET') });
    expect(errorCode(wrapped)).toBe('ECONNRESET');
    expect(classifyError(wrapped)).toEqual({ state: 'degraded', reason: 'econnreset', needsProbe: true });
  });

  it.each([
    ['ENOTFOUND', 'enotfound'],
    ['EAI_AGAIN', 'eai_again'],
    ['ETIMEDOUT', 'etimedout'],
    ['UND_ERR_SOCKET', 'und_err_socket'],
  ])('%s needs a probe to tell offline from a struggling service', (code, reason) => {
    expect(classifyError(sysErr(code))).toEqual({ state: 'degraded', reason, needsProbe: true });
  });

  it('treats a certificate error as a captive portal', () => {
    expect(classifyError(new TypeError('fetch failed', { cause: sysErr('CERT_HAS_EXPIRED') }))).toEqual({ state: 'offline', reason: 'captive_portal' });
    expect(classifyError(sysErr('ERR_TLS_CERT_ALTNAME_INVALID')).reason).toBe('captive_portal');
  });

  it('treats a deadline as a timeout that needs a probe', () => {
    expect(classifyError(new DOMException('t', 'TimeoutError'))).toMatchObject({ reason: 'timeout', needsProbe: true });
    expect(classifyError(new Error('boom'))).toEqual({ state: 'degraded', reason: 'error' });
  });

  it('reads responses: 429, auth, HTML where JSON was expected, 5xx', () => {
    expect(classifyResponse(res(429, { 'retry-after': '30' }))).toEqual({ state: 'rate_limited', reason: 'http_429', retryAfterMs: 30_000 });
    expect(classifyResponse(res(401))?.state).toBe('auth_failed');
    expect(classifyResponse(res(403))?.state).toBe('auth_failed');
    expect(classifyResponse(res(200, { 'content-type': 'text/html; charset=utf-8' }))).toEqual({ state: 'offline', reason: 'captive_portal' });
    expect(classifyResponse(res(302, { location: 'http://portal.hotel' }))?.reason).toBe('captive_portal');
    expect(classifyResponse(res(302), false)).toBeUndefined();
    expect(classifyResponse(res(503))).toEqual({ state: 'degraded', reason: 'http_503' });
    expect(classifyResponse(res(200, { 'content-type': 'application/json' }))).toBeUndefined();
  });

  it('reads Retry-After as seconds or a date', () => {
    const now = Date.parse('2026-10-06T09:00:00Z');
    expect(retryAfterMs('12', now)).toBe(12_000);
    expect(retryAfterMs('Tue, 06 Oct 2026 09:01:00 GMT', now)).toBe(60_000);
    expect(retryAfterMs('soon', now)).toBeUndefined();
    expect(retryAfterMs(null, now)).toBeUndefined();
  });

  it('reads Slack’s ok:false errors', () => {
    expect(classifySlackError('invalid_auth')).toEqual({ state: 'auth_failed', reason: 'invalid_auth' });
    expect(classifySlackError('token_revoked').state).toBe('auth_failed');
    expect(classifySlackError('ratelimited', '7')).toEqual({ state: 'rate_limited', reason: 'ratelimited', retryAfterMs: 7000 });
    expect(classifySlackError('internal_error').state).toBe('degraded');
  });
});

describe('breaker', () => {
  it('keeps decorrelated jitter between the base and the cap', () => {
    expect(nextBackoff(0, 5000, 60_000, () => 0)).toBe(5000);
    expect(nextBackoff(10_000, 5000, 60_000, () => 1)).toBe(30_000);
    expect(nextBackoff(50_000, 5000, 60_000, () => 1)).toBe(60_000);
  });

  it('opens after 3 transient failures, then lets exactly one trial through', () => {
    const b = new Breaker(DEFAULT_POLICY, () => 0);
    b.failure(degraded, 0);
    b.failure(degraded, 0);
    expect(b.allowed(0)).toBe(true);
    b.failure(degraded, 0);
    expect(b.state).toBe('open');
    expect(b.allowed(4999)).toBe(false);
    expect(b.ready(5000)).toBe(true);
    expect(b.ready(5000)).toBe(true); // looking doesn't take the trial
    expect(b.allowed(5000)).toBe(true);
    expect(b.allowed(5000)).toBe(false); // half-open: one at a time
    expect(b.ready(5000)).toBe(false);
    b.success();
    expect(b.allowed(5000)).toBe(true);
  });

  it('grows the wait when the trial fails, up to the cap', () => {
    const b = new Breaker(DEFAULT_POLICY, () => 1);
    for (let i = 0; i < 3; i++) b.failure(degraded, 0);
    let last = b.retryAt;
    for (let i = 0; i < 10; i++) {
      expect(b.allowed(b.retryAt)).toBe(true);
      const at = b.retryAt;
      b.failure(degraded, at);
      expect(b.retryAt - at).toBeLessThanOrEqual(DEFAULT_POLICY.capMs);
      expect(b.retryAt - at).toBeGreaterThanOrEqual(Math.min(DEFAULT_POLICY.capMs, last));
      last = b.retryAt - at;
    }
    expect(last).toBe(DEFAULT_POLICY.capMs);
  });

  it('caps offline waits lower: only cheap probes run then', () => {
    const b = new Breaker(DEFAULT_POLICY, () => 1);
    for (let i = 0; i < 20; i++) b.failure(offline, 0);
    expect(b.retryAt).toBe(DEFAULT_POLICY.offlineCapMs);
  });

  it('waits exactly Retry-After plus 1–3 s on a 429, and 30 min on an auth failure', () => {
    const b = new Breaker(DEFAULT_POLICY, () => 0.5);
    b.failure({ state: 'rate_limited', reason: 'http_429', retryAfterMs: 30_000 }, 1000);
    expect(b.state).toBe('open');
    expect(b.retryAt).toBe(1000 + 30_000 + 2000);
    const a = new Breaker();
    a.failure({ state: 'auth_failed', reason: 'invalid_auth' }, 0);
    expect(a.allowed(29 * 60_000)).toBe(false);
    expect(a.allowed(30 * 60_000)).toBe(true);
  });

  it('lets the next call through at once after reset ("Check again")', () => {
    const b = new Breaker();
    b.failure({ state: 'auth_failed', reason: 'invalid_auth' }, 0);
    b.reset();
    expect(b.allowed(1)).toBe(true);
    expect(b.allowed(1)).toBe(false);
  });
});

describe('health', () => {
  it('reports changes of state or reason once, with the fix to show', () => {
    let t = Date.parse('2026-10-06T09:00:00Z');
    const changes: HealthChange[] = [];
    const h = new Health(
      () => new Date(t),
      (c) => changes.push(c),
      () => 0,
    );
    expect(h.state('slack')).toBe('unknown');
    h.fail('slack', degraded);
    h.fail('slack', degraded);
    expect(changes).toEqual([{ dep: 'slack', state: 'degraded', reason: 'http_503' }]);
    h.fail('network', { state: 'offline', reason: 'captive_portal' });
    expect(h.get('network').fix).toMatch(/portal/);
    t += 1000;
    h.ok('slack');
    expect(h.get('slack')).toMatchObject({ state: 'ok', failures: 0, lastOkAt: new Date(t).toISOString() });
    expect(h.problems().map((p) => p.id)).toEqual(['network']);
    expect(changes.at(-1)).toEqual({ dep: 'slack', state: 'ok', reason: undefined });
  });

  it('keeps one breaker per dependency: Slack failing never blocks Wispr Flow', () => {
    const h = new Health(
      () => new Date(0),
      undefined,
      () => 0,
    );
    h.fail('slack', { state: 'auth_failed', reason: 'invalid_auth' });
    expect(h.allowed('slack')).toBe(false);
    expect(h.allowed('wisprDb')).toBe(true);
    expect(h.get('slack').retryAt).toBe(new Date(30 * 60_000).toISOString());
    h.resetAll();
    expect(h.allowed('slack')).toBe(true);
  });
});

describe('probe', () => {
  const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fake =
    (by: Record<string, () => Response | Promise<Response>>): FetchFn =>
    async (url) => {
      for (const [k, fn] of Object.entries(by)) if (url.includes(k)) return fn();
      throw new Error(`unexpected ${url}`);
    };

  it('is online if either target answers', async () => {
    expect(await probeNetwork(fake({ slack: () => ok({ ok: true }), anthropic: () => Promise.reject(sysErr('ENOTFOUND')) }))).toEqual({ ok: true });
    expect(await probeNetwork(fake({ slack: () => Promise.reject(sysErr('ENOTFOUND')), anthropic: () => new Response(null, { status: 404 }) }))).toEqual({ ok: true });
  });

  it('is offline when nothing answers', async () => {
    const down = () => Promise.reject(new TypeError('fetch failed', { cause: sysErr('ENOTFOUND') }));
    expect(await probeNetwork(fake({ slack: down, anthropic: down }))).toEqual({ ok: false, failure: { state: 'offline', reason: 'enotfound' } });
  });

  it('spots a captive portal: HTML instead of JSON, or a redirect', async () => {
    const portal = () => new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const redirect = () => new Response(null, { status: 302, headers: { location: 'http://portal' } });
    expect(await probeNetwork(fake({ slack: portal, anthropic: redirect }))).toEqual({ ok: false, failure: { state: 'offline', reason: 'captive_portal' } });
  });

  it('carries no credentials and never follows redirects', async () => {
    const seen: RequestInit[] = [];
    await probeNetwork(async (_url, init) => {
      seen.push(init ?? {});
      return ok({ ok: true });
    });
    for (const init of seen) {
      expect(init.redirect).toBe('manual');
      expect(init.headers).toBeUndefined();
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it('gives up when the sleep signal aborts', async () => {
    const sleep = new AbortController();
    const hang: FetchFn = (_u, init) => new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)));
    const p = probeNetwork(hang, sleep.signal);
    sleep.abort(new DOMException('sleep', 'AbortError'));
    expect(await p).toMatchObject({ ok: false, failure: { state: 'offline' } });
  });

  it('combines a deadline with other signals', () => {
    const a = new AbortController();
    const s = deadline(60_000, a.signal, undefined);
    expect(s.aborted).toBe(false);
    a.abort();
    expect(s.aborted).toBe(true);
  });
});

describe('fix texts', () => {
  it('says a missing Slack token is missing, not rejected', () => {
    const h = new Health(() => new Date('2026-10-06T08:00:00Z'));
    h.fail('slack', { state: 'auth_failed', reason: 'token_missing' });
    expect(h.get('slack').fix).toMatch(/^No Slack token in the Keychain yet/);
    h.fail('slack', { state: 'auth_failed', reason: 'invalid_auth' });
    expect(h.get('slack').fix).toMatch(/^Slack rejected the token/);
  });

  it('only blames changed tools when Wispr Flow’s tools changed (R2.7)', () => {
    const h = new Health(() => new Date('2026-10-06T08:00:00Z'));
    h.fail('wisprMcp', { state: 'degraded', reason: 'timeout' });
    expect(h.get('wisprMcp').fix).toMatch(/^Wispr Flow is not answering properly/);
    h.fail('wisprMcp', { state: 'degraded', reason: 'tools_changed' });
    expect(h.get('wisprMcp').fix).toMatch(/^Wispr Flow changed its MCP tools/);
  });
});
