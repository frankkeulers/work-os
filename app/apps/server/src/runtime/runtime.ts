import { londonParts, type DepId, type HealthView, type PollReason, type PollStatus, type SlackStatus, type SourceId, type StartupCheck } from '@work-os/shared';
import type { SettingsState } from '../config/settingsState';
import type { Logger } from '../log';
import type { Failure } from '../net/classify';
import { Health, type HealthChange } from '../net/health';
import type { ProbeResult } from '../net/probe';
import { ClaudeError } from '../claude/errors';
import type { TriageRun } from '../pipeline/triage';
import { SourceError } from '../sources/errors';
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
//
// Triage runs after every poll and when the next waiting thread goes quiet, one run at a time,
// only while Claude may be called and its breaker lets it through (FR-5.1, CL-6, CL-10).

export const TICK_MS = 5000;
export const SETTLE_MS = 10_000;
export const PROBE_RETRY_MS = 5000;
export const PROBE_TRIES = 3;
export const POWER_NAP_MS = 45_000;
export const RECHECK_MS = 5 * 60_000;
export const BUDGET_RECHECK_MS = 15 * 60_000; // a spent budget frees up at midnight
export const TRIAGE_BUG_BACKOFF_MS = 5 * 60_000;
const ZONE_EVERY_TICKS = 12; // once a minute

