import { londonParts, type Settings } from '@work-os/shared';
import { open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { writeJsonAtomic } from './atomic';
import type { DraftStore } from './drafts';
import type { ItemFiles } from './items';
import type { Store } from './store';

// Retention (FR-12.1, PLAN.md §4.3). Once a day, on the first tick after 03:00 (or after the wake
// that follows a missed 03:00), it removes what holds message text and is older than
// `retentionDays`:
//   - items/<source>/<id>.json, by the thread's last activity (the inbox then shows "expired");
//   - drafts of finished actions (done, failed, discarded) whose item has expired;
//   - sandbox/ files: dry-run vault notes and would-be Confluence pages;
//   - logs/app-<date>.log by date (they hold no message text, but nobody needs them older).
// Events, the usage log and labels stay: events and usage hold no message text, and the labelled
// set is kept on purpose (see §7.7). The launchd output logs are cut to their last 1 MB once over
// 5 MB, in place, because launchd keeps them open.

const DAY_MS = 86_400_000;
export const RUN_AFTER_HOUR = 3;
export const LAUNCHD_LOG_MAX = 5 * 1024 * 1024;
export const LAUNCHD_LOG_KEEP = 1024 * 1024;
const FINISHED = new Set(['done', 'failed', 'discarded']);

export interface RetentionDeps {
  dataDir: string;
  store: Store;
  items: ItemFiles;
  drafts: DraftStore;
  settings: () => Settings;
  now: () => Date;
  logger?: Logger;
}

export interface RetentionReport {
  at: string;
  cutoff: string;
  items: number;
  drafts: number;
  sandboxFiles: number;
  appLogs: number;
  launchdLogsCut: number;
  durationMs: number;
}

export async function runRetention(d: RetentionDeps): Promise<RetentionReport> {
  const t0 = performance.now();
  const now = d.now();
  const cutoff = new Date(now.getTime() - d.settings().retentionDays * DAY_MS).toISOString();
  const report: RetentionReport = { at: now.toISOString(), cutoff, items: 0, drafts: 0, sandboxFiles: 0, appLogs: 0, launchdLogsCut: 0, durationMs: 0 };

  // Items: the projection says which might be old; the file under its lock has the final word.
  const expired = new Set<string>();
  for (const it of Object.values(d.store.projection.items)) {
    if (it.lastActivityAt >= cutoff) continue;
    expired.add(it.id);
    // Most old items expired on an earlier night: a stat skips them without filling the item cache.
    if ((await d.items.hasFile(it.source, it.id)) && (await d.items.expire(it.source, it.id, cutoff))) report.items++;
  }

  // Drafts of finished actions on expired items. Drafts still in play stay: Frank hasn't decided.
  for (const a of Object.values(d.store.projection.actions)) {
    if (!FINISHED.has(a.status) || !expired.has(a.itemId) || a.updatedAt >= cutoff) continue;
    if (await d.drafts.remove(a.id)) report.drafts++;
  }

  report.sandboxFiles = await removeOlder(join(d.dataDir, 'sandbox'), Date.parse(cutoff));

  const logs = join(d.dataDir, 'logs');
  const cutoffDay = cutoff.slice(0, 10);
  for (const f of await readdir(logs).catch(() => [] as string[])) {
    const m = /^app-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
    if (m && m[1] < cutoffDay) {
      await rm(join(logs, f), { force: true });
      report.appLogs++;
    }
  }
  for (const f of ['launchd.out.log', 'launchd.err.log']) if (await cutLog(join(logs, f))) report.launchdLogsCut++;

  report.durationMs = Math.round(performance.now() - t0);
  d.logger?.info({ ...report }, 'Retention ran');
  return report;
}

/** Files under `dir` last changed before `before`, removed; the folders stay. */
async function removeOlder(dir: string, before: number): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) n += await removeOlder(p, before);
    else if (e.isFile()) {
      const st = await stat(p).catch(() => undefined);
      if (st && st.mtimeMs < before) {
        await rm(p, { force: true });
        n++;
      }
    }
  }
  return n;
}

/** Keeps the last LAUNCHD_LOG_KEEP bytes of a log over LAUNCHD_LOG_MAX, in place (the writer keeps its descriptor). */
export async function cutLog(path: string, max = LAUNCHD_LOG_MAX, keep = LAUNCHD_LOG_KEEP): Promise<boolean> {
  const fh = await open(path, 'r+').catch(() => undefined);
  if (!fh) return false;
  try {
    const { size } = await fh.stat();
    if (size <= max) return false;
    const tail = Buffer.alloc(keep);
    const { bytesRead } = await fh.read(tail, 0, keep, size - keep);
    const nl = tail.indexOf(10); // start at a whole line
    const body = tail.subarray(nl >= 0 && nl < bytesRead - 1 ? nl + 1 : 0, bytesRead);
    await fh.truncate(0);
    await fh.write(Buffer.concat([Buffer.from(`[cut by retention at ${new Date().toISOString()}]\n`), body]), 0, undefined, 0);
    await fh.sync();
    return true;
  } finally {
    await fh.close();
  }
}

/**
 * When retention runs: the first tick at or after 03:00 London on a day it hasn't run yet. The
 * last run is kept in state/retention.json, so a restart doesn't run it twice and a Mac asleep at
 * 03:00 runs it on the first tick after waking.
 */
export class RetentionJob {
  private lastDay?: string;
  private loaded = false;
  private running?: Promise<RetentionReport | undefined>;

  constructor(
    private readonly d: RetentionDeps,
    private readonly stateFile = join(d.dataDir, 'state/retention.json'),
  ) {}

  /** On every tick. Resolves once a run that this tick started has finished. */
  async tick(): Promise<RetentionReport | undefined> {
    if (this.running) return undefined;
    if (!this.loaded) {
      this.loaded = true;
      this.lastDay = await readFile(this.stateFile, 'utf8')
        .then((t) => (JSON.parse(t) as { lastDay?: string }).lastDay)
        .catch(() => undefined);
    }
    const p = londonParts(this.d.now());
    if (p.hours < RUN_AFTER_HOUR || this.lastDay === p.dateKey) return undefined;
    this.lastDay = p.dateKey;
    this.running = (async () => {
      try {
        const report = await runRetention(this.d);
        await writeJsonAtomic(this.stateFile, { schemaVersion: 1, lastDay: p.dateKey, lastRunAt: report.at });
        return report;
      } catch (err) {
        this.d.logger?.error({ err }, 'Retention failed; it runs again tomorrow');
        return undefined;
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  async settled() {
    await this.running;
  }
}
