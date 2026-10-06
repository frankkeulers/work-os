import type { DepId, HealthView, PollReason, PollStatus, SlackStatus, SourceId, StartupCheck } from '@work-os/shared';
import type { SettingsState } from '../config/settingsState';
import type { Logger } from '../log';
import type { Failure } from '../net/classify';
import { Health, type HealthChange } from '../net/health';
import type { ProbeResult } from '../net/probe';
import type { SourceAdapter } from '../sources/types';
import type { Store } from '../store/store';
import { PowerMonitor, type Clock, type PowerEvent } from './power';
import { Scheduler } from './scheduler';

// The runtime (PLAN.md robustness §3, §4, §6): one tick every 5 s drives everything that depends
// on time, so nothing relies on a long timer that sleep would freeze.
//
// On wake: abort every in-flight call, wait 10 s for the network, probe up to 3 times, then catch
// up the overdue sources. If the network is still down, local sources catch up at once and the
// others when it returns.
// Claude calls and approved writes wait until the Mac has been awake for 45 s, so a Power Nap's
// brief wake only fetches.

export const TICK_MS = 5000;
export const SETTLE_MS = 10_000;
export const PROBE_RETRY_MS = 5000;
export const PROBE_TRIES = 3;
export const POWER_NAP_MS = 45_000;
export const RECHECK_MS = 5 * 60_000;
const ZONE_EVERY_TICKS = 12; // once a minute

export interface RuntimeDeps {
  clock: Clock;
  store: Store;
  settings: SettingsState;
  logger?: Logger;
  sources: () => SourceAdapter[];
  /** The poll pipeline for one source (M1 step 10). */
  poll: (s: SourceAdapter, reason: PollReason, signal: AbortSignal) => Promise<void>;
  probe: (signal: AbortSignal) => Promise<ProbeResult>;
  checks: () => Promise<StartupCheck[]>;
  wakeTime?: () => string | undefined;
  followZone?: () => string | undefined;
  safeMode?: boolean;
  clearSafeMode?: () => Promise<void>;
  tokenPersisted?: boolean;
  /** Backoff jitter; fixed in tests. */
  random?: () => number;
}

export class Runtime {
  readonly health: Health;
  readonly scheduler: Scheduler;
  phase: HealthView['phase'] = 'running';
  lastWakeAt?: string;
  checks: StartupCheck[] = [];
  checkedAt?: string;
  safeMode: boolean;

  private power: PowerMonitor;
  private epoch = new AbortController();
  private sleptMs = 0; // total time asleep since start: the monotonic clock stops during sleep
  private wokeAtMono?: number;
  private settleUntilMono = 0;
  private probeTries = 0;
  private owesCatchUp = false; // a wake or reconnect catch-up waits for the network
  private nextCheckMono = 0;
  private ticks = 0;
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = new Set<Promise<unknown>>();
  private probing?: Promise<void>;
  private checking?: Promise<void>;

  constructor(private readonly d: RuntimeDeps) {
    this.safeMode = !!d.safeMode;
    this.health = new Health(
      () => d.clock.now(),
      (c) => this.onHealthChange(c),
      d.random,
    );
    this.power = new PowerMonitor(d.clock, d.wakeTime);
    this.scheduler = new Scheduler({
      // Sleep counts towards poll intervals; clock changes don't.
      clock: { now: () => d.clock.now(), mono: () => d.clock.mono() + this.sleptMs },
      sources: () => (this.safeMode ? [] : d.sources()),
      settings: () => d.settings.settings,
      lastPollAt: (id) => d.store.projection.sources[id]?.lastPollAt,
      canPoll: (s) => this.canPoll(s),
      poll: (s, reason) => d.poll(s, reason, this.sleepSignal),
      onError: (id, err) => d.logger?.error({ err, source: id }, 'Poll failed'),
    });
    if (d.tokenPersisted === false) this.health.set('keychain', 'degraded', 'unreadable');
  }

  /** Aborts when the Mac sleeps. Every network call passes it on (CL-10). */
  get sleepSignal(): AbortSignal {
    return this.epoch.signal;
  }

  start() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  async stop() {
    clearInterval(this.timer);
    this.phase = 'stopping';
    this.epoch.abort(new Error('stopping'));
    // Lets started work (a check, a probe, a health event) finish before the store closes.
    await Promise.allSettled([...this.inFlight, this.scheduler.idle()]);
  }

