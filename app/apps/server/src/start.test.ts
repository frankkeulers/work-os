import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HealthView } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paths } from './config/dataDir';
import { memoryKeychain, SLACK_TOKEN_ACCOUNT } from './config/keychain';
import type { Exec } from './runtime/checks';
import type { Notification, Notifier } from './notify/macos';
import { run, type RunResult } from './start';

let dir: string;
let notes: Notification[];
let secrets: ReturnType<typeof memoryKeychain>;
const notifier: Notifier = { notify: async (n) => void notes.push(n) };
const started: RunResult[] = [];

const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ WORKOS_INSTANCE: 'dev', WORKOS_DATA_DIR: dir, WORKOS_PORT: '0', ...over });
// FileVault on, Power Nap off; no real commands, network or time zone change in tests.
const exec: Exec = async (cmd) => ({ code: 0, stdout: cmd.endsWith('fdesetup') ? 'FileVault is On.\n' : ' powernap 0\n' });
const fakes = { exec, wakeTime: () => 'boot', followZone: () => undefined, fetch: () => Promise.reject(new Error('no network in tests')) };
const start = async (over?: NodeJS.ProcessEnv) => {
  const res = await run({ env: env(over), notifier, secrets, ...fakes }); // never the real Keychain in tests
  started.push(res);
  return res;
};

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'workos-start-')), 'data');
  notes = [];
  secrets = memoryKeychain({ [SLACK_TOKEN_ACCOUNT]: 'xoxp-test' });
});
const health = async (res: RunResult) => {
  if (!res.running) throw new Error('expected a running server');
  const r = await fetch(`${res.url}/api/health`, { headers: { authorization: `Bearer ${res.token}` } });
  return (await r.json()) as HealthView;
};
afterEach(async () => {
  for (const r of started.splice(0)) if (r.running) await r.lifecycle.stop('test');
  await rm(dir, { recursive: true, force: true });
});

