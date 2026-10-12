import { describe, expect, it } from 'vitest';
import type { Predicted } from '../pipeline/eval';
import type { FilingScored } from '../pipeline/evalFiling';
import type { SettlePredicted } from '../pipeline/evalSettle';
import type { LabelRecord } from '../store/labels';
import type { SettleLabelRecord } from '../store/settleLabels';
import { checkMiss, checkRows, strings } from './checkLoop';
import { filingMiss } from './filingLoop';
import { triageMiss, triageRows } from './triageLoop';

// The triage, settle and finish loops' adapters (FR-15.11): their scores as rows with the spec's
// targets, and the misses the tuner is shown.

const thread = { id: 'slack:C1:1.0', kind: 'thread' as const, title: 'Export', messages: [{ author: 'Dana', at: '2026-10-12T08:00:00.000Z', text: 'Can you sign off the export by noon?' }], omitted: 0 };
const record = (attention: LabelRecord['label']['attention'], origin: LabelRecord['origin'] = 'correction'): LabelRecord => ({
  at: '2026-10-12T09:00:00.000Z',
  origin,
  itemId: 'slack:C1:1.0',
  itemRevision: 1,
  source: 'slack',
  label: { attention, confluence: false, vault: false },
  thread,
});
const predicted = (label: LabelRecord['label']['attention'], said: LabelRecord['label']['attention'], origin?: LabelRecord['origin']): Predicted => {
  const r = record(label, origin);
  return { record: r, source: 'slack', label: r.label, predicted: { attention: said, confluence: false, vault: false } };
};

describe('the triage loop', () => {
  it('scores attention per lane, with S1 and S2 as targets', () => {
    const rows = triageRows([predicted('now', 'now'), predicted('now', 'today'), predicted('today', 'today'), predicted('none', 'today')]);
    expect(rows.map((r) => r.key)).toEqual(['now', 'today', 'follow', 'none']);
    expect(rows[0]).toEqual({ key: 'now', label: 'Now', precision: 1, recall: 0.5, n: 2, target: 0.8, recallTarget: 0.9 });
    expect(rows[1]).toMatchObject({ key: 'today', precision: 1 / 3, recall: 1, n: 1, target: 0.8 });
    expect(rows[2]).toEqual({ key: 'follow', label: 'Follow', precision: 0, recall: 0, n: 0 });
  });

  it('shows the tuner the thread and what went wrong with its attention, nothing for a right one', () => {
    expect(triageMiss(predicted('now', 'now'))).toBeUndefined();
    expect(triageMiss(predicted('now', 'today'))).toEqual({ thread, wrong: ['attention: label now (Frank corrected it); the prompt said today'] });
    expect(triageMiss(predicted('none', 'today', 'confirmed'))).toMatchObject({ wrong: ['attention: label none (Frank said triage was right); the prompt said today'] });
  });
});

describe('the filing loop', () => {
  const off = { toFile: false, predraft: false, ready: false };
  const scored = (reason?: string): FilingScored => ({
    label: { itemId: thread.id, source: 'slack', itemRevision: 1, thread, confluence: {}, vault: { toFile: { value: false, origin: 'explicit', signal: 'corrected' } }, ...(reason && { reason }) },
    predicted: { confluence: off, vault: { toFile: true, predraft: false, ready: false, rule: 'F2' }, todo: false },
  });

  it('shows the tuner Frank’s reason with the miss when he gave one', () => {
    expect(filingMiss(scored())).toEqual({ thread, wrong: ['vault to file: label no (Frank said so); the policy said yes (rule F2)'] });
    expect(filingMiss(scored('Not my product area'))).toEqual({ thread, wrong: ['vault to file: label no (Frank said so); the policy said yes (rule F2)'], reason: 'Not my product area' });
  });
});

describe('the settle and finish loops', () => {
  const label = (settled: boolean, origin: SettleLabelRecord['origin']): SettleLabelRecord => ({
    at: '2026-10-12T09:00:00.000Z',
    origin,
    itemId: 'slack:C1:1.0',
    itemRevision: 2,
    source: 'slack',
    settled,
    check: { thread, asks: [{ askId: 'a1', text: 'Sign off the export' }], reply: { text: 'Signed off.' } },
  });
  const row = (settled: boolean, closes: boolean, origin: SettleLabelRecord['origin'] = 'undo'): SettlePredicted => ({ label: label(settled, origin), closes });

  it('scores closing against C2, and staying open alongside it', () => {
    const rows = checkRows('settle', [row(true, true, 'manual_done'), row(false, true), row(false, false), row(true, false, 'manual_done')]);
    expect(rows).toEqual([
      { key: 'closes', label: 'Closes on your reply', precision: 0.5, recall: 0.5, n: 2, target: 0.98 },
      { key: 'stays', label: 'Stays open', precision: 0.5, recall: 0.5, n: 2 },
    ]);
    expect(checkRows('finish', []).map((r) => r.label)).toEqual(['Looks finished', 'Not finished']);
  });

  it('shows the tuner the check and how Frank said it was wrong', () => {
    expect(checkMiss(row(false, false))).toBeUndefined();
    expect(checkMiss(row(false, true))).toEqual({ check: label(false, 'undo').check, wrong: ['label: not settled, so it stays open (Frank undid the close); the prompt said settled, so it closes'] });
    expect(checkMiss(row(true, false, 'finish_accepted'))).toMatchObject({ wrong: ['label: settled, so it closes (Frank pressed Done on Looks finished); the prompt said not settled, so it stays open'] });
  });

  it('collects every string in a check, for the copy check', () => {
    expect(strings(label(true, 'undo').check)).toEqual(['slack:C1:1.0', 'thread', 'Export', 'Dana', '2026-10-12T08:00:00.000Z', 'Can you sign off the export by noon?', 'a1', 'Sign off the export', 'Signed off.']);
  });
});
