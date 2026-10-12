import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { link, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Instance } from '../config/env';
import { fsyncDir, tmpName, writeSynced } from '../store/atomic';

// Single-instance lock (PLAN.md §4.3, Story 1.1). The lock file appears complete or not at all:
// it is written to a tmp file and hard-linked into place, and link() fails if the lock exists.
// A lock is stale when its process is gone, its pid now belongs to another process, or it was
// taken before the last boot. A stale lock is moved aside, never deleted, then taken over.
// Only one starter at a time may do that: it holds `<lock>.takeover` while it reads the lock again,
// moves it aside and links its own. Without that, a starter could move a lock another had just
// taken, and two would win.

/** A takeover file older than this was left by a starter that died mid-takeover. */
const TAKEOVER_STALE_MS = 30_000;
const MAX_ATTEMPTS = 200;

export interface LockInfo {
  pid: number;
  procStart: string; // `ps -o lstart`, so a reused pid isn't mistaken for the holder
  bootTime: string; // kern.boottime seconds
  instance: Instance;
  port: number;
  version: string;
  startedAt: string;
  schemaVersion: 1;
}

export interface ProcessProbe {
  alive(pid: number): boolean;
  procStart(pid: number): string | undefined;
  bootTime(): string;
}

export const systemProbe: ProcessProbe = {
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM'; // exists, owned by someone else
    }
  },
  procStart(pid) {
    try {
      return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 }).trim() || undefined;
    } catch {
      return undefined;
    }
  },
  bootTime() {
    const out = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 2000 });
    return /sec = (\d+)/.exec(out)?.[1] ?? out.trim();
  },
};

export interface Lock {
  info: LockInfo;
  release(): Promise<void>;
}

export type LockResult = { ok: true; lock: Lock; tookOver?: LockInfo } | { ok: false; holder: LockInfo };

const sameHolder = (a: LockInfo | undefined, b: LockInfo) => !!a && a.pid === b.pid && a.procStart === b.procStart && a.bootTime === b.bootTime;

async function readLock(file: string): Promise<LockInfo | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as LockInfo;
  } catch {
    return undefined; // missing, or not ours to parse: treated as stale
  }
}

export function isStale(holder: LockInfo | undefined, probe: ProcessProbe): boolean {
  if (!holder || typeof holder.pid !== 'number') return true;
  if (holder.bootTime !== probe.bootTime()) return true;
  if (!probe.alive(holder.pid)) return true;
  return probe.procStart(holder.pid) !== holder.procStart;
}

export async function acquireLock(
  file: string,
  meta: { instance: Instance; port: number; version: string },
  probe: ProcessProbe = systemProbe,
  now: () => Date = () => new Date(),
): Promise<LockResult> {
  const info: LockInfo = {
    pid: process.pid,
    procStart: probe.procStart(process.pid) ?? '',
    bootTime: probe.bootTime(),
    ...meta,
    startedAt: now().toISOString(),
    schemaVersion: 1,
  };
  const tmp = tmpName(file);
  await writeSynced(tmp, `${JSON.stringify(info)}\n`);
  const lock: Lock = {
    info,
    release: async () => {
      // Only remove the lock if it is still ours.
      if (sameHolder(await readLock(file), info)) await unlink(file).catch(() => undefined);
    },
  };
  /** Links ours into place; false when a lock is there. */
  const take = async () => {
    try {
      await link(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
    await fsyncDir(dirname(file));
    return true;
  };
  const aside = (name: string) => `${name}.stale-${now().getTime()}-${process.pid}-${randomBytes(3).toString('hex')}`;
  const takeover = `${file}.takeover`;
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (await take()) return { ok: true, lock };
      const holder = await readLock(file);
      if (!isStale(holder, probe)) return { ok: false, holder: holder! };
      try {
        await writeFile(takeover, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        // Another starter is taking over. A takeover file left by a crash is moved aside too.
        const s = await stat(takeover).catch(() => undefined);
        if (s && now().getTime() - s.mtimeMs > TAKEOVER_STALE_MS) await rename(takeover, aside(takeover)).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 5));
        continue;
      }
      try {
        // Nobody else moves the lock while we hold the takeover file, but a starter may have
        // linked a fresh one since we read it.
        const current = await readLock(file);
        if (!isStale(current, probe)) return { ok: false, holder: current! };
        try {
          await rename(file, aside(file));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        if (await take()) return { ok: true, lock, tookOver: current };
        // A starter linked one in the gap: theirs is fresh.
        const winner = await readLock(file);
        if (!isStale(winner, probe)) return { ok: false, holder: winner! };
      } finally {
        await unlink(takeover).catch(() => undefined);
      }
    }
    throw new Error(`Could not take the lock at ${file}`);
  } finally {
    await rm(tmp, { force: true });
  }
}
