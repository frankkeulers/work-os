import type { Failure } from './classify';

// One circuit breaker per dependency (PLAN.md robustness §4, FR-14.3). Work never retries on its
// own: it asks allowed() and waits. The breaker opens after 3 transient failures in a row, or at
// once on an auth failure or a 429; while open, the dependency rests until retryAt; then one
// attempt goes through (half-open), and its result closes or reopens the breaker.

export type BreakerState = 'closed' | 'open' | 'half_open';

/** Decorrelated jitter: each wait is random between the base and three times the last, capped. */
export function nextBackoff(prevMs: number, baseMs: number, capMs: number, random = Math.random): number {
  const hi = Math.max(baseMs, prevMs * 3);
  return Math.min(capMs, baseMs + random() * (hi - baseMs));
}

export interface BreakerPolicy {
  baseMs: number;
  /** The longest wait for a transient failure. Offline waits are short because only probes run then. */
  capMs: number;
  offlineCapMs: number;
  authRecheckMs: number;
  failuresToOpen: number;
}

export const DEFAULT_POLICY: BreakerPolicy = { baseMs: 5000, capMs: 10 * 60_000, offlineCapMs: 5 * 60_000, authRecheckMs: 30 * 60_000, failuresToOpen: 3 };
export const CLAUDE_POLICY: BreakerPolicy = { ...DEFAULT_POLICY, capMs: 15 * 60_000 };

export class Breaker {
  state: BreakerState = 'closed';
  failures = 0;
  retryAt = 0; // epoch ms
  private waitMs = 0;
  private trialOut = false;

  constructor(
    private readonly policy: BreakerPolicy = DEFAULT_POLICY,
    private readonly random: () => number = Math.random,
  ) {}

  /** Whether a call may go now. In half-open state, only one call goes until it reports back. */
  allowed(nowMs: number): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open' && nowMs >= this.retryAt) {
      this.state = 'half_open';
      this.trialOut = false;
    }
    if (this.state === 'half_open' && !this.trialOut) {
      this.trialOut = true;
      return true;
    }
    return false;
  }

  /** Whether allowed() would say yes, without taking the half-open trial. */
  ready(nowMs: number): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') return nowMs >= this.retryAt;
    return !this.trialOut;
  }

  success() {
    this.state = 'closed';
    this.failures = 0;
    this.waitMs = 0;
    this.retryAt = 0;
    this.trialOut = false;
  }

  failure(f: Failure, nowMs: number) {
    this.failures += 1;
    this.trialOut = false;
    const p = this.policy;
    if (f.state === 'rate_limited') {
      // Exactly what the server asked for, plus 1–3 s so a burst of clients doesn't return at once.
      this.open(nowMs, (f.retryAfterMs ?? p.baseMs * 6) + 1000 + this.random() * 2000);
    } else if (f.state === 'auth_failed') {
      this.open(nowMs, p.authRecheckMs);
    } else if (this.state === 'half_open' || this.failures >= p.failuresToOpen) {
      this.waitMs = nextBackoff(this.waitMs, p.baseMs, f.state === 'offline' ? p.offlineCapMs : p.capMs, this.random);
      this.open(nowMs, this.waitMs);
    }
  }

  /** Lets the next call through now, e.g. after a successful probe or a manual "Check again". */
  reset() {
    if (this.state !== 'closed') {
      this.state = 'open';
      this.retryAt = 0;
    }
  }

  private open(nowMs: number, waitMs: number) {
    this.state = 'open';
    this.retryAt = nowMs + waitMs;
  }
}
