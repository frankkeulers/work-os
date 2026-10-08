import { readFile } from 'node:fs/promises';
import type { SourceId } from '@work-os/shared';
import { writeJsonAtomic } from '../store/atomic';

// state/cursors.json: the last cursor per source, written last in a poll (FR-2.8). The log keeps
// the cursor too (source.polled), so a lost or stale file costs nothing: a start uses the newer.

type Cursors = Partial<Record<SourceId, string>>;

/** Cursors compare as numbers when both are numbers (Slack ts), and otherwise as text, so a
 *  source's cursor must sort as text (Wispr Flow: "modified_at|id", amendment R2.7). */
export function cmpCursor(a: string, b: string): number {
  const x = Number(a);
  const y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return a < b ? -1 : a > b ? 1 : 0;
}

export class CursorFile {
  private cursors: Cursors = {};

  private constructor(private readonly file: string) {}

  static async open(file: string): Promise<CursorFile> {
    const c = new CursorFile(file);
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { cursors?: Cursors };
      if (parsed.cursors && typeof parsed.cursors === 'object') c.cursors = parsed.cursors;
    } catch {
      // Missing or torn: the event log has the cursor.
    }
    return c;
  }

  /** The newer of this file's cursor and the log's (see cmpCursor). */
  get(id: SourceId, fromLog: string | undefined): string | undefined {
    const mine = this.cursors[id];
    if (!mine || !fromLog) return mine ?? fromLog;
    return cmpCursor(mine, fromLog) >= 0 ? mine : fromLog;
  }

  async set(id: SourceId, cursor: string) {
    this.cursors = { ...this.cursors, [id]: cursor };
    await writeJsonAtomic(this.file, { cursors: this.cursors, schemaVersion: 1 });
  }
}
