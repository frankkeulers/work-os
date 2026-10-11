import { describe, expect, it } from 'vitest';
import type { ItemSummary } from '../api';
import { cardActions, draftButton } from './lanes';

const item = (over: Partial<ItemSummary>): ItemSummary => ({
  id: 'i',
  source: 'slack',
  kind: 'thread',
  title: '#x',
  permalink: 'https://example.com',
  lastActivityAt: '2026-10-05T08:00:00.000Z',
  revision: 1,
  lane: 'today',
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
  ...over,
});

describe('cardActions (design guide §3)', () => {
  it('uses Open in Slack as primary on Now and Today, with the filing suggestion as secondary', () => {
    const a = cardActions(item({ lane: 'today', triage: { attention: 'today', confluence: false, vault: true, by: 'model' } }), false);
    expect(a.primary.kind).toBe('slack');
    expect(a.secondary?.type).toBe('vault_note');
    expect(a.overflowDrafts.map((d) => d.type)).toEqual(['confluence_entry']);
  });

  it('uses the top filing draft as primary on File cards, Confluence first', () => {
    const a = cardActions(item({ lane: 'file', triage: { attention: 'none', confluence: true, vault: true, by: 'model' } }), false);
    expect(a.primary.kind === 'draft' && a.primary.button.type).toBe('confluence_entry');
    expect(a.secondary?.type).toBe('vault_note');
  });

  it('offers Confluence for a thread that mentions people: the draft anonymises them (FR-10.1, amended)', () => {
    const a = cardActions(item({ lane: 'file', containsPeopleObservations: true, triage: { attention: 'none', confluence: true, vault: true, by: 'model' } }), false);
    expect(a.primary.kind === 'draft' && a.primary.button).toMatchObject({ type: 'confluence_entry', disabledReason: undefined });
    expect(a.secondary?.type).toBe('vault_note');
  });

  it('puts the still-open filing first when one is already filed', () => {
    const a = cardActions(
      item({
        lane: 'file',
        triage: { attention: 'none', confluence: true, vault: true, by: 'model' },
        actions: { confluence_entry: { id: 'a', type: 'confluence_entry', status: 'done', stale: false, repliesSince: false, version: 1 } },
      }),
      false,
    );
    expect(a.primary.kind === 'draft' && a.primary.button.type).toBe('vault_note');
    expect(a.secondary?.label).toBe('Filed to Confluence');
  });

  it('disables new drafts when the drafts budget is hit (CL-6)', () => {
    const a = cardActions(item({ lane: 'today', triage: { attention: 'today', confluence: false, vault: true, by: 'model' } }), true);
    expect(a.secondary?.disabledReason).toBe('Drafts budget reached for today.');
    expect(a.overflowDrafts.every((d) => d.disabledReason)).toBe(true);
  });
});

describe('the to-do target (UX-5)', () => {
  it('is never held up by the drafts budget, and says Added once written', () => {
    expect(draftButton(item({}), 'todo', true)).toEqual({ type: 'todo', state: 'none', label: 'Add to-do', disabledReason: undefined });
    const ready = item({ actions: { todo: { id: 'a', status: 'ready', version: 1 } } as ItemSummary['actions'] });
    expect(draftButton(ready, 'todo', true).label).toBe('Review to-do');
    const done = item({ actions: { todo: { id: 'a', status: 'done', version: 1 } } as ItemSummary['actions'] });
    expect(draftButton(done, 'todo', false).label).toBe('Added to Tasks');
  });

  it('stays out of the card actions: triage never suggests it', () => {
    const a = cardActions(item({ lane: 'file', triage: { attention: 'none', confluence: true, vault: true, by: 'model' } }), false);
    expect([a.primary.kind === 'draft' && a.primary.button.type, a.secondary?.type, ...a.overflowDrafts.map((d) => d.type)]).not.toContain('todo');
  });
});