  /** One tick. Exposed for tests, which drive a fake clock. */
  async tick() {
    this.ticks += 1;
    const event = this.power.check();
    if (event) this.onPower(event);
    if (this.ticks % ZONE_EVERY_TICKS === 0) {
      const zone = this.d.followZone?.();
      if (zone) this.d.logger?.info({ zone }, 'Time zone changed');
    }
    const mono = this.d.clock.mono();
    if (this.phase === 'waking' && mono >= this.settleUntilMono) this.track((this.probing ??= this.afterSettle().finally(() => (this.probing = undefined))));
    else if (this.phase === 'running' && this.health.state('network') === 'offline' && this.health.allowed('network')) {
      this.track((this.probing ??= this.reprobe().finally(() => (this.probing = undefined))));
    }
    if (mono >= this.nextCheckMono) this.track(this.runChecks());
    if (this.phase === 'running') this.scheduler.tick();
    if (this.d.store.snapshotDue()) this.track(this.d.store.snapshot().catch((err) => this.d.logger?.error({ err }, 'Snapshot failed')));
  }

  /** Waits for the work the last ticks started. For tests. */
  async settled() {
    while (this.inFlight.size) await Promise.all(this.inFlight);
    await this.scheduler.idle();
  }

  /** Whether Claude may be called now: not within 45 s of a wake (CL-10). */
  canUseClaude(): boolean {
    if (this.safeMode || this.phase === 'waking' || this.phase === 'stopping') return false;
    return this.wokeAtMono === undefined || this.d.clock.mono() - this.wokeAtMono >= POWER_NAP_MS;
  }

  canPoll(s: SourceAdapter): boolean {
    if (this.safeMode || this.phase === 'waking' || this.phase === 'stopping') return false;
    if (s.needsNetwork && this.health.state('network') === 'offline') return false;
    // Only looks: the poll itself reports back, which closes or reopens each breaker.
    return s.deps.every((dep) => this.health.ready(dep));
  }

  /**
   * After a failed call: a network-level error is ambiguous, so probe. Offline is the machine's
   * problem, not the service's, and the work it held up runs again when the network returns.
   */
  async reportFailure(dep: DepId, f: Failure) {
    if (!f.needsProbe) return this.health.fail(dep, f);
    const r = await this.d.probe(this.sleepSignal);
    if (r.ok) {
      this.health.ok('network');
      this.health.fail(dep, { ...f, needsProbe: false });
    } else {
      this.health.fail('network', r.failure);
      this.health.fail(dep, { state: 'offline', reason: r.failure.reason });
      this.owesCatchUp = true;
    }
  }

  /** "Poll now" (FR-2.6). */
  pollNow(ids?: SourceId[]) {
    this.scheduler.request('manual', ids);
  }

  /** "Check again" (FR-12.2): rerun the checks, let every breaker try once, leave safe mode. */
  async recheck() {
    this.health.resetAll();
    if (this.safeMode) {
      await this.d.clearSafeMode?.();
      this.safeMode = false;
      this.d.logger?.info('Left safe mode');
    }
    this.nextCheckMono = 0;
    await this.runChecks();
    if (this.health.state('network') === 'offline') await this.reprobe();
    this.scheduler.tick();
  }

  /** Settings were saved: check them again on the next tick. */
  settingsChanged() {
    this.nextCheckMono = 0;
  }

  mode(): HealthView['mode'] {
    if (this.safeMode) return 'safe';
    const failing = this.d.settings.status !== 'ok' || this.health.problems().length > 0 || this.checks.some((c) => c.status === 'fail');
    return failing ? 'degraded' : 'normal';
  }

  /** The runtime's part of HealthView. */
  view(): Pick<HealthView, 'mode' | 'phase' | 'lastWakeAt' | 'deps' | 'checks' | 'checkedAt' | 'nextCheckAt'> {
    const now = this.d.clock.now().getTime();
    const untilCheck = Math.max(0, this.nextCheckMono - this.d.clock.mono());
    return {
      mode: this.mode(),
      phase: this.phase,
      lastWakeAt: this.lastWakeAt,
      deps: this.health.list(),
      checks: this.checks,
      checkedAt: this.checkedAt ?? new Date(now).toISOString(),
      nextCheckAt: new Date(now + untilCheck).toISOString(),
    };
  }

  pollStatus(id: SourceId = 'slack'): PollStatus {
    const cur = this.scheduler.current;
    return {
      phase: cur ? 'polling' : 'idle',
      reason: cur?.reason,
      lastPollAt: this.d.store.projection.sources[id]?.lastPollAt,
      nextPollAt: this.scheduler.nextPollAt(id),
    };
  }