export interface RuntimeDeps {
  clock: Clock;
  store: Store;
  settings: SettingsState;
  logger?: Logger;
  sources: () => SourceAdapter[];
  /** The poll pipeline for one source. A SourceError says what failed; health and the log hear of it here. */
  poll: (s: SourceAdapter, reason: PollReason, signal: AbortSignal) => Promise<unknown>;
  /** Work due by the wall clock, run on every tick (snooze returns). */
  due?: (now: Date) => Promise<unknown>;
  /** Work that runs on every tick once running: drafts and the outbox (FR-9.x, FR-14.5). */
  onTick?: () => Promise<unknown>;
  /** After each triage run that finished; `catchUp` when it followed a wake or reconnect poll (FR-11.2). */
  onTriaged?: (catchUp: boolean) => Promise<unknown>;
  /** Every health change, after it is logged: health alerts. */
  onHealthChange?: (c: HealthChange) => void;
  /** Model triage of what is due, or of `only` those items. Throws ClaudeError for health. */
  triage?: (signal: AbortSignal, only?: string[]) => Promise<TriageRun>;
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
  private triaging?: Promise<TriageRun | undefined>;
  private triageWanted = true; // after a poll, a settings change, a failure the breaker now allows
  private polledSinceTriage = false;
  private catchUpSinceTriage = false; // a wake or reconnect poll since the last triage run
  private emptyRuns = { day: '', count: 0 }; // polls today whose triage found nothing eligible (usage view)
  private nextTriageAt?: number; // wall ms: when the next waiting thread goes quiet

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
      poll: (s, reason) => this.pollOne(s, reason),
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
    if (this.phase === 'running' || this.phase === 'catching_up') {
      this.maybeTriage();
      if (this.d.onTick) this.track(this.d.onTick().catch((err) => this.d.logger?.error({ err }, 'Tick work failed')));
    }
    if (this.d.due && this.phase !== 'stopping') this.track(this.d.due(this.d.clock.now()).catch((err) => this.d.logger?.error({ err }, 'Due work failed')));
    if (this.d.store.snapshotDue()) this.track(this.d.store.snapshot().catch((err) => this.d.logger?.error({ err }, 'Snapshot failed')));
  }

  /** Waits for the work the last ticks started. For tests. */
  async settled() {
    do {
      while (this.inFlight.size) await Promise.all(this.inFlight);
      await this.scheduler.idle(); // a poll that finishes may start triage
    } while (this.inFlight.size);
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

  /** Runs one poll and reports how it went to health (FR-2.9, FR-14.3). */
  private async pollOne(s: SourceAdapter, reason: PollReason) {
    const signal = this.sleepSignal;
    try {
      await this.d.poll(s, reason, signal);
      for (const dep of s.deps) if (this.health.state(dep) !== 'ok') this.health.ok(dep);
      // Triage what this poll made quiet or new, without waiting for the next tick (FR-5.1).
      this.triageWanted = true;
      this.polledSinceTriage = true;
      if (reason === 'wake' || reason === 'reconnect') this.catchUpSinceTriage = true;
      this.maybeTriage();
    } catch (err) {
      // Cut off by sleep: not a failure; the wake catch-up polls again.
      if (signal.aborted) return;
      if (err instanceof SourceError) {
        await this.reportFailure(err.dep, err.failure);
        // Being offline is not a source failure: the cursor stays and polling resumes on reconnect.
        if (this.health.state('network') === 'offline' || err.failure.state === 'offline') return;
        const retry = err.failure.retryAfterMs;
        await this.d.store.append({ type: 'source.failed', data: { source: s.id, error: err.failure.reason, ...(retry !== undefined && { retryAfterSeconds: Math.ceil(retry / 1000) }) } });
        return;
      }
      this.d.logger?.error({ err, source: s.id }, 'Poll failed');
      // A bug of ours, or a full disk: shown on the source so it doesn't go unnoticed.
      this.health.fail(s.deps.at(-1)!, { state: 'degraded', reason: 'internal' });
      await this.d.store.append({ type: 'source.failed', data: { source: s.id, error: 'internal' } }).catch(() => undefined);
    }
  }

  /** Frank's own ID in a source, once that source knows it. */
  identity(id: SourceId): string | undefined {
    return this.d
      .sources()
      .find((s) => s.id === id)
      ?.identity?.()?.id;
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
    this.triageWanted = true; // the quiet window or the budget may have changed
  }

  /** Whether the model may be asked now: awake long enough, online, and the breaker allows it. */
  claudeReady(): boolean {
    return this.canUseClaude() && this.health.state('network') !== 'offline' && this.health.ready('claude');
  }

  private maybeTriage() {
    if (!this.d.triage || this.triaging || !this.claudeReady()) return;
    const due = this.triageWanted || (this.nextTriageAt !== undefined && this.d.clock.now().getTime() >= this.nextTriageAt);
    // ready(), not allowed(): a run with nothing to send would hold the half-open trial for good.
    // Runs are one at a time, so a half-open breaker still gets exactly one trial call.
    if (!due) return;
    this.triageWanted = false;
    const afterPoll = this.polledSinceTriage;
    const catchUp = this.catchUpSinceTriage;
    this.polledSinceTriage = false;
    this.catchUpSinceTriage = false;
    const run = this.triageOnce(undefined, afterPoll).then(async (r) => {
      if (!r)
        this.catchUpSinceTriage ||= catchUp; // didn't finish: the next run still follows the catch-up
      else await this.afterTriage(catchUp);
      return r;
    });
    this.track((this.triaging = run.finally(() => (this.triaging = undefined))));
  }

  /** One triage run, reported to health. Resolves undefined when it didn't finish. */
  private async triageOnce(only?: string[], afterPoll = false): Promise<TriageRun | undefined> {
    const signal = this.sleepSignal;
    const now = () => this.d.clock.now().getTime();
    try {
      const r = await this.d.triage!(signal, only);
      if (r.calls > 0 && this.health.state('claude') !== 'ok') this.health.ok('claude');
      if (!only) this.nextTriageAt = r.paused ? now() + BUDGET_RECHECK_MS : r.nextReadyAt?.getTime();
      if (afterPoll && !r.calls && !r.paused && !r.failed) this.countEmptyRun();
      return r;
    } catch (err) {
      if (signal.aborted) {
        this.triageWanted = true; // cut off by sleep: again once awake
        return undefined;
      }
      if (err instanceof ClaudeError) {
        await this.reportFailure('claude', err.failure);
        this.triageWanted = true; // runs again when the breaker lets it
        if (only) throw err;
        return undefined;
      }
      this.d.logger?.error({ err }, 'Triage failed');
      this.health.fail('claude', { state: 'degraded', reason: 'internal' });
      this.nextTriageAt = now() + TRIAGE_BUG_BACKOFF_MS;
      if (only) throw err;
      return undefined;
    }
  }

  private async afterTriage(catchUp: boolean) {
    await this.d.onTriaged?.(catchUp).catch((err) => this.d.logger?.error({ err }, 'After-triage work failed'));
  }

  private countEmptyRun() {
    const day = londonParts(this.d.clock.now()).dateKey;
    this.emptyRuns = { day, count: (this.emptyRuns.day === day ? this.emptyRuns.count : 0) + 1 };
  }

  /** Polls today after which triage found nothing eligible, so made no call. Since the last start. */
  emptyTriageRunsToday(): number {
    return this.emptyRuns.day === londonParts(this.d.clock.now()).dateKey ? this.emptyRuns.count : 0;
  }

  /**
   * "Try again" on one item: triage it now, whatever its quiet window. Waits for a run in
   * progress first. Says why it couldn't when it can't.
   */
  async retryTriage(id: string): Promise<{ ok: true } | { ok: false; reason: 'unavailable' | 'budget'; message: string }> {
    if (!this.d.triage) return { ok: false, reason: 'unavailable', message: 'Triage is not running.' };
    if (!this.claudeReady()) return { ok: false, reason: 'unavailable', message: this.health.get('claude').fix ?? 'Claude can’t be called right now. Triage resumes on its own.' };
    await this.triaging;
    const run = this.triageOnce([id]);
    this.track(run);
    try {
      const r = await run;
      if (r) await this.afterTriage(false);
      if (r?.paused) return { ok: false, reason: 'budget', message: 'Triage budget reached for today. Rules still run; model triage resumes tomorrow.' };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: 'unavailable', message: err instanceof ClaudeError ? err.message : 'Triage failed.' };
    }
  }

  /** Who Frank is in a source, once it knows: ID and handle. */
  whoAmI(id: SourceId): { id: string; name?: string } | undefined {
    return this.d
      .sources()
      .find((s) => s.id === id)
      ?.identity?.();
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
      phase: cur ? 'polling' : this.triaging ? 'triaging' : 'idle',
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
    this.d.onHealthChange?.(c);
  }

  private track<T>(p: Promise<T>) {
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
  }
}
