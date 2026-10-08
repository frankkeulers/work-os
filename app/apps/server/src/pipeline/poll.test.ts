import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item, Message, WorkEvent } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDataDir, paths } from '../config/dataDir';
import { DEFAULT_RULES, defaultSettings } from '../config/defaults';
import type { FetchResult, SourceAdapter } from '../sources/types';
import { ItemFiles } from '../store/items';
import { readLog } from '../store/recover';
import { Store } from '../store/store';
import { cmpCursor, CursorFile } from './cursors';
import { returnSnoozed } from './due';
import { mergeItem, pollSource, type PollDeps } from './poll';

const NOW = new Date('2026-10-06T09:00:00.000Z');
const ID = 'slack:C1:1791270000.000100';

const msg = (id: string, minsAgo: number, authorId = 'U2'): Message => ({ id, authorId, ts: new Date(NOW.getTime() - minsAgo * 60_000).toISOString(), text: `text ${id}` });
const item = (messages: Message[], over: Partial<Item> = {}): Item => ({
  id: ID,
  source: 'slack',
  kind: 'thread',
  title: '#product',
  permalink: 'https://polestar.slack.com/archives/C1/p1791270000000100',
  participants: [...new Set(messages.map((m) => m.authorId))].map((id) => ({ id, name: id })),
  messages,
  messageCount: messages.length,
  lastActivityAt: messages.at(-1)!.ts,
  revision: 1,
  schemaVersion: 1,
  ...over,
});

let dir: string;
let store: Store;
let d: PollDeps;
let next: FetchResult;
const fetchedWith: (string | undefined)[] = [];

const source: SourceAdapter = {
  id: 'slack',
  deps: ['network', 'slack'],
  needsNetwork: true,
  fetchSince: async (cursor) => {
    fetchedWith.push(cursor);
    return structuredClone(next);
  },
  probe: async () => 'ok',
  identity: () => ({ id: 'UFRANK' }),
};
const signal = () => new AbortController().signal;

