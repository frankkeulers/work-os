import { describe, expect, it, vi } from 'vitest';
import type { BudgetState } from '@work-os/shared';
import type { ItemSummary } from '../../api';
import { aheadQueue, isReady, pickDraftAhead } from './draftAhead';

vi.mock('../../store/quietDrafts', () => ({ requestQuietDraft: vi.fn() }));

const item = (id: string, over: Partial<ItemSummary> = {}): ItemSummary => ({
  id,
  source: 'slack',
  kind: 'thread',
  title: `#${id}`,
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
  triage: { attention: 'none', confluence: false, vault: true, by: 'model' },
  ...over,
});

const budgets = (used: number, limit = 10, costHit = false): BudgetState => ({
  triage: { used: 0, limit: 60, hit: false },
  drafts: { used, limit, hit: used >= limit },
  cost: { used: 0, limit: 2.5, hit: costHit },
  baseline: null,
  pctOfBaseline: null,
});

describe('pickDraftAhead (UX-3)', () => {
  it('takes the first in the queue with a suggested filing not yet drafted', () => {
    const items = [item('a', { lane: 'today' }), item('b'), item('c')];
    expect(pickDraftAhead(items, ['a', 'c', 'b'], new Set(), budgets(2))).toMatchObject({ item: { id: 'c' }, type: 'vault_note' });
  });

  it('keeps three drafts spare, and stops when the cost budget is reached', () => {
    const items = [item('b')];
    expect(pickDraftAhead(items, ['b'], new Set(), budgets(6))).toBeDefined();
    expect(pickDraftAhead(items, ['b'], new Set(), budgets(7))).toBeUndefined();
    expect(pickDraftAhead(items, ['b'], new Set(), budgets(0, 10, true))).toBeUndefined();
  });

  it('runs one draft at a time, and never drafts ahead again what was tried', () => {
    const drafting = item('d', { actions: { vault_note: { id: 'x', status: 'drafting', version: 1 } } as ItemSummary['actions'] });
    expect(pickDraftAhead([drafting, item('b')], ['b'], new Set(), budgets(0))).toBeUndefined();
    expect(pickDraftAhead([item('b')], ['b'], new Set(['b:vault_note']), budgets(0))).toBeUndefined();
  });
});

describe('drafts ahead follow the filing policy (FR-15.3, FR-15.5)', () => {
  const plan = (vault: { predraft: boolean; ready: boolean }, confluence?: { predraft: boolean; ready: boolean }): Partial<ItemSummary> => ({
    triage: { attention: 'none', confluence: !!confluence, vault: true, by: 'model' },
    filing: { vault_note: vault, ...(confluence && { confluence_entry: confluence }) },
  });

  it('drafts ahead only a filing the policy pre-drafts', () => {
    const items = [item('a', plan({ predraft: false, ready: false })), item('b', plan({ predraft: true, ready: false }))];
    expect(pickDraftAhead(items, ['a', 'b'], new Set(), budgets(0))).toMatchObject({ item: { id: 'b' }, type: 'vault_note' });
    expect(pickDraftAhead(items, ['a'], new Set(), budgets(0))).toBeUndefined();
  });

  it('takes the pre-drafted filing of an item, and then its second one', () => {
    const both = item('a', plan({ predraft: true, ready: false }, { predraft: false, ready: false }));
    expect(pickDraftAhead([both], ['a'], new Set(), budgets(0))).toMatchObject({ type: 'vault_note' });
    const two = item('a', plan({ predraft: true, ready: false }, { predraft: true, ready: false }));
    expect(pickDraftAhead([two], ['a'], new Set(), budgets(0))).toMatchObject({ type: 'confluence_entry' });
    expect(pickDraftAhead([two], ['a'], new Set(['a:confluence_entry']), budgets(0))).toMatchObject({ type: 'vault_note' });
  });

  it('looks at the item Frank landed on first, then ready items, then the rest', () => {
    const items = [item('a', plan({ predraft: true, ready: false })), item('b', plan({ predraft: true, ready: true })), item('c', plan({ predraft: true, ready: false }))];
    expect(aheadQueue(items, null, ['a', 'b', 'c'])).toEqual(['b', 'a', 'c']);
    expect(aheadQueue(items, 'c', ['a', 'b'])).toEqual(['c', 'b', 'a']);
    expect(isReady(items[1])).toBe(true);
    expect(isReady(items[0])).toBe(false);
  });
});
