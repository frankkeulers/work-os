import { isWorkHours, sourceSchedule, type PollReason, type Settings, type SourceId } from '@work-os/shared';
import type { SourceAdapter } from '../sources/types';
import type { Clock } from './power';

// Per-source polling (FR-2.7, FR-1.3). Each source has its own interval for work and off hours.
// Intervals are measured on a steady clock while the server runs (monotonic plus time asleep), so
// changing the clock neither stalls polling nor sets off a burst; after a wake, catch-up decides by wall-clock time
// which sources are overdue and runs only those, one at a time in priority order.

export interface SchedulerDeps {
  clock: Clock;
  sources: () => SourceAdapter[];
  settings: () => Settings | undefined;
  /** The last poll recorded in the log, for the first decision after a start. */
  lastPollAt: (id: SourceId) => string | undefined;
  /** Breakers, network and safe mode: whether this source may poll now. */
  canPoll: (s: SourceAdapter) => boolean;
  poll: (s: SourceAdapter, reason: PollReason) => Promise<void>;
  onError?: (id: SourceId, err: unknown) => void;
}

const MIN = 60_000;

export class Scheduler {
  private lastMono = new Map<SourceId, number>();
  private queue: { id: SourceId; reason: PollReason }[] = [];
  private running?: Promise<void>;
  current?: { id: SourceId; reason: PollReason };

  constructor(private readonly d: SchedulerDeps) {}

  /** The interval in force now, or undefined if the source doesn't poll at this time. */
  intervalMs(id: SourceId, settings: Settings, at = this.d.clock.now()): number | undefined {
    const s = sourceSchedule(settings, id);
    if (!s.enabled) return undefined;
    const mins = isWorkHours(at, settings.schedule.workHours) ? s.intervalWorkMinutes : s.intervalOffMinutes;
    return mins === null ? undefined : mins * MIN;
  }

  /** How long since the source last polled: monotonic once this process has polled it. */
  private elapsedMs(id: SourceId): number {
    const mono = this.lastMono.get(id);
    if (mono !== undefined) return this.d.clock.mono() - mono;
    return this.wallElapsedMs(id);
  }

  private wallElapsedMs(id: SourceId): number {
    const last = this.d.lastPollAt(id);
    if (!last) return Infinity;
    const ms = this.d.clock.now().getTime() - Date.parse(last);
    return ms < 0 ? Infinity : ms; // a poll "in the future" means the clock went back while stopped
  }

  /** When the source is next due, for the UI. */
  nextPollAt(id: SourceId): string | undefined {
    const settings = this.d.settings();
    const interval = settings && this.intervalMs(id, settings);
    if (interval === undefined) return undefined;
    const elapsed = this.elapsedMs(id);
    const now = this.d.clock.now().getTime();
    return new Date(elapsed === Infinity ? now : now + Math.max(0, interval - elapsed)).toISOString();
  }

  /** Queues every source that is due by its own schedule. Called on each tick. */
  tick() {
    const settings = this.d.settings();
    if (!settings) return;
    for (const s of this.d.sources()) {
      const interval = this.intervalMs(s.id, settings);
      if (interval === undefined) continue;
      const elapsed = this.elapsedMs(s.id);
      if (elapsed >= interval) this.enqueue(s.id, elapsed === Infinity && !this.d.lastPollAt(s.id) ? 'first' : 'scheduled');
    }
    this.kick();
  }

  /** After a wake or when the network returns: overdue sources only, by wall-clock time. */
  catchUp(reason: 'wake' | 'reconnect') {
    const settings = this.d.settings();
    if (!settings) return;
    for (const s of this.d.sources()) {
      const interval = this.intervalMs(s.id, settings);
      if (interval !== undefined && this.wallElapsedMs(s.id) >= interval) this.enqueue(s.id, reason);
    }
    this.kick();
  }

  /** "Poll now" (FR-2.6): every enabled source, or the ones named. */
  request(reason: PollReason, ids?: SourceId[]) {
    for (const s of this.d.sources()) if (!ids || ids.includes(s.id)) this.enqueue(s.id, reason);
    this.kick();
  }

  /** Resolves when nothing is queued or running. */
  async idle() {
    while (this.running) await this.running;
  }

  private enqueue(id: SourceId, reason: PollReason) {
    if (this.current?.id === id) return;
    const queued = this.queue.find((q) => q.id === id);
    // A manual or catch-up reason says more than "scheduled"; keep the more telling one.
    if (queued) {
      if (queued.reason === 'scheduled') queued.reason = reason;
      return;
    }
    this.queue.push({ id, reason });
  }

  private kick() {
    this.running ??= this.drain().finally(() => (this.running = undefined));
  }

  private async drain() {
    const order = this.d.sources().map((s) => s.id);
    while (this.queue.length) {
      this.queue.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
      const next = this.queue.shift()!;
      const source = this.d.sources().find((s) => s.id === next.id);
      if (!source || !this.d.canPoll(source)) continue;
      this.current = next;
      try {
        await this.d.poll(source, next.reason);
      } catch (err) {
        this.d.onError?.(next.id, err);
      } finally {
        // Counted from the attempt, success or not: the breaker decides when to try again.
        this.lastMono.set(next.id, this.d.clock.mono());
        this.current = undefined;
      }
    }
  }
}
