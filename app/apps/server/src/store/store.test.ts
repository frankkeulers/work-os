import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventDraft, WorkEvent } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { paths } from '../config/dataDir';
import { writeFileAtomic } from './atomic';
import { EventLog, EventLogError } from './eventLog';
import { JsonlAppender } from './jsonl';
import { readLog, removeStaleTmp } from './recover';
import { loadSnapshot } from './snapshot';
import { SNAPSHOT_EVERY_EVENTS, SNAPSHOT_IDLE_MS, Store, rebuildState } from './store';

let dir: string;
let events: string;
let clock: Date;
const now = () => clock;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workos-store-'));
  events = paths(dir).events;
  await mkdir(join(events, 'quarantine'), { recursive: true });
  await mkdir(join(dir, 'state'), { recursive: true });
  clock = new Date('2026-10-05T09:00:00.000Z');
});
afterEach(async () => {
  await chmod(events, 0o700).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const ITEM = 'slack:C1:1791189720.000100';
const upsert = (revision = 1, itemId = ITEM): EventDraft => ({
  type: 'item.upserted',
  itemId,
  data: {
    source: 'slack',
    kind: 'thread',
    title: '#product',
    permalink: 'https://example.slack.com/archives/C1/p1',
    participants: [],
    lastActivityAt: '2026-10-05T08:50:00.000Z',
    revision,
    messageCount: revision,
    fromMeOnly: false,
  },
});
const done = (itemId = ITEM): EventDraft => ({ type: 'item.done', itemId, data: undefined });
const lines = async (file: string) => (await readFile(join(events, file), 'utf8')).split('\n').filter(Boolean);
const seqs = async (file: string) => (await lines(file)).map((l) => (JSON.parse(l) as WorkEvent).seq);

describe('JsonlAppender', () => {
  it('commits lines queued together in one write and one sync', async () => {
    const syncs: number[] = [];
    const a = new JsonlAppender({ onSync: (_f, _b, n) => syncs.push(n) });
    const file = join(dir, 'x.jsonl');
    await Promise.all(Array.from({ length: 100 }, (_, i) => a.append(file, [`{"n":${i}}`])));
    expect(syncs).toEqual([100]);
    // While a batch is syncing, new lines wait for the next one.
    const first = a.append(file, ['{"n":100}']);
    await Promise.resolve();
    const later = Promise.all([a.append(file, ['{"n":101}']), a.append(file, ['{"n":102}'])]);
    await Promise.all([first, later]);
    expect(syncs.slice(1)).toEqual([1, 2]);
    expect((await readFile(file, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l).n)).toEqual(Array.from({ length: 103 }, (_, i) => i));
    await a.close();
  });
});

describe('EventLog', () => {
  it('numbers events without gaps across calls and batches', async () => {
    const log = new EventLog(events, 0, undefined, now);
    const results = await Promise.all([log.append([upsert()]), log.append([done(), upsert(2)]), log.append([done()])]);
    expect(results.flatMap((r) => r.events.map((e) => e.seq))).toEqual([1, 2, 3, 4]);
    expect(await seqs('2026-10-05.jsonl')).toEqual([1, 2, 3, 4]);
    expect(log.lastSeq).toBe(4);
    await log.close();
  });

  it('writes one file per UTC day and never moves back to an earlier file', async () => {
    const log = new EventLog(events, 0, undefined, now);
    await log.append([upsert()]);
    clock = new Date('2026-10-06T00:00:01.000Z');
    await log.append([done()]);
    clock = new Date('2026-10-05T23:59:00.000Z'); // the clock went back past midnight
    await log.append([upsert(2)]);
    expect(await seqs('2026-10-05.jsonl')).toEqual([1]);
    expect(await seqs('2026-10-06.jsonl')).toEqual([2, 3]);
    await log.close();
  });

  it('rejects an invalid event without using up its seq', async () => {
    const log = new EventLog(events, 0, undefined, now);
    await expect(log.append([{ type: 'item.snoozed', itemId: ITEM, data: { until: 'tomorrow' } }])).rejects.toThrow(EventLogError);
    expect((await log.append([done()])).events[0].seq).toBe(1);
    await log.close();
  });

  it('reuses the seqs of a failed write, so the log keeps no gap', async () => {
    const log = new EventLog(events, 0, undefined, now);
    await log.append([upsert()]);
    await log.close();
    await chmod(join(events, '2026-10-05.jsonl'), 0o400); // the write fails
    const failed = await Promise.allSettled([log.append([done()]), log.append([upsert(2)])]);
    expect(failed.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    await chmod(join(events, '2026-10-05.jsonl'), 0o600);
    expect((await log.append([done()])).events[0].seq).toBe(2);
    expect(await seqs('2026-10-05.jsonl')).toEqual([1, 2]);
    await log.close();
  });
});

describe('recovery', () => {
  const event = (seq: number, type = 'item.done') => JSON.stringify({ seq, id: `ev-${seq}`, at: '2026-10-05T09:00:00.000Z', itemId: ITEM, type, schemaVersion: 1 });
  const read = (opts: { afterSeq?: number; repair?: boolean } = {}) => {
    const seen: number[] = [];
    return readLog(events, { afterSeq: opts.afterSeq ?? 0, repair: opts.repair ?? true, onEvent: (e) => seen.push(e.seq), now }).then((r) => ({ ...r, seen }));
  };

  it('cuts off a torn last line and keeps it in quarantine', async () => {
    await writeFile(join(events, '2026-10-05.jsonl'), `${event(1)}\n${event(2)}\n{"seq":3,"id":"ev-3","at":"2026-10`);
    const r = await read();
    expect(r.seen).toEqual([1, 2]);
    expect(r.torn).toEqual([{ file: '2026-10-05.jsonl', bytes: 34 }]);
    expect(await seqs('2026-10-05.jsonl')).toEqual([1, 2]);
    const q = await readdir(join(events, 'quarantine'));
    expect(q).toHaveLength(1);
    expect(await readFile(join(events, 'quarantine', q[0]), 'utf8')).toBe('{"seq":3,"id":"ev-3","at":"2026-10');
    // Once repaired, the next read finds nothing to fix.
    expect((await read()).torn).toEqual([]);
  });

  it('moves unreadable and duplicate lines aside and reports gaps', async () => {
    await writeFile(join(events, '2026-10-05.jsonl'), [event(1), 'garbage', event(2), event(2), event(5), JSON.stringify({ seq: 6, type: 'item.deleted' })].map((l) => `${l}\n`).join(''));
    const r = await read();
    expect(r.seen).toEqual([1, 2, 5]);
    expect(r.quarantined.map((q) => [q.line, q.reason.split(' ')[0]])).toEqual([
      [2, 'not'],
      [4, 'duplicate'],
      [6, 'invalid'],
    ]);
    expect(r.gaps).toEqual([{ from: 3, to: 4 }]);
    expect(await seqs('2026-10-05.jsonl')).toEqual([1, 2, 5]);
  });

  it('leaves the files alone when only inspecting', async () => {
    const raw = `${event(1)}\ngarbage\n${event(2)}\n{"torn`;
    await writeFile(join(events, '2026-10-05.jsonl'), raw);
    const r = await read({ repair: false });
    expect(r.seen).toEqual([1, 2]);
    expect(await readFile(join(events, '2026-10-05.jsonl'), 'utf8')).toBe(raw);
  });

  it('deletes tmp files left by an interrupted write, but not ones being written now', async () => {
    const old = join(dir, 'state', '.snapshot.json.123.abcd.tmp');
    const fresh = join(dir, 'state', '.lock.456.ef01.tmp');
    await writeFile(old, 'x');
    await writeFile(fresh, 'x');
    const hourAgo = new Date(Date.now() - 3600_000);
    await utimes(old, hourAgo, hourAgo);
    expect(await removeStaleTmp(dir)).toEqual(['state/.snapshot.json.123.abcd.tmp']);
    await expect(stat(fresh)).resolves.toBeTruthy();
  });
});

describe('Store', () => {
  const open = () => Store.open({ dataDir: dir, now });

  it('applies events once they are synced, and replays them after a restart', async () => {
    const { store, recovery } = await open();
    expect(recovery).toMatchObject({ fromSnapshot: false, snapshot: 'missing', replayed: 0 });
    const seen: number[] = [];
    store.subscribe((es) => seen.push(...es.map((e) => e.seq)));
    await store.append(upsert(), done());
    expect(store.projection.items[ITEM]).toMatchObject({ status: 'done', doneAt: clock.toISOString() });
    expect(seen).toEqual([1, 2]);
    // A crash: no snapshot was written, so the next start replays the log.
    const again = await open();
    expect(again.recovery).toMatchObject({ fromSnapshot: false, replayed: 2 });
    expect(again.store.projection).toEqual(store.projection);
    await Promise.all([store.close(), again.store.close()]);
  });

  it('starts from the snapshot and replays only the tail', async () => {
    const { store } = await open();
    await store.append(upsert(), done());
    await store.close();
    const second = await open();
    expect(second.recovery).toMatchObject({ fromSnapshot: true, replayed: 0 });
    await second.store.append({ type: 'item.reopened', itemId: ITEM, data: undefined });
    await second.store.close();
    const third = await open();
    expect(third.recovery.fromSnapshot).toBe(true);
    expect(third.store.projection.items[ITEM].status).toBe('open');
    expect(third.store.lastSeq).toBe(3);
  });

  it('rebuilds from the log when the snapshot is corrupt, and says so (Story 1.1)', async () => {
    const { store } = await open();
    await store.append(upsert(), done());
    await store.close();
    await writeFile(paths(dir).snapshot, '{"schemaVersion":1,');
    const { store: rebuilt, recovery } = await open();
    expect(recovery).toMatchObject({ fromSnapshot: false, snapshot: 'corrupt', replayed: 2 });
    expect(recovery.rebuiltNotice).toMatch(/rebuilt from 2 events/);
    expect(rebuilt.projection.items[ITEM].status).toBe('done');
    expect((await loadSnapshot(paths(dir).snapshot)).ok).toBe(true); // saved again straight away
  });

  it('replays everything when the projection version changed, without a notice', async () => {
    const { store } = await open();
    await store.append(upsert());
    await store.close();
    const snap = JSON.parse(await readFile(paths(dir).snapshot, 'utf8'));
    await writeFileAtomic(paths(dir).snapshot, JSON.stringify({ ...snap, projectionVersion: 0 }));
    const { recovery } = await open();
    expect(recovery).toMatchObject({ snapshot: 'version', replayed: 1 });
    expect(recovery.rebuiltNotice).toBeUndefined();
  });

  it('distrusts a snapshot that is ahead of the log', async () => {
    const { store } = await open();
    await store.append(upsert(), done());
    await store.close();
    await writeFile(join(events, '2026-10-05.jsonl'), (await lines('2026-10-05.jsonl')).slice(0, 1).map((l) => `${l}\n`).join(''));
    const { store: s, recovery } = await open();
    expect(recovery.snapshot).toBe('ahead');
    expect(s.projection.items[ITEM].status).toBe('open');
  });

  it('snapshots after 200 events, or once things have been quiet for 30 s', async () => {
    const { store } = await open();
    expect(store.snapshotDue()).toBe(false);
    await store.append(upsert());
    expect(store.snapshotDue()).toBe(false);
    expect(store.snapshotDue(clock.getTime() + SNAPSHOT_IDLE_MS)).toBe(true);
    await store.append(...Array.from({ length: SNAPSHOT_EVERY_EVENTS }, () => done()));
    expect(store.snapshotDue()).toBe(true);
    await store.snapshot();
    expect(store.snapshotDue(clock.getTime() + SNAPSHOT_IDLE_MS)).toBe(false);
    await store.close();
  });

  it('rebuild-state gives the same state as the running store', async () => {
    const { store } = await open();
    for (let i = 1; i <= 20; i++) {
      const id = `slack:C1:${i}`;
      await store.append(upsert(1, id));
      if (i % 3 === 0) await store.append(done(id));
      if (i % 4 === 0) await store.append({ type: 'item.snoozed', itemId: id, data: { until: '2026-10-06T08:00:00.000Z' } });
      clock = new Date(clock.getTime() + 3 * 3600_000); // crosses midnight: several files
    }
    await store.close();
    await appendFile(join(events, (await readdir(events)).filter((f) => f.endsWith('.jsonl')).pop()!), '{"torn');
    const { state, log } = await rebuildState(dir, now);
    expect(log.files).toBeGreaterThan(1);
    expect(log.torn).toHaveLength(1);
    expect(state).toEqual(store.projection);
  });
});
