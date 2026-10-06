import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { UsageRecord } from '@work-os/shared';
import { JsonlAppender } from '../store/jsonl';

// logs/usage-<UTC date>.jsonl: one line per Claude call, failed ones included (CL-5). The last
// eight days are kept in memory for budgets and the usage view; older files stay on disk for
// `npm run eval` and Frank, and are never read at startup.

export const KEEP_DAYS = 8;
const DAY = 86_400_000;

const fileFor = (dir: string, at: string) => join(dir, `usage-${at.slice(0, 10)}.jsonl`);

export class UsageLog {
  private recent: UsageRecord[] = [];
  private appender = new JsonlAppender();

  private constructor(
    private readonly dir: string,
    private readonly now: () => Date,
  ) {}

  static async open(dir: string, now: () => Date = () => new Date()): Promise<UsageLog> {
    const log = new UsageLog(dir, now);
    const today = now().getTime();
    for (let i = KEEP_DAYS - 1; i >= 0; i--) {
      const text = await readFile(fileFor(dir, new Date(today - i * DAY).toISOString()), 'utf8').catch(() => '');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = UsageRecord.safeParse(JSON.parse(line));
          if (r.success) log.recent.push(r.data);
        } catch {
          // A torn last line from a crash: the call is lost from the totals, nothing else.
        }
      }
    }
    log.prune();
    return log;
  }

  /** Appends the record and resolves once it is on disk. */
  async record(r: UsageRecord) {
    await this.appender.append(fileFor(this.dir, r.at), [JSON.stringify(UsageRecord.parse(r))]);
    this.recent.push(r);
    this.prune();
  }

  /** The last eight days, oldest first. */
  records(): readonly UsageRecord[] {
    return this.recent;
  }

  close() {
    return this.appender.close();
  }

  private prune() {
    const cutoff = new Date(this.now().getTime() - KEEP_DAYS * DAY).toISOString();
    if (this.recent.length && this.recent[0].at < cutoff) this.recent = this.recent.filter((r) => r.at >= cutoff);
  }
}
