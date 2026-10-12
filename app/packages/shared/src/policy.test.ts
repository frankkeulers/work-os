import { describe, expect, it } from 'vitest';
import type { DecisionLike } from './lanes';
import { STAGE_OF, filingPlan, stageFiling, todoOffer } from './policy';
import { DEFAULT_FILING, type TriageCorrection } from './schemas';

const decision = (over: Partial<DecisionLike> = {}): DecisionLike => ({
  itemRevision: 1,
  attention: 'none',
  confluence: { suggested: false },
  vault: { suggested: false },
  decidedBy: 'model',
  ...over,
});
const correction = (over: Partial<TriageCorrection> = {}): TriageCorrection => ({ itemId: 'i', itemRevision: 1, attention: 'none', confluence: false, vault: false, correctedAt: '2026-10-12T09:00:00.000Z', ...over });

describe('filingPlan (FR-15.2, FR-15.3, FR-15.5)', () => {
  it('pre-drafts every suggested filing of a decision from before the policy, none ready', () => {
    expect(filingPlan(decision({ vault: { suggested: true, targetHint: 'meeting note' } }), undefined, DEFAULT_FILING)).toEqual({ vault_note: { predraft: true, ready: false } });
  });

  it('follows the policy: not pre-drafted, pre-drafted, ready, with the rule cited', () => {
    const d = decision({ confluence: { suggested: true, predraft: false, ready: false, rule: 'F1' }, vault: { suggested: true, predraft: true, ready: true, rule: 'R1' } });
    expect(filingPlan(d, undefined, DEFAULT_FILING)).toEqual({ confluence_entry: { predraft: false, ready: false, rule: 'F1' }, vault_note: { predraft: true, ready: true, rule: 'R1' } });
  });

  it('applies the switches: every filing, none, or no Ready group', () => {
    const d = decision({ confluence: { suggested: true, predraft: false, ready: false }, vault: { suggested: true, predraft: true, ready: true } });
    expect(filingPlan(d, undefined, { ...DEFAULT_FILING, predraft: 'all' })).toEqual({ confluence_entry: { predraft: true, ready: false }, vault_note: { predraft: true, ready: true } });
    expect(filingPlan(d, undefined, { ...DEFAULT_FILING, predraft: 'off' })).toEqual({ confluence_entry: { predraft: false, ready: false }, vault_note: { predraft: false, ready: false } });
    expect(filingPlan(d, undefined, { ...DEFAULT_FILING, ready: false }).vault_note).toEqual({ predraft: true, ready: false });
  });

  it('drops a rule ID the policy never writes', () => {
    expect(filingPlan(decision({ vault: { suggested: true, predraft: true, ready: false, rule: 'the meeting rule' } }), undefined, DEFAULT_FILING).vault_note).toEqual({ predraft: true, ready: false });
  });

  it('pre-drafts a filing Frank turned on, but offers it as ready only when the decision did', () => {
    const d = decision({ vault: { suggested: true, predraft: true, ready: true, rule: 'R1' } });
    expect(filingPlan(d, correction({ confluence: true, vault: true }), DEFAULT_FILING)).toEqual({ confluence_entry: { predraft: true, ready: false }, vault_note: { predraft: true, ready: true, rule: 'R1' } });
    expect(filingPlan(d, correction({ attention: 'today' }), DEFAULT_FILING)).toEqual({});
    expect(filingPlan(undefined, undefined, DEFAULT_FILING)).toEqual({});
  });
});

describe('Frank’s word on a filing’s stage (FR-15.7)', () => {
  const d = decision({ itemRevision: 3, confluence: { suggested: true, predraft: false, ready: false, rule: 'F1' }, vault: { suggested: true, predraft: true, ready: true, rule: 'R1' } });

  it('moves a filing into Ready, which drafts it ahead, and out again', () => {
    const ready = stageFiling(undefined, 'confluence_entry', 3, STAGE_OF.should_be_ready);
    expect(filingPlan(d, undefined, DEFAULT_FILING, ready).confluence_entry).toEqual({ predraft: true, ready: true, rule: 'F1' });
    // Not ready after all: it stays drafted ahead, as Frank said before.
    const notReady = stageFiling(ready, 'confluence_entry', 3, STAGE_OF.not_ready);
    expect(filingPlan(d, undefined, DEFAULT_FILING, notReady).confluence_entry).toEqual({ predraft: true, ready: false, rule: 'F1' });
    expect(filingPlan(d, undefined, DEFAULT_FILING, stageFiling(undefined, 'vault_note', 3, STAGE_OF.not_ready)).vault_note).toEqual({ predraft: true, ready: false, rule: 'R1' });
  });

  it('stops drafting ahead, which takes it out of Ready too', () => {
    expect(filingPlan(d, undefined, DEFAULT_FILING, stageFiling(undefined, 'vault_note', 3, STAGE_OF.no_predraft)).vault_note).toEqual({ predraft: false, ready: false, rule: 'R1' });
  });

  it('lets the later choice win on the same revision, and starts afresh on a newer one', () => {
    const ready = stageFiling(stageFiling(undefined, 'vault_note', 3, STAGE_OF.no_predraft), 'vault_note', 3, STAGE_OF.should_be_ready);
    expect(ready.vault_note).toEqual({ revision: 3, predraft: true, ready: true });
    expect(stageFiling(ready, 'vault_note', 3, STAGE_OF.no_predraft).vault_note).toEqual({ revision: 3, predraft: false, ready: false });
    expect(stageFiling(ready, 'vault_note', 4, STAGE_OF.not_ready).vault_note).toEqual({ revision: 4, ready: false });
  });

  it('lapses once the item is triaged again, and the switches still apply', () => {
    const ready = stageFiling(undefined, 'confluence_entry', 2, STAGE_OF.should_be_ready);
    expect(filingPlan(d, undefined, DEFAULT_FILING, ready).confluence_entry).toEqual({ predraft: false, ready: false, rule: 'F1' });
    const now = stageFiling(undefined, 'confluence_entry', 3, STAGE_OF.should_be_ready);
    expect(filingPlan(d, undefined, { ...DEFAULT_FILING, ready: false }, now).confluence_entry).toEqual({ predraft: true, ready: false, rule: 'F1' });
    expect(filingPlan(d, undefined, { ...DEFAULT_FILING, predraft: 'off' }, now).confluence_entry).toEqual({ predraft: false, ready: false, rule: 'F1' });
  });
});

describe('todoOffer (FR-15.6)', () => {
  const todo = { step: 'Send the AIS gap report sample', rule: 'T1' };
  const o = { settings: DEFAULT_FILING, revision: 2, hasTodo: false, open: true };

  it('offers the suggested to-do on an open item', () => {
    expect(todoOffer(todo, o)).toEqual(todo);
    expect(todoOffer(undefined, o)).toBeUndefined();
  });

  it('stops once added, dismissed for this revision, closed, or switched off', () => {
    expect(todoOffer(todo, { ...o, hasTodo: true })).toBeUndefined();
    expect(todoOffer(todo, { ...o, dismissed: 2 })).toBeUndefined();
    expect(todoOffer(todo, { ...o, dismissed: 1 })).toEqual(todo); // a newer revision's suggestion shows again
    expect(todoOffer(todo, { ...o, open: false })).toBeUndefined();
    expect(todoOffer(todo, { ...o, settings: { ...DEFAULT_FILING, todoSuggestions: false } })).toBeUndefined();
  });
});
