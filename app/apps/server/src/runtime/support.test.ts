import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isWorkHours, setTimeZone, timeZone, type DependencyHealth, type StartupCheck } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tokenAccount } from '../api/auth';
import { memoryKeychain, SLACK_TOKEN_ACCOUNT, type SecretStore } from '../config/keychain';
import { runChecks, type Exec } from './checks';
import { clearCrashes, recordCleanStop, recordStart } from './crashLoop';
import { PowerMonitor, type Clock } from './power';
import { followSystemZone, systemZone } from './tz';

describe('PowerMonitor', () => {
  let wall: number;
  let mono: number;
  let wake: string | undefined;
  const clock: Clock = { now: () => new Date(wall), mono: () => mono };
  const tick = (ms = 5000) => {
    wall += ms;
    mono += ms;
  };

  beforeEach(() => {
    wall = Date.parse('2026-10-06T08:00:00Z');
    mono = 0;
    wake = 'w0';
  });

  it('stays quiet while the clocks agree, allowing for timer drift', () => {
    const m = new PowerMonitor(clock, () => wake);
    for (let i = 0; i < 100; i++) {
      tick();
      wall += 200; // a late timer or NTP slew
      expect(m.check()).toBeUndefined();
    }
  });

  it('reports a wake when the wall clock jumped and the kernel’s wake time changed', () => {
    const m = new PowerMonitor(clock, () => wake);
    tick();
    wall += 3 * 3600_000;
    wake = 'w1';
    expect(m.check()).toEqual({ kind: 'wake', sleptMs: 3 * 3600_000 });
    tick();
    expect(m.check()).toBeUndefined();
  });

  it('tells a clock change from a wake', () => {
    const m = new PowerMonitor(clock, () => wake);
    wall += 3600_000;
    expect(m.check()).toEqual({ kind: 'clock_forward', skewMs: 3600_000 });
    wall -= 2 * 3600_000;
    expect(m.check()).toEqual({ kind: 'clock_back', skewMs: -2 * 3600_000 });
  });

  it('reports no wake when the wake time can’t be read', () => {
    const m = new PowerMonitor(clock, () => undefined);
    wall += 3600_000;
    expect(m.check()?.kind).toBe('clock_forward');
  });
});

describe('time zone', () => {
  afterEach(() => setTimeZone('Europe/London'));

  it('reads the zone from /etc/localtime', () => {
    expect(systemZone(() => '/var/db/timezone/zoneinfo/America/New_York')).toBe('America/New_York');
    expect(systemZone(() => '/usr/share/zoneinfo/Europe/Paris')).toBe('Europe/Paris');
  });

  it('follows a change, and work hours move with it', () => {
    const at = new Date('2026-10-06T07:30:00Z'); // 08:30 London, 03:30 New York
    expect(isWorkHours(at, 'Mon–Fri 08:00–18:30')).toBe(true);
    const tz = process.env.TZ;
    try {
      expect(followSystemZone(() => 'America/New_York')).toBe('America/New_York');
      expect(timeZone()).toBe('America/New_York');
      expect(isWorkHours(at, 'Mon–Fri 08:00–18:30')).toBe(false);
      expect(followSystemZone(() => 'America/New_York')).toBeUndefined(); // unchanged
    } finally {
      process.env.TZ = tz;
    }
  });

  it('keeps the current zone when the new one is unknown or unreadable', () => {
    expect(followSystemZone(() => 'Mars/Olympus_Mons')).toBeUndefined();
    expect(followSystemZone(() => undefined)).toBeUndefined();
    expect(timeZone()).toBe('Europe/London');
  });
});

describe('crash loop and safe mode', () => {
  let dir: string;
  const at = (min: number) => new Date(Date.parse('2026-10-06T08:00:00Z') + min * 60_000);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workos-runs-'));
    await mkdir(join(dir, 'state')); // made by initDataDir before this runs
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('enters safe mode after more than 5 crashes in 10 minutes', async () => {
    for (let i = 0; i < 6; i++) expect((await recordStart(dir, at(i), 100 + i)).safeMode).toBe(false);
    expect(await recordStart(dir, at(6), 200)).toEqual({ crashes: 6, safeMode: true });
  });

  it('does not count clean stops, or crashes older than 10 minutes', async () => {
    for (let i = 0; i < 6; i++) {
      await recordStart(dir, at(i), 100 + i);
      if (i % 2) await recordCleanStop(dir, 100 + i);
    }
    expect(await recordStart(dir, at(6), 200)).toEqual({ crashes: 3, safeMode: false });
    expect((await recordStart(dir, at(30), 201)).crashes).toBe(0);
  });

  it('forgets earlier crashes on "Check again", but this run still counts', async () => {
    for (let i = 0; i < 7; i++) await recordStart(dir, at(i), 100 + i);
    await clearCrashes(dir, 106);
    const runs = JSON.parse(await readFile(join(dir, 'state', 'runs.json'), 'utf8')).runs as { pid: number; clean: boolean }[];
    expect(runs.filter((r) => !r.clean).map((r) => r.pid)).toEqual([106]);
    expect((await recordStart(dir, at(8), 300)).crashes).toBe(1);
  });

  it('starts afresh from a missing or corrupt file', async () => {
    expect(await recordStart(dir, at(0))).toEqual({ crashes: 0, safeMode: false });
    await writeFile(join(dir, 'state', 'runs.json'), '{"runs": [tor');
    expect(await recordStart(dir, at(1))).toEqual({ crashes: 0, safeMode: false });
  });
});

