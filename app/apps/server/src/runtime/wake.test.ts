import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PollReason, SourceId, StartupCheck } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDataDir } from '../config/dataDir';
import { DEFAULT_RULES, defaultSettings } from '../config/defaults';
import { loadSettings } from '../config/settings';
import { SettingsState } from '../config/settingsState';
import type { ProbeResult } from '../net/probe';
import type { SourceAdapter } from '../sources/types';
import { readLog } from '../store/recover';
import { Store } from '../store/store';
import type { Clock } from './power';
import { POWER_NAP_MS, Runtime, TICK_MS } from './runtime';

// Fake-clock tests for sleep, wake, clock changes and per-source scheduling (PLAN.md
// verification). The wall clock and the monotonic clock advance separately: sleep moves only the
// wall clock, as on a real Mac.

const MIN = 60_000;
const HOUR = 60 * MIN;
const START = Date.parse('2026-10-06T08:00:00Z'); // Tuesday 09:00 in London: work hours

class FakeClock implements Clock {
  wall = START;
  monoMs = 1000;
  wakeTime = 'boot';
  now = () => new Date(this.wall);
  mono = () => this.monoMs;
  /** Time passing while awake. */
  pass(ms: number) {
    this.wall += ms;
    this.monoMs += ms;
  }
  /** Asleep: the monotonic clock stops, and the kernel records a new wake time. */
  sleep(ms: number) {
    this.wall += ms;
    this.wakeTime = `wake-${this.wall}`;
  }
}

interface Poll {
  id: SourceId;
  reason: PollReason;
  at: number; // ms since START, wall clock
}

let dir: string;
let clock: FakeClock;
let store: Store;
let runtime: Runtime;
let polls: Poll[];
let online: boolean;
let probes: number;
let checks: StartupCheck[];
let checkRuns: number;
let sources: SourceAdapter[];

const adapter = (id: SourceId, needsNetwork: boolean): SourceAdapter => ({
  id,
  deps: needsNetwork ? ['network', id === 'slack' ? 'slack' : 'claude'] : ['wisprDb'],
  needsNetwork,
  fetchSince: async () => ({ items: [], nextCursor: '' }),
  probe: async () => 'ok',
});

async function build(opts: { wispr?: boolean; safeMode?: boolean; lastPollAt?: Partial<Record<SourceId, number>> } = {}) {
  const settings = defaultSettings(dir);
  if (opts.wispr !== false) settings.sources = { wispr: { enabled: true } };
  await initDataDir(dir, { settings, rules: DEFAULT_RULES });
  ({ store } = await Store.open({ dataDir: dir, now: clock.now }));
  for (const [id, at] of Object.entries(opts.lastPollAt ?? {})) {
    const was = clock.wall;
    clock.wall = at;
    await store.append({ type: 'source.polled', data: { source: id as SourceId, reason: 'scheduled', fetched: 0 } });
    clock.wall = was;
  }
  const state = await SettingsState.create(dir, await loadSettings(dir), false);
  sources = [adapter('slack', true), ...(opts.wispr === false ? [] : [adapter('wispr', false)])];
  runtime = new Runtime({
    clock,
    store,
    settings: state,
    sources: () => sources,
    poll: async (s, reason) => {
      polls.push({ id: s.id, reason, at: clock.wall - START });
      if (s.needsNetwork && !online) {
        await runtime.reportFailure(s.deps[1], { state: 'degraded', reason: 'enotfound', needsProbe: true });
        return;
      }
      await store.append({ type: 'source.polled', data: { source: s.id, reason, fetched: 0 } });
    },
    probe: async (): Promise<ProbeResult> => {
      probes += 1;
      return online ? { ok: true } : { ok: false, failure: { state: 'offline', reason: 'enotfound' } };
    },
    checks: async () => (checkRuns++, checks),
    wakeTime: () => clock.wakeTime,
    followZone: () => undefined,
    safeMode: opts.safeMode,
    clearSafeMode: async () => undefined,
    random: () => 0.5,
  });
}

/** Runs ticks for `ms` of awake time, as the 5 s interval would. */
async function awake(ms: number) {
  for (let t = 0; t < ms; t += TICK_MS) {
    clock.pass(TICK_MS);
    await runtime.tick();
    await runtime.settled();
  }
}

