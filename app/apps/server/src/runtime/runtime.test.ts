import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Lifecycle } from './lifecycle';
import { acquireLock, type LockInfo, type ProcessProbe } from './lock';

/** A process table: pid → start time. */
const probe = (procs: Record<number, string>, boot = '1791100000'): ProcessProbe => ({
  alive: (pid) => pid in procs,
  procStart: (pid) => procs[pid],
  bootTime: () => boot,
});
const ME = 'Mon Oct  5 09:00:00 2026';
const meta = { instance: 'dev' as const, port: 4318, version: 'test' };

describe('lock', () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workos-lock-'));
    file = join(dir, 'lock');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const holder = (over: Partial<LockInfo>): LockInfo => ({
    pid: 4242,
    procStart: 'Mon Oct  5 08:00:00 2026',
    bootTime: '1791100000',
    instance: 'prod',
    port: 4317,
    version: '1.0.0',
    startedAt: '2026-10-05T07:00:00.000Z',
    schemaVersion: 1,
    ...over,
  });
  const writeHolder = (h: LockInfo) => writeFile(file, JSON.stringify(h));

  it('takes a free lock and releases it', async () => {
    const res = await acquireLock(file, meta, probe({ [process.pid]: ME }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ pid: process.pid, procStart: ME, port: 4318 });
    await res.lock.release();
    expect(await readdir(dir)).toEqual([]);
  });

  it('refuses a lock held by a live process, reporting where it runs (Story 1.1)', async () => {
    const h = holder({});
    await writeHolder(h);
    const res = await acquireLock(file, meta, probe({ [process.pid]: ME, 4242: h.procStart }));
    expect(res).toEqual({ ok: false, holder: h });
  });

  it.each<[string, LockInfo, Record<number, string>]>([
    ['its process is gone', holder({}), {}],
    ['its pid now belongs to another process', holder({}), { 4242: 'Mon Oct  5 09:30:00 2026' }],
    ['it is from before the last boot', holder({ bootTime: '1790000000' }), { 4242: 'Mon Oct  5 08:00:00 2026' }],
  ])('takes over a stale lock when %s, keeping the old one aside', async (_why, h, procs) => {
    await writeHolder(h);
    const res = await acquireLock(file, meta, probe({ [process.pid]: ME, ...procs }));
    expect(res.ok && res.tookOver).toEqual(h);
    const files = await readdir(dir);
    expect(files.filter((f) => f.startsWith('lock.stale-'))).toHaveLength(1);
  });

  it('treats an unreadable lock file as stale', async () => {
    await writeFile(file, '');
    expect((await acquireLock(file, meta, probe({ [process.pid]: ME }))).ok).toBe(true);
  });

  it('lets exactly one of two starters win, with or without a stale lock', async () => {
    const p = probe({ [process.pid]: ME });
    const free = await Promise.all([acquireLock(file, meta, p), acquireLock(file, meta, p)]);
    expect(free.filter((r) => r.ok)).toHaveLength(1);
    for (const r of free) if (r.ok) await r.lock.release();

    await writeHolder(holder({}));
    const stale = await Promise.all([acquireLock(file, meta, p), acquireLock(file, meta, p), acquireLock(file, meta, p)]);
    expect(stale.filter((r) => r.ok)).toHaveLength(1);
    expect(JSON.parse(await readFile(file, 'utf8')).pid).toBe(process.pid);
  });

  it('lets exactly one win however the starters interleave over a stale lock', async () => {
    const p = probe({ [process.pid]: ME });
    for (let round = 0; round < 40; round++) {
      await writeHolder(holder({}));
      const res = await Promise.all(Array.from({ length: 8 }, () => acquireLock(file, meta, p)));
      expect(res.filter((r) => r.ok), `round ${round}`).toHaveLength(1);
      for (const r of res) if (r.ok) await r.lock.release();
    }
    // Every stale lock was kept aside, none lost.
    expect((await readdir(dir)).filter((f) => f.startsWith('lock.stale-'))).toHaveLength(40);
    expect(await readdir(dir)).not.toContain('lock.takeover');
  });

  it('moves aside a takeover file a crashed starter left behind', async () => {
    await writeHolder(holder({}));
    await writeFile(`${file}.takeover`, '4242\n');
    const later = () => new Date(Date.now() + 60_000);
    const res = await acquireLock(file, meta, probe({ [process.pid]: ME }), later);
    expect(res.ok).toBe(true);
    const files = await readdir(dir);
    expect(files.filter((f) => f.startsWith('lock.takeover.stale-'))).toHaveLength(1);
    expect(files).not.toContain('lock.takeover');
  });

  it('does not remove a lock someone else holds now', async () => {
    const res = await acquireLock(file, meta, probe({ [process.pid]: ME }));
    if (!res.ok) throw new Error('expected the lock');
    await writeHolder(holder({}));
    await res.lock.release();
    expect(JSON.parse(await readFile(file, 'utf8')).pid).toBe(4242);
  });
});

describe('Lifecycle', () => {
  it('runs stop hooks newest first, once, and carries on past a failure', async () => {
    const order: string[] = [];
    const errors: string[] = [];
    const lc = new Lifecycle((name) => errors.push(name));
    lc.onStop('lock', () => order.push('lock'));
    lc.onStop('broken', () => {
      throw new Error('boom');
    });
    lc.onStop('http', async () => order.push('http'));
    const [a, b] = await Promise.all([lc.stop('SIGTERM'), lc.stop('SIGTERM')]);
    expect(order).toEqual(['http', 'lock']);
    expect(a).toEqual({ timedOut: false, failed: ['broken'] });
    expect(b).toBe(a);
    expect(errors).toEqual(['broken']);
    expect(lc.isStopping).toBe(true);
  });

  it('gives up waiting on a hung hook at the deadline', async () => {
    vi.useFakeTimers();
    const lc = new Lifecycle();
    lc.onStop('hang', () => new Promise(() => undefined));
    const res = lc.stop('SIGTERM', 8000);
    await vi.advanceTimersByTimeAsync(8000);
    expect((await res).timedOut).toBe(true);
    vi.useRealTimers();
  });
});
