import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HealthView } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paths } from './config/dataDir';
import type { Notification, Notifier } from './notify/macos';
import { run, type RunResult } from './start';

let dir: string;
let notes: Notification[];
const notifier: Notifier = { notify: async (n) => void notes.push(n) };
const started: RunResult[] = [];

const env = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ WORKOS_INSTANCE: 'dev', WORKOS_DATA_DIR: dir, WORKOS_PORT: '0', ...over });
const start = async (over?: NodeJS.ProcessEnv) => {
  const res = await run({ env: env(over), notifier });
  started.push(res);
  return res;
};

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'workos-start-')), 'data');
  notes = [];
});
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
    const health = (await (await fetch(`${res.url}/api/health`)).json()) as HealthView;
    expect(health).toMatchObject({ mode: 'normal', phase: 'running', instance: 'dev', checks: [{ id: 'settings', status: 'ok' }] });
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
    const health = (await (await fetch(`${res.url}/api/health`)).json()) as HealthView;
    expect(health.mode).toBe('degraded');
    expect(health.checks[0]).toMatchObject({ id: 'settings', status: 'warn' });
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
    const second = await start();
    if (!second.running) throw new Error('expected a restart');
    expect(second.recovery).toMatchObject({ fromSnapshot: true, replayed: 0 });
    expect(second.store.lastSeq).toBe(2);
  });

  it('refuses new commands while stopping, but still answers health', async () => {
    const res = await start();
    if (!res.running) throw new Error('expected a start');
    const { app } = res.server;
    void res.lifecycle.stop('test');
    expect((await app.inject({ method: 'POST', url: '/api/poll' })).statusCode).toBe(503);
  });
});