describe('startup', () => {
  it('creates the data directory, takes the lock and serves health on 127.0.0.1', async () => {
    const res = await start();
    expect(res.running).toBe(true);
    if (!res.running) return;
    expect(res.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await res.runtime.settled(); // the checks run after the server is up
    const h = await health(res);
    expect(h).toMatchObject({ mode: 'normal', phase: 'running', instance: 'dev' });
    expect(h.checks[0]).toMatchObject({ id: 'settings', status: 'ok' });
    expect(h.checks.map((c) => [c.id, c.status])).toEqual([
      ['settings', 'ok'],
      ['filevault', 'ok'],
      ['api_key', 'ok'],
      ['slack_token', 'ok'],
      ['claude_login', 'warn'],
      ['keychain', 'ok'],
      ['power_nap', 'ok'],
    ]);
    expect(JSON.parse(await readFile(paths(dir).lock, 'utf8')).pid).toBe(process.pid);
  });

  it('refuses a second instance, naming where the first one runs (Story 1.1)', async () => {
    const first = await start();
    if (!first.running) throw new Error('expected the first instance to start');
    const port = new URL(first.url).port;
    // The lock holder is this test process, which is alive, so the lock is genuinely held.
    expect(await start()).toEqual({ running: false, code: 75 });
    expect(await start({ WORKOS_LAUNCHD: '1' })).toEqual({ running: false, code: 0 });
    expect(JSON.parse(await readFile(paths(dir).lock, 'utf8')).port).toBe(0);
    expect(port).not.toBe('0');
  });

  it('releases the lock on stop, so the next start succeeds', async () => {
    const first = await start();
    if (!first.running) throw new Error('expected a start');
    await first.lifecycle.stop('SIGTERM');
    await expect(readFile(paths(dir).lock)).rejects.toThrow(/ENOENT/);
    expect((await start()).running).toBe(true);
  });

  it('refuses to run with ANTHROPIC_API_KEY set, without recording the key (CL-2)', async () => {
    const secret = 'sk-ant-test-not-a-real-key';
    expect(await start({ ANTHROPIC_API_KEY: secret })).toEqual({ running: false, code: 78 });
    expect(await start({ ANTHROPIC_API_KEY: '', WORKOS_LAUNCHD: '1' })).toEqual({ running: false, code: 0 });
    const refused = await readFile(paths(dir).refused, 'utf8');
    expect(JSON.parse(refused)).toMatchObject({ reason: 'api_key', fix: expect.stringContaining('launchctl unsetenv') });
    expect(refused).not.toContain(secret);
    expect(notes).toHaveLength(2);
    expect(JSON.stringify(notes)).not.toContain(secret);
    // Refused before taking the lock or creating anything else.
    expect(await readdir(dir)).toEqual(['state']);

    expect((await start()).running).toBe(true);
    await expect(readFile(paths(dir).refused)).rejects.toThrow(/ENOENT/); // a clean start clears it
  });

  it('starts degraded on invalid settings instead of stopping (FR-1.2)', async () => {
    const first = await start();
    if (!first.running) throw new Error('expected a start');
    await first.lifecycle.stop('test');
    await writeFile(paths(dir).settings, '{}');
    const res = await start();
    if (!res.running) throw new Error('expected a degraded start');
    const h = await health(res);
    expect(h.mode).toBe('degraded');
    expect(h.checks[0]).toMatchObject({ id: 'settings', status: 'warn' });
  });

  it('refuses development on the autostarted instance’s data directory', async () => {
    expect(await start({ WORKOS_DATA_DIR: join(process.env.HOME ?? '', 'WorkOS-data') })).toEqual({ running: false, code: 78 });
    expect(notes[0].title).toBe('Work OS did not start');
  });

  it('keeps the inbox across a restart, starting from the snapshot', async () => {
    const first = await start();
    if (!first.running) throw new Error('expected a start');
    await first.store.append({ type: 'item.done', itemId: 'slack:C1:1', data: undefined }, { type: 'settings.changed', data: { dryRun: true } });
    await first.lifecycle.stop('SIGTERM');
    const stoppedAt = first.store.lastSeq; // system.started, the two events above, then system.stopped
    expect(stoppedAt).toBeGreaterThanOrEqual(4);
    const second = await start();
    if (!second.running) throw new Error('expected a restart');
    expect(second.recovery).toMatchObject({ fromSnapshot: true, replayed: 0 });
    expect(second.store.lastSeq).toBe(stoppedAt + 1); // plus this start's system.started
  });

  it('starts degraded, not stopped, without a Slack token; "Check again" picks it up', async () => {
    delete secrets.values[SLACK_TOKEN_ACCOUNT];
    const res = await start();
    if (!res.running) throw new Error('expected a degraded start');
    await res.runtime.settled();
    const h = await health(res);
    expect(h.mode).toBe('degraded');
    expect(h.checks.find((c) => c.id === 'slack_token')).toMatchObject({ status: 'fail', note: expect.stringContaining(SLACK_TOKEN_ACCOUNT) });
    secrets.values[SLACK_TOKEN_ACCOUNT] = 'xoxp-test';
    const r = await fetch(`${res.url}/api/health/recheck`, { method: 'POST', headers: { authorization: `Bearer ${res.token}` } });
    expect(r.status).toBe(204);
    expect((await health(res)).mode).toBe('normal');
  });

  it('accepts "Poll now" (202) and logs the start', async () => {
    const res = await start();
    if (!res.running) throw new Error('expected a start');
    const r = await fetch(`${res.url}/api/poll`, { method: 'POST', headers: { authorization: `Bearer ${res.token}` } });
    expect(r.status).toBe(202);
    const types: string[] = [];
    for (const f of await readdir(join(dir, 'events'))) {
      if (f.endsWith('.jsonl')) for (const line of (await readFile(join(dir, 'events', f), 'utf8')).trim().split('\n')) types.push(JSON.parse(line).type);
    }
    expect(types).toContain('system.started');
  });

  it('starts in safe mode after a crash loop, with a notification (robustness §2)', async () => {
    const first = await start();
    if (!first.running) throw new Error('expected a start');
    await first.lifecycle.stop('test');
    const runs = Array.from({ length: 6 }, (_, i) => ({ startedAt: new Date(Date.now() - i * 1000).toISOString(), pid: 90_000 + i, clean: false }));
    await writeFile(join(dir, 'state', 'runs.json'), JSON.stringify({ runs, schemaVersion: 1 }));
    const res = await start();
    if (!res.running) throw new Error('expected a safe-mode start');
    expect((await health(res)).mode).toBe('safe');
    expect(notes.map((n) => n.title)).toContain('Work OS is in safe mode');
    await fetch(`${res.url}/api/health/recheck`, { method: 'POST', headers: { authorization: `Bearer ${res.token}` } });
    expect((await health(res)).mode).not.toBe('safe');
  });

  it('records a clean stop, so restarts are not counted as crashes', async () => {
    for (let i = 0; i < 8; i++) {
      const res = await start();
      if (!res.running) throw new Error('expected a start');
      await res.lifecycle.stop('SIGTERM');
    }
    const res = await start();
    if (!res.running) throw new Error('expected a start');
    expect(res.runtime.safeMode).toBe(false);
  });

  it('refuses new commands while stopping, but still answers health', async () => {
    const res = await start();
    if (!res.running) throw new Error('expected a start');
    const { app } = res.server;
    void res.lifecycle.stop('test');
    const res503 = await app.inject({ method: 'POST', url: '/api/poll', headers: { authorization: `Bearer ${res.token}` } });
    expect(res503.statusCode).toBe(503);
    expect(res503.json()).toMatchObject({ code: 'unavailable' });
  });
});
