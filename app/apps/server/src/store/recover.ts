import { appendFile, mkdir, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkEvent } from '@work-os/shared';
import { writeFileAtomic } from './atomic';

// Startup recovery (PLAN.md robustness §2). Reads the event log in order and repairs what a crash
// or power loss can leave behind: a torn last line is cut off, an unreadable line is moved to
// events/quarantine/, and leftover tmp files are deleted. Nothing is silently dropped: every
// repair is reported, and the removed bytes are kept in quarantine.

export interface Quarantined {
  file: string;
  line: number;
  reason: string;
}

export interface LogReport {
  files: number;
  events: number; // events passed to onEvent
  lastSeq: number; // the last event applied: the snapshot's own, if nothing came after it
  highestSeq: number; // the highest seq found in the files read, including events the snapshot covers
  lastFile?: string;
  torn: { file: string; bytes: number }[];
  quarantined: Quarantined[];
  gaps: { from: number; to: number }[]; // seqs missing from the log
}

export interface ReadOptions {
  /** Start at this file (from the snapshot); earlier files are skipped. */
  fromFile?: string;
  /** Events up to this seq are already in the snapshot. */
  afterSeq: number;
  /** Repair the files on disk. Off for read-only inspection. */
  repair: boolean;
  onEvent(e: WorkEvent): void;
  now?: () => Date;
}

const FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export async function listEventFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => FILE_RE.test(f)).sort();
}

export async function readLog(dir: string, opts: ReadOptions): Promise<LogReport> {
  const now = opts.now ?? (() => new Date());
  const qdir = join(dir, 'quarantine');
  const report: LogReport = { files: 0, events: 0, lastSeq: opts.afterSeq, highestSeq: 0, torn: [], quarantined: [], gaps: [] };
  const files = (await listEventFiles(dir)).filter((f) => !opts.fromFile || f >= opts.fromFile);
  const stamp = () => now().toISOString().replace(/[:.]/g, '-');

  for (const name of files) {
    const path = join(dir, name);
    const raw = await readFile(path, 'utf8');
    report.files += 1;
    report.lastFile = name;

    // A line without its newline is a write that never finished. Only the newest file is written,
    // but a torn line anywhere is handled the same way.
    const end = raw.lastIndexOf('\n') + 1;
    if (end < raw.length) {
      const tail = raw.slice(end);
      report.torn.push({ file: name, bytes: Buffer.byteLength(tail) });
      if (opts.repair) {
        await mkdir(qdir, { recursive: true });
        await writeFileAtomic(join(qdir, `${name}.${stamp()}.torn`), tail);
        const fh = await open(path, 'r+');
        try {
          await fh.truncate(Buffer.byteLength(raw.slice(0, end)));
          await fh.sync();
        } finally {
          await fh.close();
        }
      }
    }

    const lines = raw.slice(0, end).split('\n');
    lines.pop(); // the empty string after the final newline
    const bad: string[] = [];
    const keep: string[] = [];
    for (const [i, line] of lines.entries()) {
      const reject = (reason: string) => {
        report.quarantined.push({ file: name, line: i + 1, reason });
        bad.push(line);
      };
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        reject('not JSON');
        continue;
      }
      const parsed = WorkEvent.safeParse(json);
      if (!parsed.success) {
        reject(`invalid ${(json as { type?: string })?.type ?? 'event'}: ${parsed.error.issues[0]?.message}`);
        continue;
      }
      const e = parsed.data as WorkEvent;
      report.highestSeq = Math.max(report.highestSeq, e.seq);
      if (e.seq <= opts.afterSeq) {
        keep.push(line); // already in the snapshot
        continue;
      }
      if (e.seq <= report.lastSeq) {
        reject(`duplicate or out-of-order seq ${e.seq} after ${report.lastSeq}`);
        continue;
      }
      if (e.seq > report.lastSeq + 1) report.gaps.push({ from: report.lastSeq + 1, to: e.seq - 1 });
      report.lastSeq = e.seq;
      keep.push(line);
      report.events += 1;
      opts.onEvent(e);
    }

    if (bad.length && opts.repair) {
      await mkdir(qdir, { recursive: true });
      await appendFile(join(qdir, `${name}.${stamp()}.bad.jsonl`), bad.map((l) => `${l}\n`).join(''), { mode: 0o600 });
      await writeFileAtomic(path, keep.map((l) => `${l}\n`).join(''));
    }
  }
  return report;
}

/** Deletes tmp files left by an interrupted atomic write. Recent ones may belong to a starting process. */
export async function removeStaleTmp(dataDir: string, now = new Date(), minAgeMs = 60_000): Promise<string[]> {
  const removed: string[] = [];
  const entries = await readdir(dataDir, { recursive: true }).catch(() => [] as string[]);
  for (const rel of entries) {
    const base = rel.split('/').pop()!;
    if (!base.startsWith('.') || !base.endsWith('.tmp')) continue;
    const path = join(dataDir, rel);
    const s = await stat(path).catch(() => undefined);
    if (!s?.isFile() || now.getTime() - s.mtimeMs < minAgeMs) continue;
    await rm(path, { force: true });
    removed.push(rel);
  }
  return removed;
}
