import { emptyProjection, reduce, type EventDraft, type Projection, type WorkEvent } from '@work-os/shared';
import { paths } from '../config/dataDir';
import type { Logger } from '../log';
import { EventLog } from './eventLog';
import type { AppenderHooks } from './jsonl';
import { readLog, removeStaleTmp, type LogReport } from './recover';
import { loadSnapshot, saveSnapshot, serialiseSnapshot } from './snapshot';

// The store: the event log plus the projection it replays to, held in memory (PLAN.md §4.3).
// Events are applied to the projection only after they are synced, so the in-memory state never
// shows something a crash could lose.

export const SNAPSHOT_EVERY_EVENTS = 200;
export const SNAPSHOT_IDLE_MS = 30_000;

export interface RecoveryReport {
  fromSnapshot: boolean;
  snapshot: 'ok' | 'missing' | 'corrupt' | 'version' | 'ahead';
  replayed: number;
  log: LogReport;
  tmpRemoved: string[];
  ms: number;
  /** Shown to Frank when the inbox was rebuilt because the snapshot was unusable (Story 1.1). */
  rebuiltNotice?: string;
}

export interface StoreOptions {
  dataDir: string;
  logger?: Logger;
  now?: () => Date;
  hooks?: AppenderHooks;
}

/** Applies a replayed event, accepting a gap the reader has already reported. */
function replayInto(p: Projection, e: WorkEvent) {
  if (e.seq > p.lastSeq + 1) p.lastSeq = e.seq - 1;
  reduce(p, e);
}

export class Store {
  private eventsSinceSnapshot = 0;
  private lastAppendMs = 0;
  private listeners = new Set<(events: WorkEvent[]) => void>();
  private snapshotting?: Promise<void>;
  private appliedFile?: string; // the file holding the last applied event: the snapshot replays from here

  private constructor(
    readonly projection: Projection,
    private readonly log: EventLog,
    private readonly opts: Required<Pick<StoreOptions, 'dataDir' | 'now'>> & StoreOptions,
  ) {}

  static async open(opts: StoreOptions): Promise<{ store: Store; recovery: RecoveryReport }> {
    const now = opts.now ?? (() => new Date());
    const t0 = performance.now();
    const p = paths(opts.dataDir);
    const tmpRemoved = await removeStaleTmp(opts.dataDir, now());

    const snap = await loadSnapshot(p.snapshot);
    let state = snap.ok ? snap.snapshot.state : emptyProjection();
    let status: RecoveryReport['snapshot'] = snap.ok ? 'ok' : snap.reason;
    let log = await readLog(p.events, {
      fromFile: snap.ok ? snap.snapshot.lastFile : undefined,
      afterSeq: snap.ok ? snap.snapshot.lastSeq : 0,
      repair: true,
      onEvent: (e) => replayInto(state, e),
      now,
    });
    // A snapshot that covers events the log doesn't have can't be trusted.
    if (snap.ok && log.highestSeq < snap.snapshot.lastSeq) {
      status = 'ahead';
      state = emptyProjection();
      log = await readLog(p.events, { afterSeq: 0, repair: true, onEvent: (e) => replayInto(state, e), now });
    }
    const fromSnapshot = status === 'ok';

    const eventLog = new EventLog(p.events, log.lastSeq, log.lastFile, now, opts.hooks);
    const store = new Store(state, eventLog, { ...opts, now });
    store.appliedFile = log.lastFile;
    const recovery: RecoveryReport = {
      fromSnapshot,
      snapshot: status,
      replayed: log.events,
      log,
      tmpRemoved,
      ms: Math.round(performance.now() - t0),
    };
    if (status === 'corrupt' || status === 'ahead') {
      const at = now().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      recovery.rebuiltNotice = `Inbox state rebuilt from ${log.events.toLocaleString('en-GB')} events at ${at}: snapshot.json was unusable. Nothing was lost.`;
    }
    const l = opts.logger;
    if (l) {
      const repairs = { torn: log.torn, quarantined: log.quarantined, gaps: log.gaps, tmpRemoved };
      if (log.torn.length || log.quarantined.length || log.gaps.length) l.warn(repairs, 'Event log repaired at startup');
      if (status !== 'ok' && status !== 'missing') l.warn({ snapshot: status }, 'Snapshot unusable: replayed the whole log');
      l.info({ fromSnapshot, replayed: log.events, lastSeq: log.lastSeq, ms: recovery.ms }, 'Store opened');
    }
    // Save straight away after a full replay, so the next start is fast.
    if (!fromSnapshot && log.events > 0) await store.snapshot();
    return { store, recovery };
  }

  get lastSeq() {
    return this.projection.lastSeq;
  }

  /** Called with each batch of events once they are synced and applied. */
  subscribe(fn: (events: WorkEvent[]) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Appends events and applies them. Resolves once they are on disk (NF-6). */
  async append(...drafts: EventDraft[]): Promise<WorkEvent[]> {
    const { events, file } = await this.log.append(drafts);
    for (const e of events) reduce(this.projection, e);
    if (file) this.appliedFile = file;
    this.eventsSinceSnapshot += events.length;
    this.lastAppendMs = this.opts.now().getTime();
    for (const fn of this.listeners) fn(events);
    return events;
  }

  /** After 200 events, or 30 s after the last event once things are quiet. */
  snapshotDue(nowMs = this.opts.now().getTime()) {
    if (this.eventsSinceSnapshot === 0) return false;
    return this.eventsSinceSnapshot >= SNAPSHOT_EVERY_EVENTS || nowMs - this.lastAppendMs >= SNAPSHOT_IDLE_MS;
  }

  /** Writes snapshot.json. Concurrent calls share one write. */
  snapshot(): Promise<void> {
    this.snapshotting ??= (async () => {
      try {
        const covered = this.eventsSinceSnapshot;
        const data = serialiseSnapshot(this.projection, this.appliedFile, this.opts.now());
        await saveSnapshot(paths(this.opts.dataDir).snapshot, data);
        this.eventsSinceSnapshot -= covered;
      } finally {
        this.snapshotting = undefined;
      }
    })();
    return this.snapshotting;
  }

  /** Waits for pending writes, then saves a snapshot (SIGTERM). */
  async close() {
    await this.log.flushed();
    await this.snapshot();
    await this.log.close();
  }
}

/** Rebuilds the projection from the whole log and saves the snapshot (`npm run rebuild-state`). */
export async function rebuildState(dataDir: string, now: () => Date = () => new Date()) {
  const t0 = performance.now();
  const state = emptyProjection();
  const log = await readLog(paths(dataDir).events, { afterSeq: 0, repair: true, onEvent: (e) => replayInto(state, e), now });
  await saveSnapshot(paths(dataDir).snapshot, serialiseSnapshot(state, log.lastFile, now()));
  return { state, log, ms: Math.round(performance.now() - t0) };
}