async function events(): Promise<WorkEvent[]> {
  const out: WorkEvent[] = [];
  await readLog(paths(dir).events, { afterSeq: 0, repair: false, onEvent: (e) => void out.push(e) });
  return out;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workos-poll-'));
  await initDataDir(dir, { settings: defaultSettings(dir), rules: DEFAULT_RULES });
  ({ store } = await Store.open({ dataDir: dir, now: () => NOW }));
  d = { store, items: new ItemFiles(join(dir, 'items')), cursors: await CursorFile.open(paths(dir).cursors), now: () => NOW };
  fetchedWith.length = 0;
});
afterEach(async () => {
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

describe('mergeItem', () => {
  it('unions messages by ID and moves the revision only for new ones', () => {
    const a = item([msg('1', 30), msg('2', 20)]);
    expect(mergeItem(undefined, a, undefined)).toMatchObject({ newIds: ['1', '2'], item: { revision: 1 } });
    const same = mergeItem(a, item([msg('2', 20)]), 1);
    expect(same.newIds).toEqual([]);
    expect(same.item.messages.map((m) => m.id)).toEqual(['1', '2']); // the overlap keeps older messages
    expect(same.item.revision).toBe(1);
    const more = mergeItem(a, item([msg('2', 20), msg('3', 5, 'U3')]), 1);
    expect(more).toMatchObject({ newIds: ['3'], item: { revision: 2, messageCount: 3, lastActivityAt: msg('3', 5).ts } });
    expect(more.item.participants.map((p) => p.id)).toEqual(['U2', 'U3']);
  });

  it('moves the revision when a message stored empty gets its text, so it is triaged again', () => {
    const empty = item([{ ...msg('1', 30), text: '' }]);
    expect(mergeItem(empty, item([msg('1', 30)]), 1)).toMatchObject({ newIds: [], item: { revision: 2, messages: [{ text: 'text 1' }] } });
  });

  it('takes an edited message’s new text', () => {
    const edited = mergeItem(item([msg('1', 30)]), item([{ ...msg('1', 30), text: 'fixed typo' }]), 1);
    expect(edited.item.messages[0].text).toBe('fixed typo');
    expect(edited.newIds).toEqual([]);
  });
});

describe('pollSource (FR-2.8)', () => {
  it('writes the item file, then the events, then the cursor', async () => {
    next = { items: [item([msg('1', 30), msg('2', 20)])], nextCursor: '1791277000.000100' };
    const stats = await pollSource(d, source, 'first', signal());
    expect(stats).toMatchObject({ fetched: 1, changed: 1, cursor: '1791277000.000100' });
    expect((await d.items.read('slack', ID))?.item.messages).toHaveLength(2);
    const log = await events();
    expect(log.map((e) => e.type)).toEqual(['item.upserted', 'source.polled']);
    expect(log[0]).toMatchObject({ itemId: ID, data: { revision: 1, messageCount: 2, fromMeOnly: false } });
    expect(log[0].data).not.toHaveProperty('messages'); // message text never goes in the log
    expect(JSON.stringify(log)).not.toContain('text 1');
    expect(log[1]).toMatchObject({ data: { source: 'slack', reason: 'first', fetched: 1, cursor: '1791277000.000100' } });
    expect(JSON.parse(await readFile(paths(dir).cursors, 'utf8')).cursors.slack).toBe('1791277000.000100');
    expect(store.projection.items[ID]).toMatchObject({ revision: 1, status: 'open' });
  });

  it('changes nothing when the same messages come back (overlap, replay)', async () => {
    next = { items: [item([msg('1', 30), msg('2', 20)])], nextCursor: '5' };
    await pollSource(d, source, 'first', signal());
    const again = await pollSource(d, source, 'scheduled', signal());
    expect(again.changed).toBe(0);
    expect((await events()).map((e) => e.type)).toEqual(['item.upserted', 'source.polled', 'source.polled']);
    expect(store.projection.items[ID].revision).toBe(1);
    expect(fetchedWith).toEqual([undefined, '5']);
  });

  it('bumps the revision for a new reply, and marks Frank’s own replies as needing no triage', async () => {
    next = { items: [item([msg('1', 30)])], nextCursor: '5' };
    await pollSource(d, source, 'first', signal());
    next = { items: [item([msg('1', 30), msg('2', 10, 'UFRANK')])], nextCursor: '6' };
    await pollSource(d, source, 'scheduled', signal());
    expect(store.projection.items[ID]).toMatchObject({ revision: 2, newReplies: false }); // only Frank's own reply
    next = { items: [item([msg('3', 5)])], nextCursor: '7' };
    await pollSource(d, source, 'scheduled', signal());
    const ups = (await events()).filter((e) => e.type === 'item.upserted');
    expect(ups.map((e) => [e.data.revision, e.data.fromMeOnly])).toEqual([
      [1, false],
      [2, true],
      [3, false],
    ]);
    expect((await d.items.read('slack', ID))?.item.messages.map((m) => m.id)).toEqual(['1', '2', '3']);
    expect(store.projection.items[ID]).toMatchObject({ revision: 3, newReplies: true, triageState: 'pending' });
  });

  it('keeps the decision’s text when an item gets new messages', async () => {
    next = { items: [item([msg('1', 30)])], nextCursor: '5' };
    await pollSource(d, source, 'first', signal());
    const stored = (await d.items.read('slack', ID))!;
    await d.items.write({ ...stored, text: { summary: 'Asks for a go/no-go', reason: 'VIP' } });
    next = { items: [item([msg('1', 30), msg('2', 3)])], nextCursor: '6' };
    await pollSource(d, source, 'scheduled', signal());
    expect((await d.items.read('slack', ID))?.text?.summary).toBe('Asks for a go/no-go');
  });

  it('recovers from a crash between the item file and the events', async () => {
    // The file was written, the process died before the append: the next poll logs the item.
    await d.items.write({ item: item([msg('1', 30)]), schemaVersion: 1 });
    next = { items: [item([msg('1', 30)])], nextCursor: '5' };
    await pollSource(d, source, 'scheduled', signal());
    expect((await events()).filter((e) => e.type === 'item.upserted')).toHaveLength(1);
    expect(store.projection.items[ID].revision).toBe(1);
  });

  it('recovers a new reply whose file was written but never logged', async () => {
    next = { items: [item([msg('1', 30)])], nextCursor: '5' };
    await pollSource(d, source, 'first', signal());
    // The reply reached the file as revision 2, then the process died before the append.
    await d.items.write({ item: item([msg('1', 30), msg('2', 10, 'UFRANK')], { revision: 2 }), schemaVersion: 1 });
    next = { items: [item([msg('1', 30), msg('2', 10, 'UFRANK')])], nextCursor: '6' };
    expect((await pollSource(d, source, 'scheduled', signal())).changed).toBe(1);
    const ups = (await events()).filter((e) => e.type === 'item.upserted');
    expect(ups.map((e) => [e.data.revision, e.data.fromMeOnly])).toEqual([
      [1, false],
      [2, false], // the author of what was lost is not known: triaged again
    ]);
    expect(store.projection.items[ID]).toMatchObject({ revision: 2, triageState: 'pending' });
  });

  it('uses the newer of cursors.json and the log', async () => {
    await store.append({ type: 'source.polled', data: { source: 'slack', reason: 'scheduled', fetched: 0, cursor: '1791277000.000200' } });
    await d.cursors.set('slack', '1791276000.000100'); // stale file
    next = { items: [], nextCursor: '1791277000.000200' };
    await pollSource(d, source, 'scheduled', signal());
    expect(fetchedWith[0]).toBe('1791277000.000200');
    const reopened = await CursorFile.open(paths(dir).cursors);
    expect(reopened.get('slack', undefined)).toBe('1791277000.000200');
    expect(reopened.get('slack', '1791278000.000000')).toBe('1791278000.000000');
  });

  it('compares text cursors as text, not as NaN (R2.7)', async () => {
    const older = '2026-10-06T08:55:10.118843Z|7d3f1a88-2b6c-4e09-b1f4-9e8a7c6d5b42';
    const newer = '2026-10-07T13:44:02.517309Z|0b9e7c2a-5f41-4d8e-9a6b-3c1d2e4f5a60';
    await d.cursors.set('wispr', older);
    expect(d.cursors.get('wispr', newer)).toBe(newer);
    await d.cursors.set('wispr', newer);
    expect(d.cursors.get('wispr', older)).toBe(newer);
    expect(cmpCursor('9.5', '10.1')).toBeLessThan(0); // Slack ts still compare as numbers
    expect(cmpCursor(newer, newer)).toBe(0);
  });

  it('writes nothing when the Mac slept mid-fetch', async () => {
    const sleep = new AbortController();
    next = { items: [item([msg('1', 30)])], nextCursor: '5' };
    const p = pollSource(d, { ...source, fetchSince: async () => (sleep.abort(new Error('sleep')), structuredClone(next)) }, 'scheduled', sleep.signal);
    await expect(p).rejects.toThrow('sleep');
    expect(await events()).toEqual([]);
    expect(await d.items.read('slack', ID)).toBeUndefined();
  });
});

describe('rules at ingest (FR-4, §5.3)', () => {
  const withRules = () => {
    const settings = defaultSettings(dir);
    settings.slack = { ...settings.slack, excludeChannels: ['#random'] };
    settings.people = { vips: ['U2'] };
    d.rules = () => ({ rules: DEFAULT_RULES, settings });
  };

  it('keeps a new thread in an excluded channel out altogether', async () => {
    withRules();
    next = { items: [item([msg('1', 30)], { title: '#random' })], nextCursor: '5' };
    const stats = await pollSource(d, source, 'first', signal());
    expect(stats).toMatchObject({ fetched: 1, changed: 0, dropped: 1 });
    expect((await events()).map((e) => e.type)).toEqual(['source.polled']);
    expect(store.projection.items[ID]).toBeUndefined();
    expect(await d.items.read('slack', ID)).toBeUndefined();
  });

  it('never drops an item it already has', async () => {
    next = { items: [item([msg('1', 30)], { title: '#random' })], nextCursor: '5' };
    await pollSource(d, source, 'first', signal());
    withRules();
    next = { items: [item([msg('1', 30), msg('2', 10)], { title: '#random' })], nextCursor: '6' };
    expect(await pollSource(d, source, 'scheduled', signal())).toMatchObject({ changed: 1, dropped: 0 });
    expect(store.projection.items[ID].revision).toBe(2);
  });

  it('decides a VIP DM at once, without the quiet window, and logs it with the upsert', async () => {
    withRules();
    next = { items: [item([msg('1', 1)], { kind: 'dm', title: 'U2' })], nextCursor: '5' };
    expect(await pollSource(d, source, 'first', signal())).toMatchObject({ changed: 1, ruleDecided: 1 });
    const log = await events();
    expect(log.map((e) => e.type)).toEqual(['item.upserted', 'triage.decided', 'source.polled']);
    expect(log[1]).toMatchObject({ itemId: ID, data: { decision: { itemRevision: 1, attention: 'now', decidedBy: 'rule', ruleId: 'vip-dm', confluence: { suggested: false }, vault: { suggested: false } } } });
    expect(store.projection.items[ID]).toMatchObject({ triageState: 'triaged', decision: { attention: 'now' } });
    expect((await d.items.read('slack', ID))?.text).toEqual({ summary: 'text 1', reason: 'Rule “vip-dm” sets Now without asking the model.' });

    // Frank's own reply needs no decision; a new one from the VIP gets one for the new revision.
    next = { items: [item([msg('1', 1), msg('2', 0.5, 'UFRANK')], { kind: 'dm', title: 'U2' })], nextCursor: '6' };
    expect(await pollSource(d, source, 'scheduled', signal())).toMatchObject({ ruleDecided: 0 });
    next = { items: [item([msg('1', 1), msg('2', 0.5, 'UFRANK'), msg('3', 0.2)], { kind: 'dm', title: 'U2' })], nextCursor: '7' };
    expect(await pollSource(d, source, 'scheduled', signal())).toMatchObject({ ruleDecided: 1 });
    expect(store.projection.items[ID]).toMatchObject({ revision: 3, triageState: 'triaged', decision: { itemRevision: 3 } });
  });

  it('leaves "send to the model" items waiting for triage', async () => {
    withRules();
    next = { items: [item([{ ...msg('1', 30), text: 'Can <@UFRANK> confirm the ETA?' }])], nextCursor: '5' };
    expect(await pollSource(d, source, 'first', signal())).toMatchObject({ changed: 1, ruleDecided: 0 });
    expect(store.projection.items[ID]).toMatchObject({ triageState: 'pending' });
  });
});

describe('snooze return (FR-8.3)', () => {
  it('brings snoozed items back once their time has passed, once', async () => {
    next = { items: [item([msg('1', 30)])], nextCursor: '5' };
    await pollSource(d, source, 'first', signal());
    await store.append({ type: 'item.snoozed', itemId: ID, data: { until: '2026-10-06T10:00:00.000Z' } });
    expect(await returnSnoozed(store, new Date('2026-10-06T09:59:59.000Z'))).toBe(0);
    expect(await returnSnoozed(store, new Date('2026-10-06T10:00:00.000Z'))).toBe(1);
    expect(store.projection.items[ID]).toMatchObject({ status: 'open', backFromSnooze: true });
    expect(await returnSnoozed(store, new Date('2026-10-06T11:00:00.000Z'))).toBe(0);
  });
});