  /** A source's status for the UI, from its dependency's health. */
  sourceStatus(id: SourceId, dep: DepId = id === 'wispr' ? 'wisprDb' : id === 'outlook' ? 'claude' : (id as DepId)): { status: SlackStatus; retryAt?: string; message?: string } {
    if (this.safeMode || !this.d.settings.settings) return { status: 'paused', message: this.safeMode ? 'Safe mode: polling is off after repeated crashes.' : 'Paused until the settings are fixed.' };
    if (this.health.state('network') === 'offline') return { status: 'offline', message: this.health.get('network').fix };
    const h = this.health.get(dep);
    const map: Partial<Record<string, SlackStatus>> = { rate_limited: 'backoff', auth_failed: 'auth_failed', offline: 'offline', degraded: 'degraded', paused: 'paused' };
    const status = map[h.state] ?? (this.d.store.projection.sources[id]?.lastPollAt ? 'healthy' : 'never');
    return { status, retryAt: h.retryAt, message: h.fix ?? (status === 'never' ? 'Not polled yet.' : undefined) };
  }

  private onPower(ev: PowerEvent) {
    const log = this.d.logger;
    if (ev.kind !== 'wake') {
      // Intervals run on the monotonic clock, so a clock change needs no catch-up and no burst.
      log?.info({ ...ev }, 'Clock changed');
      return;
    }
    this.sleptMs += ev.sleptMs;
    this.epoch.abort(new Error('sleep'));
    this.epoch = new AbortController();
    const mono = this.d.clock.mono();
    this.lastWakeAt = this.d.clock.now().toISOString();
    this.wokeAtMono = mono;
    this.settleUntilMono = mono + SETTLE_MS;
    this.nextCheckMono = mono + SETTLE_MS;
    this.probeTries = 0;
    this.phase = 'waking';
    log?.info({ sleptSeconds: Math.round(ev.sleptMs / 1000) }, 'Woke from sleep');
    this.track(this.d.store.append({ type: 'system.woke', data: { sleptSeconds: Math.round(ev.sleptMs / 1000) } }).catch((err) => log?.error({ err }, 'Could not log the wake')));
  }

  private async afterSettle() {
    const r = await this.d.probe(this.sleepSignal);
    if (r.ok) {
      this.health.ok('network');
      this.phase = 'catching_up';
      this.scheduler.catchUp('wake');
      await this.scheduler.idle();
      if (this.phase === 'catching_up') this.phase = 'running';
      return;
    }
    // Each failed probe counts, so the breaker is open by the time the wake probes give up.
    this.health.fail('network', r.failure);
    this.probeTries += 1;
    if (this.probeTries < PROBE_TRIES) {
      this.settleUntilMono = this.d.clock.mono() + PROBE_RETRY_MS;
      return;
    }
    // Still offline: local sources catch up now, the rest when the network returns.
    this.owesCatchUp = true;
    this.phase = 'running';
    this.scheduler.catchUp('wake');
  }

  private async reprobe() {
    const r = await this.d.probe(this.sleepSignal);
    if (!r.ok) return this.health.fail('network', r.failure);
    this.health.ok('network');
    if (this.owesCatchUp) {
      this.owesCatchUp = false;
      this.scheduler.catchUp('reconnect');
    }
  }

  private runChecks(): Promise<void> {
    this.nextCheckMono = this.d.clock.mono() + RECHECK_MS;
    return (this.checking ??= (async () => {
      try {
        this.checks = await this.d.checks();
        this.checkedAt = this.d.clock.now().toISOString();
        const kc = this.checks.find((c) => c.id === 'keychain');
        if (kc?.status === 'ok' && this.d.tokenPersisted !== false) this.health.ok('keychain');
        else if (kc?.status === 'fail') this.health.set('keychain', 'degraded', 'unreadable');
      } catch (err) {
        this.d.logger?.error({ err }, 'Startup checks failed to run');
      } finally {
        this.checking = undefined;
      }
    })());
  }

  private onHealthChange(c: HealthChange) {
    this.d.logger?.info({ ...c }, 'Health changed');
    this.track(this.d.store.append({ type: 'health.changed', data: { dep: c.dep, state: c.state, ...(c.reason && { reason: c.reason }) } }).catch(() => undefined));
  }

  private track<T>(p: Promise<T>) {
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }
}
