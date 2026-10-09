import { newItemFlags, type ItemState } from '@work-os/shared';
import { describe, expect, it } from 'vitest';
import { settleLabelOrigin } from './settleLabels';

const NOW = new Date('2026-10-09T12:00:00.000Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

/** Open in Today, triaged at revision 1 and topic version 0. */
const item = (over: Partial<ItemState> = {}): ItemState => ({
  id: 'slack:C1:1.000100',
  source: 'slack',
  kind: 'thread',
  title: '#product',
  permalink: 'https://polestar.slack.com/archives/C1/p1',
  participants: [],
  lastActivityAt: minsAgo(5),
  revision: 1,
  messageCount: 1,
  ...newItemFlags(),
  triageState: 'triaged',
  decision: { itemId: 'slack:C1:1.000100', itemRevision: 1, topicVersion: 0, attention: 'today', confluence: { suggested: false }, vault: { suggested: false }, containsPeopleObservations: false, decidedBy: 'model', decidedAt: minsAgo(60) },
  ...over,
});

describe('settleLabelOrigin (cockpit CK-2.6)', () => {
  it('labels Undo on a reply-close, and Done soon after a check that said not settled', () => {
    expect(settleLabelOrigin(item({ status: 'done', doneBy: 'reply' }), 'reopened', NOW)).toBe('undo');
    expect(settleLabelOrigin(item({ status: 'done', doneBy: 'you' }), 'reopened', NOW)).toBeUndefined();
    expect(settleLabelOrigin(item({ revision: 2, replyCheck: { at: minsAgo(10), revision: 2, allSettled: false, settled: 0 } }), 'done', NOW)).toBe('manual_done');
  });

  it('labels Done after Frank wrote, when no check saw it: a new revision, or a piece of his joined', () => {
    expect(settleLabelOrigin(item({ revision: 2 }), 'done', NOW)).toBe('manual_done_unchecked');
    expect(settleLabelOrigin(item({ topicVersion: 1 }), 'done', NOW)).toBe('manual_done_unchecked');
    // A check saw an earlier revision only.
    expect(settleLabelOrigin(item({ revision: 3, replyCheck: { at: minsAgo(90), revision: 2, allSettled: false, settled: 0 } }), 'done', NOW)).toBe('manual_done_unchecked');
  });

  it('leaves Done alone when there is nothing to learn from', () => {
    expect(settleLabelOrigin(item(), 'done', NOW)).toBeUndefined(); // nothing written since triage
    expect(settleLabelOrigin(item({ revision: 2, replyCheck: { at: minsAgo(90), revision: 2, allSettled: false, settled: 0 } }), 'done', NOW)).toBeUndefined(); // the check saw it, long ago
    expect(settleLabelOrigin(item({ revision: 2, replyCheck: { at: minsAgo(5), revision: 2, allSettled: true, settled: 1 } }), 'done', NOW)).toBeUndefined(); // settled, closing off
    expect(settleLabelOrigin(item({ revision: 2, decision: { ...item().decision!, attention: 'none' } }), 'done', NOW)).toBeUndefined(); // Low priority
    expect(settleLabelOrigin(item({ revision: 2, triageState: 'pending' }), 'done', NOW)).toBeUndefined(); // someone else wrote since
  });
});
