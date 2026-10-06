import { execFileSync } from 'node:child_process';
import { link, readFile, rename, rm, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Instance } from '../config/env';
import { fsyncDir, tmpName, writeSynced } from '../store/atomic';

// Single-instance lock (PLAN.md §4.3, Story 1.1). The lock file appears complete or not at all:
// it is written to a tmp file and hard-linked into place, and link() fails if the lock exists.
// A lock is stale when its process is gone, its pid now belongs to another process, or it was
// taken before the last boot. A stale lock is moved aside, never deleted, then taken over.

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
  let tookOver: LockInfo | undefined;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await link(tmp, file);
        await fsyncDir(dirname(file));
        const lock: Lock = {
          info,
          release: async () => {
            // Only remove the lock if it is still ours.
            if (sameHolder(await readLock(file), info)) await unlink(file).catch(() => undefined);
          },
        };
        return { ok: true, lock, tookOver };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const holder = await readLock(file);
      if (!isStale(holder, probe)) return { ok: false, holder: holder! };
      // Move the stale lock aside. Another starter may have done the same and taken the lock in
      // between; if what we moved isn't the lock we judged stale, put it back and report it held.
      const aside = `${file}.stale-${now().getTime()}-${process.pid}`;
      try {
        await rename(file, aside);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
      const moved = await readLock(aside);
      if (holder && moved && !sameHolder(moved, holder)) {
        await link(aside, file).catch(() => undefined);
        await rm(aside, { force: true });
        if (!isStale(moved, probe)) return { ok: false, holder: moved };
        continue;
      }
      tookOver = holder;
    }
    throw new Error(`Could not take the lock at ${file}`);
  } finally {
    await rm(tmp, { force: true });
  }
}
