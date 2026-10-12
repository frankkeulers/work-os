import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilingLabelStore, impliedFlags, mergeFilingLabels, readFilingLabels, type FilingLabelRecord } from './filingLabels';

// labels/filing.jsonl (FR-15.7): one line per signal; per item and field, explicit beats implicit
// and later beats earlier.

const thread = { id: 'slack:C1:1.0', kind: 'thread' as const, title: '#product', messages: [{ author: 'Dana Lee', at: '2026-10-12T08:00:00.000Z', text: 'Bulk export ships without PDF' }], omitted: 0 };
const line = (over: Partial<FilingLabelRecord>): FilingLabelRecord => ({
  at: '2026-10-12T09:00:00.000Z',
  origin: 'implicit',
  signal: 'approved',
  itemId: 'slack:C1:1.0',
  itemRevision: 1,
  source: 'slack',
  label: {},
  thread,
  ...over,
});

describe('impliedFlags', () => {
  it('fills in what a field implies, both ways', () => {
    expect(impliedFlags({ ready: true })).toEqual({ ready: true, predraft: true, toFile: true });
    expect(impliedFlags({ toFile: false })).toEqual({ toFile: false, predraft: false, ready: false });
    expect(impliedFlags({ predraft: false })).toEqual({ predraft: false, ready: false });
    expect(impliedFlags({ ready: false })).toEqual({ ready: false });
  });
});

describe('mergeFilingLabels', () => {
  it('keeps the latest value per field, and an explicit one over any implicit one', () => {
    const m = mergeFilingLabels([
      line({ signal: 'approved', label: { vault: { toFile: true, predraft: true, ready: true } } }),
      line({ origin: 'explicit', signal: 'not_ready', label: { vault: { ready: false } } }),
      line({ signal: 'approved', label: { vault: { toFile: true, predraft: true, ready: true } }, itemRevision: 2 }),
      line({ signal: 'todo_dismissed', label: { todo: false }, itemRevision: 2 }), // the latest line's revision and thread stand
      line({ itemId: 'slack:C1:2.0', origin: 'explicit', signal: 'corrected', label: { confluence: { toFile: true } } }),
    ]);
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({
      itemId: 'slack:C1:1.0',
      itemRevision: 2,
      vault: { toFile: { value: true, origin: 'implicit' }, predraft: { value: true }, ready: { value: false, origin: 'explicit', signal: 'not_ready' } },
      todo: { value: false, signal: 'todo_dismissed' },
    });
    expect(m[0].confluence).toEqual({});
    expect(m[1]).toMatchObject({ confluence: { toFile: { value: true, origin: 'explicit' } } });
  });

  it('keeps the latest reason Frank gave, past later lines without one', () => {
    const [m] = mergeFilingLabels([
      line({ origin: 'explicit', signal: 'no_predraft', label: { vault: { predraft: false } }, reason: 'Only after the call' }),
      line({ origin: 'explicit', signal: 'corrected', label: { vault: { toFile: false } }, reason: 'Not my product area' }),
      line({ signal: 'done_unfiled', label: { vault: { toFile: false } } }),
    ]);
    expect(m.reason).toBe('Not my product area');
    expect(mergeFilingLabels([line({})])[0]).not.toHaveProperty('reason');
  });
});

describe('FilingLabelStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workos-filing-labels-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('appends, counts items and origins, and reopens past a torn last line', async () => {
    const file = join(dir, 'filing.jsonl');
    const s = await FilingLabelStore.open(file);
    await s.append(line({ label: { vault: { predraft: true } } }));
    await s.append(line({ origin: 'explicit', signal: 'no_predraft', label: { vault: { predraft: false } } }));
    await s.append(line({ itemId: 'slack:C1:2.0', signal: 'done_unfiled', label: { vault: { toFile: false } } }));
    expect(s.counts).toEqual({ labels: 2, explicit: 1, implicit: 2 });
    await s.close();
    await appendFile(file, '{"at":"2026-10-12T09:0');
    expect(await readFilingLabels(file)).toHaveLength(3);
    expect((await FilingLabelStore.open(file)).counts).toEqual({ labels: 2, explicit: 1, implicit: 2 });
  });

  it('refuses a line it can’t read back', async () => {
    const s = await FilingLabelStore.open(join(dir, 'filing.jsonl'));
    await expect(s.append(line({ signal: 'guessed' as never }))).rejects.toThrow();
    expect(s.counts.labels).toBe(0);
    await s.close();
  });
});