describe('startup checks (FR-12.2)', () => {
  const pmset = (on: boolean) => ` standby              1\n powernap             ${on ? 1 : 0}\n womp                 1\n`;
  const fakeExec =
    (fv: string, powerNap = false): Exec =>
    async (cmd) =>
      cmd.endsWith('fdesetup') ? { code: 0, stdout: fv } : { code: 0, stdout: pmset(powerNap) };
  const settingsOk: StartupCheck = { id: 'settings', label: 'Settings', status: 'ok', note: 'ok' };
  const run = (secrets: SecretStore, exec = fakeExec('FileVault is On.\n')) => runChecks({ exec, secrets, instance: 'dev', settingsCheck: () => settingsOk });
  const byId = (checks: StartupCheck[]) => Object.fromEntries(checks.map((c) => [c.id, c]));

  it('passes with FileVault on and both secrets in the Keychain', async () => {
    const checks = byId(await run(memoryKeychain({ [tokenAccount('dev')]: 't', [SLACK_TOKEN_ACCOUNT]: 'xoxp-test' })));
    for (const id of ['filevault', 'api_key', 'slack_token', 'settings', 'keychain', 'power_nap'] as const) expect(checks[id].status).toBe('ok');
    expect(checks.claude_login.status).toBe('warn'); // no Claude call yet
  });

  it('judges the Claude login by the last real call (FR-12.2)', async () => {
    const secrets = memoryKeychain({ [tokenAccount('dev')]: 't', [SLACK_TOKEN_ACCOUNT]: 'xoxp-test' });
    const claude = async (h: Partial<DependencyHealth>) =>
      byId(await runChecks({ exec: fakeExec('FileVault is On.\n'), secrets, instance: 'dev', settingsCheck: () => settingsOk, claude: () => ({ id: 'claude', state: 'unknown', since: '', failures: 0, ...h }) }))
        .claude_login;
    expect(await claude({})).toMatchObject({ status: 'warn', note: expect.stringMatching(/not called yet/) });
    expect(await claude({ state: 'ok', lastOkAt: '2026-10-06T20:09:16.000Z' })).toMatchObject({ status: 'ok', note: 'ok: last call 2026-10-06T20:09:16.000Z' });
    expect(await claude({ state: 'auth_failed', fix: 'Run `claude login` in Terminal, then Check again.' })).toMatchObject({ status: 'fail', note: expect.stringMatching(/claude login/) });
    expect(await claude({ state: 'rate_limited', fix: 'The Claude usage limit was reached.' })).toMatchObject({ status: 'warn' });
  });

  it('fails on a missing Slack token, naming the Keychain entry', async () => {
    const checks = byId(await run(memoryKeychain()));
    expect(checks.slack_token).toMatchObject({ status: 'fail', note: expect.stringContaining(SLACK_TOKEN_ACCOUNT) });
    expect(checks.keychain.status).toBe('ok');
  });

  it('fails on a locked Keychain without treating it as a missing token', async () => {
    const locked: SecretStore = { get: () => Promise.reject(new Error('locked')), set: () => Promise.reject(new Error('locked')) };
    const checks = byId(await run(locked));
    expect(checks.keychain.status).toBe('fail');
    expect(checks.slack_token.note).toBe('Keychain locked');
  });

  it('warns about FileVault off and notes Power Nap', async () => {
    const checks = byId(await run(memoryKeychain(), fakeExec('FileVault is Off.\n', true)));
    expect(checks.filevault).toMatchObject({ status: 'warn', note: expect.stringMatching(/^off/) });
    expect(checks.power_nap).toMatchObject({ status: 'ok', note: expect.stringMatching(/45 s/) });
    const failed = byId(await run(memoryKeychain(), async () => ({ code: -1, stdout: '' })));
    expect(failed.filevault.note).toBe('could not check');
  });
});
