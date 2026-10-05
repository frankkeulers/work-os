import { describe, expect, it } from 'vitest';
import type { ItemSummary } from '../api';
import { cardActions } from './lanes';

const item = (over: Partial<ItemSummary>): ItemSummary => ({
  id: 'i',
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

  it('never offers Confluence as an action for people observations (FR-10.1)', () => {
    const a = cardActions(item({ lane: 'file', containsPeopleObservations: true, triage: { attention: 'none', confluence: true, vault: true, by: 'model' } }), false);
    expect(a.primary.kind === 'draft' && a.primary.button.type).toBe('vault_note');
    const conf = a.overflowDrafts.find((d) => d.type === 'confluence_entry');
    expect(conf?.disabledReason).toMatch(/named people/);
  });

  it('puts the still-open filing first when one is already filed', () => {
    const a = cardActions(
      item({
        lane: 'file',
        triage: { attention: 'none', confluence: true, vault: true, by: 'model' },
        actions: { confluence_entry: { id: 'a', type: 'confluence_entry', status: 'done', stale: false } },
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