async function loggedTypes() {
  const types: string[] = [];
  await readLog(join(dir, 'events'), { afterSeq: 0, repair: false, onEvent: (e) => void types.push(e.type) });
  return types;
}

const reasons = (id?: SourceId) => polls.filter((p) => !id || p.id === id).map((p) => p.reason);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workos-wake-'));
  clock = new FakeClock();
  polls = [];
  online = true;
  probes = 0;
  checkRuns = 0;
  checks = [{ id: 'settings', label: 'Settings', status: 'ok', note: 'ok' }];
});
afterEach(async () => {
  await runtime?.stop();
  await store?.close();
  await rm(dir, { recursive: true, force: true });
});

describe('per-source schedule', () => {
  it('polls each source first thing, in priority order, then on its own interval', async () => {
    await build();
    await runtime.tick();
    await runtime.settled();
    expect(polls).toEqual([
      { id: 'slack', reason: 'first', at: 0 },
      { id: 'wispr', reason: 'first', at: 0 },
    ]);
    await awake(HOUR);
    // Slack every 10 min in work hours; Wispr Flow every 3 h, so not again within the hour.
    expect(polls.filter((p) => p.id === 'slack').map((p) => p.at / MIN)).toEqual([0, 10, 20, 30, 40, 50, 60]);
    expect(reasons('wispr')).toEqual(['first']);
    expect(runtime.scheduler.nextPollAt('wispr')).toBe(new Date(START + 3 * HOUR).toISOString());
  });

  it('continues from the logged last poll after a restart instead of polling at once', async () => {
    await build({ lastPollAt: { slack: START - 4 * MIN, wispr: START - HOUR } });
    await awake(7 * MIN);
    expect(polls.map((p) => [p.id, p.at / MIN])).toEqual([['slack', 6]]);
  });

  it('keeps polling a local source while Slack is offline', async () => {
    await build({ lastPollAt: { slack: START, wispr: START - 3 * HOUR + 2 * MIN } });
    online = false;
    runtime.health.fail('network', { state: 'offline', reason: 'enotfound' });
    await awake(15 * MIN);
    expect(reasons('wispr')).toEqual(['scheduled']);
    expect(reasons('slack')).toEqual([]); // skipped while offline, not attempted and failed
  });

  it('does not poll in safe mode until "Check again"', async () => {
    await build({ safeMode: true });
    await awake(30 * MIN);
    expect(polls).toEqual([]);
    expect(runtime.mode()).toBe('safe');
    expect(runtime.sourceStatus('slack').status).toBe('paused');
    await runtime.recheck();
    await runtime.settled();
    expect(runtime.mode()).toBe('normal');
    expect(reasons()).toEqual(['first', 'first']);
  });
});

