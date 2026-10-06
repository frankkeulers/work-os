import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from '../store/atomic';

// Safe mode (PLAN.md robustness §2): a run that ends without a clean stop counts as a crash. After
// more than 5 in 10 minutes the server starts with the UI only and no scheduler, so a crash loop
// can't keep hammering Slack or Claude while launchd keeps restarting it.

export const CRASH_WINDOW_MS = 10 * 60_000;
export const CRASHES_FOR_SAFE_MODE = 5;
const KEEP = 20;

interface Run {
  startedAt: string;
  pid: number;
  clean: boolean;
}

const file = (dataDir: string) => join(dataDir, 'state', 'runs.json');

async function readRuns(dataDir: string): Promise<Run[]> {
  try {
    const parsed = JSON.parse(await readFile(file(dataDir), 'utf8')) as { runs?: Run[] };
    return Array.isArray(parsed.runs) ? parsed.runs : [];
  } catch {
    return [];
  }
}

const save = (dataDir: string, runs: Run[]) => writeJsonAtomic(file(dataDir), { runs: runs.slice(-KEEP), schemaVersion: 1 });

/** Records this start. Returns how many recent runs crashed, and whether that means safe mode. */
export async function recordStart(dataDir: string, now: Date, pid = process.pid): Promise<{ crashes: number; safeMode: boolean }> {
  const runs = await readRuns(dataDir);
  const since = now.getTime() - CRASH_WINDOW_MS;
  const crashes = runs.filter((r) => !r.clean && Date.parse(r.startedAt) >= since).length;
  runs.push({ startedAt: now.toISOString(), pid, clean: false });
  await save(dataDir, runs);
  return { crashes, safeMode: crashes > CRASHES_FOR_SAFE_MODE };
}

export async function recordCleanStop(dataDir: string, pid = process.pid) {
  const runs = await readRuns(dataDir);
  const mine = runs.findLast((r) => r.pid === pid && !r.clean);
  if (mine) mine.clean = true;
  await save(dataDir, runs);
}

/** "Check again" in safe mode: forget earlier crashes. This run still counts if it crashes. */
export async function clearCrashes(dataDir: string, pid = process.pid) {
  const runs = await readRuns(dataDir);
  const current = runs.findLast((r) => r.pid === pid);
  await save(
    dataDir,
    runs.map((r) => (r === current ? r : { ...r, clean: true })),
  );
}
