import { describe, expect, it } from 'vitest';
import { buildFiled, type FiledInput } from './filed';
import type { ActionState } from './projection/state';

// 13:00 in London on 11 Oct 2026 (BST); London's day began at 23:00 UTC the day before.
const NOW = '2026-10-11T12:00:00.000Z';
const TARGETS = { confluenceSite: 'https://psg.atlassian.net', spaceKey: 'KD', vaultPath: '/vault' };

const action = (id: string, itemId: string, extra: Partial<ActionState> = {}): ActionState => ({
  id,
  itemId,
  itemRevision: 1,
  type: 'vault_note',
  status: 'done',
  target: { path: 'Inbox/a.md' },
  draftRef: `drafts/${id}.json`,
  createdAt: '2026-10-11T09:00:00.000Z',
  updatedAt: '2026-10-11T10:00:00.000Z',
  ...extra,
});

const input = (actions: ActionState[], extra: Partial<FiledInput> = {}): FiledInput => ({
  now: NOW,
  actions,
  items: new Map([
    ['a', { title: '#product', summary: 'Launch decided.', done: true }],
    ['b', { title: '#insights-api', summary: 'imo_str dropped.', done: false }],
  ]),
  results: { a1: 'Created /vault/Inbox/a.md. Logged action.executed.' },
  dryRun: false,
  targets: TARGETS,
  ...extra,
});

describe('buildFiled (UX-12)', () => {
  it('lists the filings written since midnight in London, newest first, with what they wrote and where', () => {
    const v = buildFiled(
      input([
        action('a1', 'a'),
        action('b1', 'b', { type: 'confluence_entry', target: { pageId: '42', baseVersion: 3 }, updatedAt: '2026-10-11T11:00:00.000Z' }),
        action('a0', 'a', { updatedAt: '2026-10-10T22:59:00.000Z' }), // 23:59 yesterday in London
        action('a2', 'a', { updatedAt: '2026-10-10T23:01:00.000Z' }), // 00:01 today in London
      ]),
    );
    expect(v.filings.map((f) => f.actionId)).toEqual(['b1', 'a1', 'a2']);
    expect(v.filings[0]).toEqual({ actionId: 'b1', itemId: 'b', type: 'confluence_entry', at: '2026-10-11T11:00:00.000Z', title: '#insights-api', summary: 'imo_str dropped.', itemDone: false, pageId: '42' });
    expect(v.filings[1]).toMatchObject({ itemDone: true, paths: ['Inbox/a.md'], result: 'Created /vault/Inbox/a.md. Logged action.executed.' });
    expect(v).toMatchObject({ dryRun: false, targets: TARGETS });
  });

  it('keeps every note of a filing into several, and leaves out what was not written', () => {
    const v = buildFiled(
      input([
        action('m1', 'a', { target: { path: 'One.md', paths: ['One.md', 'Two.md'] } }),
        action('r1', 'a', { status: 'ready' }),
        action('f1', 'a', { status: 'failed' }),
        action('x1', 'gone'), // its item went with retention
      ]),
    );
    expect(v.filings.map((f) => [f.actionId, f.paths])).toEqual([['m1', ['One.md', 'Two.md']]]);
  });
});