describe('sleep and wake', () => {
  it('catches up within a minute of waking from a 3 h sleep, overdue sources only, Slack first', async () => {
    await build();
    await awake(10 * MIN); // first polls, then Slack at 10 min
    polls = [];
    const inFlight = runtime.sleepSignal;
    clock.sleep(3 * HOUR);
    await awake(TICK_MS);
    expect(runtime.phase).toBe('waking');
    expect(inFlight.aborted).toBe(true); // calls frozen across sleep are cut off
    expect(runtime.sleepSignal.aborted).toBe(false);
    await awake(55_000);
    expect(polls.map((p) => [p.id, p.reason])).toEqual([
      ['slack', 'wake'],
      ['wispr', 'wake'],
    ]);
    const wokeAt = 10 * MIN + 3 * HOUR;
    expect(polls[0].at - wokeAt).toBeLessThanOrEqual(MIN); // Story 2.1
    expect(runtime.phase).toBe('running');
    expect(runtime.lastWakeAt).toBe(new Date(START + wokeAt + TICK_MS).toISOString());
    expect(await loggedTypes()).toContain('system.woke');
  });

  it('does not catch up a source that is not overdue', async () => {
    await build();
    await awake(5 * MIN);
    polls = [];
    clock.sleep(2 * MIN); // short sleep: Slack is at 7 of 10 minutes, Wispr Flow nowhere near 3 h
    await awake(MIN);
    expect(polls).toEqual([]);
    await awake(3 * MIN);
    expect(reasons()).toEqual(['scheduled']);
  });

  it('keeps Claude off for 45 s after a wake, so a Power Nap wake only fetches', async () => {
    await build();
    await awake(TICK_MS);
    expect(runtime.canUseClaude()).toBe(true);
    clock.sleep(HOUR);
    for (let t = 0; t < 20_000; t += TICK_MS) {
      await awake(TICK_MS);
      expect(runtime.canUseClaude()).toBe(false);
    }
    clock.sleep(2 * HOUR); // back to sleep after 20 s, as a Power Nap does
    await awake(TICK_MS); // the tick that sees the wake
    await awake(POWER_NAP_MS - TICK_MS);
    expect(runtime.canUseClaude()).toBe(false);
    await awake(TICK_MS);
    expect(runtime.canUseClaude()).toBe(true);
  });

  it('when offline at wake: local sources catch up, Slack on reconnect', async () => {
    await build();
    await awake(10 * MIN);
    polls = [];
    online = false;
    clock.sleep(4 * HOUR);
    await awake(25_000); // the wake, 10 s to settle, then 3 probes 5 s apart
    expect(probes).toBe(3);
    expect(runtime.health.state('network')).toBe('offline');
    await awake(35_000);
    expect(polls.map((p) => [p.id, p.reason])).toEqual([['wispr', 'wake']]);
    expect(runtime.sourceStatus('slack').status).toBe('offline');
    await awake(5 * MIN);
    expect(reasons('slack')).toEqual([]);
    online = true;
    await awake(5 * MIN); // the offline breaker re-probes within its 5 min cap
    expect(polls.filter((p) => p.id === 'slack').map((p) => p.reason)).toEqual(['reconnect']);
    expect(runtime.health.state('network')).toBe('ok');
  });

  it('probes with backoff while offline, not on every tick', async () => {
    await build({ wispr: false });
    await awake(TICK_MS);
    online = false;
    clock.sleep(HOUR);
    await awake(HOUR);
    // 3 at wake, then waits from 5 s growing to the 5 min cap: about 25 in the hour, not 720.
    expect(probes).toBeLessThan(30);
    expect(probes).toBeGreaterThan(15);
    probes = 0;
    await awake(MIN);
    expect(probes).toBeLessThanOrEqual(1); // at the cap: at most one probe a minute
  });
});

describe('clock changes', () => {
  it('does not set off a burst when the clock goes back', async () => {
    await build({ wispr: false });
    await awake(10 * MIN);
    polls = [];
    clock.wall -= 30 * MIN; // stays inside work hours, so the interval stays 10 min
    await awake(30 * MIN);
    expect(polls.map((p) => p.reason)).toEqual(['scheduled', 'scheduled', 'scheduled']);
    expect(runtime.phase).toBe('running');
  });

  it('does not treat a forward clock change as a wake', async () => {
    await build({ wispr: false });
    await awake(10 * MIN);
    polls = [];
    clock.wall += 2 * HOUR; // the clock moved, the kernel's wake time did not
    await awake(30 * MIN);
    expect(polls.map((p) => p.reason)).toEqual(['scheduled', 'scheduled', 'scheduled']);
    expect(runtime.lastWakeAt).toBeUndefined();
  });
});

describe('health and degraded mode', () => {
  it('logs health changes and goes degraded on a failed check, back on recheck', async () => {
    await build({ wispr: false });
    checks = [{ id: 'slack_token', label: 'Slack token in Keychain', status: 'fail', note: 'missing' }];
    await awake(TICK_MS);
    expect(runtime.mode()).toBe('degraded');
    checks = [{ id: 'slack_token', label: 'Slack token in Keychain', status: 'ok', note: 'ok' }];
    await runtime.recheck();
    expect(runtime.mode()).toBe('normal');
    runtime.health.fail('slack', { state: 'auth_failed', reason: 'invalid_auth' });
    await runtime.settled();
    expect(runtime.mode()).toBe('degraded');
    expect(runtime.sourceStatus('slack')).toMatchObject({ status: 'auth_failed', message: expect.stringMatching(/token/) });
    expect(runtime.view().deps.find((d) => d.id === 'slack')).toMatchObject({ state: 'auth_failed', reason: 'invalid_auth' });
    expect(await loggedTypes()).toContain('health.changed');
  });

  it('reruns the checks every 5 minutes', async () => {
    await build({ wispr: false });
    await awake(16 * MIN);
    expect(checkRuns).toBe(4); // at 0, 5, 10 and 15 minutes
  });
});
