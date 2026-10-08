import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EvalReport } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LabelStore, latestLabels, type LabelRecord } from '../store/labels';
import { listReports, saveReport, score, type Scored } from './eval';

// Scoring, the labelled set and report files (FR-6.1, FR-6.3). Synthetic threads only.

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workos-eval-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const row = (label: Scored['label']['attention'], predicted: Scored['predicted']['attention'], flags: Partial<{ lc: boolean; lv: boolean; pc: boolean; pv: boolean }> = {}): Scored => ({
  label: { attention: label, confluence: !!flags.lc, vault: !!flags.lv },
  predicted: { attention: predicted, confluence: !!flags.pc, vault: !!flags.pv },
});

const label = (itemId: string, attention: LabelRecord['label']['attention'], at = '2026-10-06T09:00:00.000Z'): LabelRecord => ({
  at,
  origin: 'correction',
  itemId,
  itemRevision: 1,
  source: 'slack',
  label: { attention, confluence: false, vault: false },
  thread: { id: itemId, kind: 'thread', title: '#synthetic', messages: [{ author: 'Sam', at: '1.0', text: 'synthetic' }], omitted: 0 },
});

describe('score', () => {
  it('builds the confusion matrix with labels as rows, and precision and recall from it', () => {
    const s = score([row('now', 'now'), row('now', 'today'), row('today', 'today'), row('none', 'today'), row('none', 'none', { lc: true, pc: true }), row('today', 'none', { lv: true })]);
    expect(s.confusion).toEqual([
      [1, 1, 0],
      [0, 1, 1],
      [0, 1, 1],
    ]);
    expect(s.categories.now).toEqual({ precision: 1, recall: 0.5, support: 2 });
    expect(s.categories.today).toEqual({ precision: 1 / 3, recall: 0.5, support: 2 });
    expect(s.categories.confluence).toEqual({ precision: 1, recall: 1, support: 1 });
    expect(s.categories.vault).toEqual({ precision: 0, recall: 0, support: 1 }); // never predicted
  });

  it('scores zero, not NaN, for a category with no examples', () => {
    expect(score([]).categories.now).toEqual({ precision: 0, recall: 0, support: 0 });
  });
});

describe('labelled set', () => {
  it('keeps the latest label per item and counts distinct threads', async () => {
    const file = join(dir, 'triage.jsonl');
    const store = await LabelStore.open(file);
    await store.append(label('a', 'none'));
    await store.append(label('b', 'today'));
    await store.append(label('a', 'now', '2026-10-06T10:00:00.000Z'));
    await store.close();
    expect(store.counts).toEqual({ labels: 2, corrections: 3 });
    const latest = latestLabels(await store.all());
    expect(latest.map((l) => [l.itemId, l.label.attention])).toEqual([
      ['a', 'now'],
      ['b', 'today'],
    ]);
  });

  it('skips a torn last line when it opens', async () => {
    const file = join(dir, 'triage.jsonl');
    await writeFile(file, `${JSON.stringify(label('a', 'now'))}\n`);
    await appendFile(file, '{"at":"2026-10-06T1');
    expect((await LabelStore.open(file)).counts.labels).toBe(1);
  });
});

describe('reports', () => {
  it('saves to logs/eval-<timestamp>.json and lists newest first', async () => {
    const base = { labelCount: 1, promptVersion: 'triage v1#00000000', model: 'haiku-5.5' as const, ...score([row('now', 'now')]), tokens: 10, costEquivalent: 0.001 };
    const older: EvalReport = { ...base, id: 'eval-1', at: '2026-10-05T09:00:00.000Z' };
    const newer: EvalReport = { ...base, id: 'eval-2', at: '2026-10-06T09:00:00.000Z' };
    expect(await saveReport(dir, older)).toBe(join(dir, 'eval-2026-10-05T09-00-00-000Z.json'));
    await saveReport(dir, newer);
    await writeFile(join(dir, 'eval-broken.json'), '{');
    expect((await listReports(dir)).map((r) => r.id)).toEqual(['eval-2', 'eval-1']);
  });
});
