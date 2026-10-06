import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ItemFiles } from '../store/items';
import { Store } from '../store/store';
import { generate, SYNTHETIC_MARKER, targetProblem } from './genData';

const NOW = new Date('2026-10-06T12:00:00.000Z');
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workos-gen-test-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('gen-data (NF-11)', () => {
  it('writes a data directory the store opens: items, decisions, dones, polls', async () => {
    const data = join(dir, 'data');
    const r = await generate(data, { days: 4, itemsPerDay: 6, now: NOW });
    expect(r.items).toBeGreaterThan(15);
    const { store, recovery } = await Store.open({ dataDir: data, now: () => NOW });
    try {
      expect(recovery.fromSnapshot).toBe(true);
      expect(store.lastSeq).toBe(r.events);
      const items = Object.values(store.projection.items);
      expect(items).toHaveLength(r.items);
      expect(items.some((i) => i.status === 'done')).toBe(true);
      expect(items.every((i) => i.decision?.itemRevision === i.revision)).toBe(true);
      expect(items.every((i) => /^slack:[A-Z0-9]+:\d{10}\.\d{6}$/.test(i.id))).toBe(true);
      const files = new ItemFiles(join(data, 'items'));
      const stored = await files.read('slack', items[0].id);
      expect(stored?.item.revision).toBe(items[0].revision);
      expect(stored?.item.messages.length).toBe(items[0].messageCount);
    } finally {
      await store.close();
    }
    expect(await readdir(data)).toContain(SYNTHETIC_MARKER);
  });

  it('refuses real data directories and folders with something in them', async () => {
    expect(await targetProblem('/Users/x/WorkOS-data', '/Users/x')).toMatch(/real Work OS/);
    expect(await targetProblem('/Users/x/WorkOS-data-dev/sub', '/Users/x')).toMatch(/real Work OS/);
    expect(await targetProblem('/Users/x/Library/Application Support/WorkOS', '/Users/x')).toMatch(/real Work OS/);
    await writeFile(join(dir, 'something'), 'x');
    expect(await targetProblem(dir)).toMatch(/not empty/);
    await expect(generate(dir, { days: 1, now: NOW })).rejects.toThrow(/not empty/);
    expect(await targetProblem(join(dir, 'new'))).toBeUndefined();
  });
});
