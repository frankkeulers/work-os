import { join } from 'node:path';
import { WorkEvent, type EventDraft } from '@work-os/shared';
import { JsonlAppender, type AppenderHooks } from './jsonl';

// The event log (PLAN.md §4.3): events/<UTC date>.jsonl, every event with a gap-free seq.
// Files only move forward: if the clock goes back past midnight, events keep going to the
// newest file, so reading files in name order always reads seqs in order.

export const eventFileName = (at: string) => `${at.slice(0, 10)}.jsonl`;

export class EventLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventLogError';
  }
}

export class EventLog {
  private nextSeq: number;
  private durableSeq: number;
  private appender: JsonlAppender;

  constructor(
    private readonly dir: string,
    lastSeq: number,
    private lastFile: string | undefined,
    private readonly now: () => Date,
    hooks: AppenderHooks = {},
  ) {
    this.nextSeq = lastSeq + 1;
    this.durableSeq = lastSeq;
    this.appender = new JsonlAppender(hooks);
  }

  get lastSeq() {
    return this.durableSeq;
  }

  /**
   * Validates, numbers and appends events. Resolves once they are synced. If the write fails,
   * nothing queued after it lands either, and the next append reuses the lost seqs, so the log
   * never has a gap.
   */
  async append(drafts: EventDraft[]): Promise<{ events: WorkEvent[]; file?: string }> {
    if (!drafts.length) return { events: [] };
    const at = this.now().toISOString();
    const name = this.lastFile && this.lastFile > eventFileName(at) ? this.lastFile : eventFileName(at);
    const events: WorkEvent[] = [];
    for (const d of drafts) {
      const seq = this.nextSeq + events.length;
      const parsed = WorkEvent.safeParse({ seq, id: `ev-${seq}`, at, ...d, schemaVersion: 1 });
      if (!parsed.success) throw new EventLogError(`Invalid ${d.type} event: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
      events.push(parsed.data as WorkEvent);
    }
    this.nextSeq += events.length;
    this.lastFile = name;
    try {
      await this.appender.append(join(this.dir, name), events.map((e) => JSON.stringify(e)));
    } catch (e) {
      this.nextSeq = this.durableSeq + 1;
      throw e;
    }
    this.durableSeq = events[events.length - 1].seq;
    return { events, file: name };
  }

  flushed() {
    return this.appender.flushed();
  }

  close() {
    return this.appender.close();
  }
}
