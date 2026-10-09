import { describe, expect, it } from 'vitest';
import type { ItemSummary } from '../../api';
import { batchable, filingFor, needsDraft, openFilings, tally } from './batch';

const item = (over: Partial<ItemSummary>): ItemSummary => ({
  id: 'i',
  source: 'slack',
  kind: 'thread',
  title: '#x',
  permalink: 'https://example.com',
  lastActivityAt: '2026-10-05T08:00:00.000Z',
  revision: 1,
  lane: 'file',
  status: 'open',
  triageState: 'triaged',
  summary: 's',
  containsPeopleObservations: false,
  targetHints: {},
  actions: {},
  newReplies: false,
  backFromSnooze: false,
  modelPaused: false,
  pieces: 1,
  asksDone: [],
  triage: { attention: 'none', confluence: true, vault: true, by: 'model' },
  ...over,
});
const action = (type: 'vault_note' | 'confluence_entry', status: 'drafting' | 'ready' | 'approved' | 'done') => ({ id: `a-${type}`, type, status, stale: false, repliesSince: false, version: 1 });

describe('file in a batch (CK-4.1–4.4)', () => {
  it('opens an item on its suggested filings, Confluence first, then the other after it is approved', () => {
    const i = item({});
    expect(openFilings(i)).toEqual(['confluence_entry', 'vault_note']);
    expect(filingFor(i)).toBe('confluence_entry');
    expect(filingFor(i, 'confluence_entry')).toBe('vault_note');
    expect(filingFor(item({ triage: { attention: 'none', confluence: true, vault: false, by: 'model' } }), 'confluence_entry')).toBeUndefined();
  });

  it('leaves out what is filed or being written, and Confluence for people observations (FR-10.1)', () => {
    expect(openFilings(item({ actions: { confluence_entry: action('confluence_entry', 'done') } }))).toEqual(['vault_note']);
    expect(openFilings(item({ actions: { vault_note: action('vault_note', 'approved') } }))).toEqual(['confluence_entry']);
    expect(openFilings(item({ containsPeopleObservations: true }))).toEqual(['vault_note']);
    // A ready or drafting filing is still to approve.
    expect(openFilings(item({ actions: { vault_note: action('vault_note', 'ready'), confluence_entry: action('confluence_entry', 'drafting') } }))).toEqual(['confluence_entry', 'vault_note']);
  });

  it('takes open To file items with a filing left', () => {
    expect(batchable(item({}))).toBe(true);
    expect(batchable(item({ lane: 'today' }))).toBe(false);
    expect(batchable(item({ status: 'done', lane: 'done' }))).toBe(false);
    expect(batchable(item({ actions: { confluence_entry: action('confluence_entry', 'done'), vault_note: action('vault_note', 'done') } }))).toBe(false);
    expect(batchable(undefined)).toBe(false);
  });

  it('starts a draft only where there is none, within the budget', () => {
    expect(needsDraft(item({}), 'vault_note', false)).toBe(true);
    expect(needsDraft(item({}), 'vault_note', true)).toBe(false);
    expect(needsDraft(item({ actions: { vault_note: action('vault_note', 'drafting') } }), 'vault_note', false)).toBe(false);
  });

  it('tallies what was filed and skipped', () => {
    expect(tally({ filed: 4, skipped: 1 })).toBe('4 filed · 1 skipped');
    expect(tally({ filed: 3, skipped: 0 })).toBe('3 filed');
  });
});
