import type { DepId, DepState, DependencyHealth } from '@work-os/shared';
import { Breaker, CLAUDE_POLICY, DEFAULT_POLICY } from './breaker';
import type { Failure } from './classify';

// Health per dependency (FR-14.3, FR-14.6): its state, since when, and what Frank can do about it.
// Each dependency has its own breaker, so Slack being offline never holds up a source that needs
// no network. A change of state (not every failure) is reported once, for the event log.

const FIXES: Partial<Record<DepId, Partial<Record<DepState | 'captive_portal' | 'token_missing', string>>>> = {
  network: { offline: 'Waiting for the network. Work that needs it resumes on its own.', captive_portal: 'Sign in to the Wi-Fi portal in a browser.' },
  slack: {
    token_missing: 'No Slack token in the Keychain yet. Store it (account slack-user-token), then choose Check again.',
    auth_failed: 'Slack rejected the token. Re-install the Slack app and update the Keychain entry.',
    rate_limited: 'Slack asked us to wait. Polling resumes after Retry-After.',
  },
  claude: { auth_failed: 'Run `claude login` in Terminal, then Check again.', rate_limited: 'The Claude usage limit was reached. Triage resumes when it resets.' },
  confluence: { auth_failed: 'Confluence rejected the token. Update it in the Keychain.' },
  keychain: { degraded: 'Unlock the login Keychain, then Check again.', auth_failed: 'Unlock the login Keychain, then Check again.' },
  storage: { degraded: 'The data disk is full or read-only. Free some space; commands are refused until then.' },
  wisprDb: { degraded: 'Wispr Flow changed its database. Work OS stopped reading it until the reader is updated.' },
};

export type HealthChange = { dep: DepId; state: DepState; reason?: string };

export class Health {
  private deps = new Map<DepId, { h: DependencyHealth; breaker: Breaker }>();

  constructor(
    private readonly now: () => Date,
    private readonly onChange: (c: HealthChange) => void = () => undefined,
    private readonly random: () => number = Math.random,
  ) {}

  private entry(dep: DepId) {
    let e = this.deps.get(dep);
    if (!e) {
      e = { h: { id: dep, state: 'unknown', since: this.now().toISOString(), failures: 0 }, breaker: new Breaker(dep === 'claude' ? CLAUDE_POLICY : DEFAULT_POLICY, this.random) };
      this.deps.set(dep, e);
    }
    return e;
  }

  get(dep: DepId): DependencyHealth {
    return { ...this.entry(dep).h };
  }

  state(dep: DepId): DepState {
    return this.entry(dep).h.state;
  }

  /** Whether a call to `dep` may go now (FR-14.3). */
  allowed(dep: DepId): boolean {
    return this.entry(dep).breaker.allowed(this.now().getTime());
  }

  /** Like allowed(), but only looks: for deciding whether to start work that checks several. */
  ready(dep: DepId): boolean {
    return this.entry(dep).breaker.ready(this.now().getTime());
  }

  ok(dep: DepId) {
    const e = this.entry(dep);
    e.breaker.success();
    const at = this.now().toISOString();
    e.h.lastOkAt = at;
    e.h.failures = 0;
    e.h.retryAt = undefined;
    this.transition(e.h, 'ok', undefined, at);
  }

  fail(dep: DepId, f: Failure) {
    const e = this.entry(dep);
    const now = this.now();
    e.breaker.failure(f, now.getTime());
    e.h.failures += 1;
    e.h.retryAt = e.breaker.state === 'open' ? new Date(e.breaker.retryAt).toISOString() : undefined;
    this.transition(e.h, f.state, f.reason, now.toISOString());
  }

  /** A state set from outside: paused by settings or safe mode, or unknown until first checked. */
  set(dep: DepId, state: DepState, reason?: string) {
    this.transition(this.entry(dep).h, state, reason, this.now().toISOString());
  }

  /** "Check again": lets the next call to every dependency through now (FR-12.2). */
  resetAll() {
    for (const e of this.deps.values()) e.breaker.reset();
  }

  list(): DependencyHealth[] {
    return [...this.deps.values()].map((e) => ({ ...e.h }));
  }

  /** Dependencies that are not working, for degraded mode. */
  problems(): DependencyHealth[] {
    return this.list().filter((h) => h.state !== 'ok' && h.state !== 'unknown');
  }

  private transition(h: DependencyHealth, state: DepState, reason: string | undefined, at: string) {
    const changed = h.state !== state || h.reason !== reason;
    if (h.state !== state) h.since = at;
    h.state = state;
    h.reason = reason;
    const fixes = FIXES[h.id];
    h.fix = (reason === 'captive_portal' || reason === 'token_missing' ? fixes?.[reason] : undefined) ?? fixes?.[state];
    if (changed) this.onChange({ dep: h.id, state, reason });
  }
}
