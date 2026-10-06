import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item, Settings } from '@work-os/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../config/defaults';
import { DraftStore } from './drafts';
import { ItemFiles } from './items';
import { cutLog, RetentionJob, runRetention } from './retention';
import { Store } from './store';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-06T02:30:00Z'); // 03:30 London

let dir: string;
let store: Store;
let items: ItemFiles;
let drafts: DraftStore;
let settings: Settings;
let now: number;

const iso = (ms: number) => new Date(ms).toISOString();

async function addItem(id: string, lastActivity: number) {
  const item: Item = {
    id,
    source: 'slack',
    kind: 'thread',
    title: '#product',
    permalink: 'https://example.slack.com/archives/C1/p1',
    participants: [{ id: 'U1', name: 'Dana Lee' }],
    messages: [{ id: 'm1', authorId: 'U1', ts: iso(lastActivity), text: 'Synthetic text' }],
    messageCount: 1,
    lastActivityAt: iso(lastActivity),
    revision: 1,
    schemaVersion: 1,
  };
  await items.write({ schemaVersion: 1, item });
  const { messages: _, schemaVersion: __, id: ___, ...meta } = item;
  await store.append({ type: 'item.upserted', itemId: id, data: { ...meta, fromMeOnly: false } });
}

const deps = () => ({ dataDir: dir, store, items, drafts, settings: () => settings, now: () => new Date(now) });
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workos-ret-'));
  await mkdir(join(dir, 'events/quarantine'), { recursive: true });
  await mkdir(join(dir, 'state'), { recursive: true });
  await mkdir(join(dir, 'drafts'), { recursive: true });
  store = (await Store.open({ dataDir: dir, now: () => new Date(now) })).store;
  items = new ItemFiles(join(dir, 'items'));
  drafts = new DraftStore(join(dir, 'drafts'));
  settings = defaultSettings(dir);
  now = NOW;
});

describe('retention (FR-12.1)', () => {
  it('removes item files, finished drafts, sandbox files and app logs past retentionDays', async () => {
    await addItem('slack:C1:old', NOW - 31 * DAY);
    await addItem('slack:C1:new', NOW - 29 * DAY);
    // A finished action on the old item, and one still waiting for Frank.
    for (const [id, last] of [
      ['act-done', 'action.executed'],
      ['act-ready', 'action.drafted'],
    ] as const) {
      await store.append({ type: 'action.requested', itemId: 'slack:C1:old', actionId: id, data: { type: 'vault_note', revision: 1 } });
      if (last === 'action.drafted')
        await store.append({ type: last, itemId: 'slack:C1:old', actionId: id, data: { type: 'vault_note', revision: 1, draftRef: `drafts/${id}.json`, tokens: 1, target: { path: 'a.md' } } });
      else await store.append({ type: last, itemId: 'slack:C1:old', actionId: id, data: { dryRun: true } });
      await drafts.update(id, 'slack:C1:old', (s) => s);
    }
    now = NOW + 31 * DAY; // the actions were updated at NOW, 31 days before
    await addItem('slack:C1:today', now - DAY); // keeps 'new' company
    const sandbox = join(dir, 'sandbox/vault/Inbox');
    await mkdir(sandbox, { recursive: true });
    await writeFile(join(sandbox, 'old.md'), 'old note');
    await writeFile(join(sandbox, 'new.md'), 'new note');
    await utimes(join(sandbox, 'old.md'), new Date(now - 40 * DAY), new Date(now - 40 * DAY));
    await utimes(join(sandbox, 'new.md'), new Date(now - DAY), new Date(now - DAY));
    await mkdir(join(dir, 'logs'), { recursive: true });
    await writeFile(join(dir, 'logs/app-2026-09-01.log'), '{}\n');
    await writeFile(join(dir, 'logs/app-2026-11-05.log'), '{}\n');
    await writeFile(join(dir, 'logs/usage-2026-09-01.jsonl'), '{}\n');

    const r = await runRetention(deps());
    // 'new' is now 60 days old too; 'today' stays.
    expect(r).toMatchObject({ items: 2, drafts: 1, sandboxFiles: 1, appLogs: 1 });
    expect(await items.read('slack', 'slack:C1:old')).toBeUndefined();
    expect(await items.read('slack', 'slack:C1:today')).toBeDefined();
    expect(await drafts.read('act-done')).toBeUndefined();
    expect(await drafts.read('act-ready')).toBeDefined(); // not finished: Frank hasn't decided
    expect(await exists(join(sandbox, 'old.md'))).toBe(false);
    expect(await exists(join(sandbox, 'new.md'))).toBe(true);
    expect(await exists(join(dir, 'logs/app-2026-09-01.log'))).toBe(false);
    expect(await exists(join(dir, 'logs/app-2026-11-05.log'))).toBe(true);
    expect(await exists(join(dir, 'logs/usage-2026-09-01.jsonl'))).toBe(true); // no message text; budgets read it
    // Events stay: the item is still in the inbox, as expired.
    expect(store.projection.items['slack:C1:old']).toBeDefined();
    // A second run finds nothing more.
    expect(await runRetention(deps())).toMatchObject({ items: 0, drafts: 0, sandboxFiles: 0, appLogs: 0 });
  });

  it('keeps an old thread that a poll has just brought back to life', async () => {
    await addItem('slack:C1:old', NOW - 40 * DAY);
    // A poll merged a new reply into the file; its event isn't in the log yet.
    await items.update('slack', 'slack:C1:old', (s) => ({ ...s!, item: { ...s!.item, lastActivityAt: iso(NOW), revision: 2 } }));
    expect((await runRetention(deps())).items).toBe(0);
    expect(await items.read('slack', 'slack:C1:old')).toBeDefined();
  });

  it('runs once a day, from the first tick after 03:00, and remembers across restarts', async () => {
    await addItem('slack:C1:old', NOW - 40 * DAY);
    now = Date.parse('2026-10-06T01:00:00Z'); // 02:00 London
    expect(await new RetentionJob(deps()).tick()).toBeUndefined();
    now = NOW;
    const job = new RetentionJob(deps());
    expect((await job.tick())?.items).toBe(1);
    expect(await job.tick()).toBeUndefined();
    expect(JSON.parse(await readFile(join(dir, 'state/retention.json'), 'utf8'))).toMatchObject({ lastDay: '2026-10-06' });
    expect(await new RetentionJob(deps()).tick()).toBeUndefined(); // a restart the same day
    now = NOW + 2 * DAY + 6 * 3600_000; // asleep through the next 03:00: runs on waking
    expect(await new RetentionJob(deps()).tick()).toBeDefined();
  });

  it('cuts a launchd log to its last whole lines once it is too big', async () => {
    const p = join(dir, 'launchd.err.log');
    const lines = Array.from({ length: 200 }, (_, i) => `line ${String(i).padStart(3, '0')} ${'x'.repeat(40)}`).join('\n') + '\n';
    await writeFile(p, lines);
    expect(await cutLog(p, 100_000, 1000)).toBe(false);
    expect(await cutLog(p, 5000, 1000)).toBe(true);
    const out = await readFile(p, 'utf8');
    expect(out).toMatch(/^\[cut by retention at .*\]\nline 1\d\d x+\n/);
    expect(out.endsWith('line 199 ' + 'x'.repeat(40) + '\n')).toBe(true);
    expect(out.length).toBeLessThan(1100);
  });
});
