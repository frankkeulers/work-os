import { describe, expect, it } from 'vitest';
import { toLoggedDecision, type EventData, type EventType, type WorkEvent } from '../events';
import type { TriageDecision } from '../schemas';
import { SeqGapError, reduce, replay } from './reduce';
import { emptyProjection } from './state';
import { askId, conversationOf } from './topics';
import { budgetsOf, openNext, summaryOf } from './views';

const ITEM = 'slack:C1:1791189720.000100';
const T0 = '2026-10-05T08:00:00.000Z';
const at = (mins: number) => new Date(Date.parse(T0) + mins * 60_000).toISOString();

/** Builds a log with a gap-free seq. */
function log() {
  const events: WorkEvent[] = [];
  interface Chain {
    add<T extends EventType>(type: T, mins: number, data: EventData<T>, ids?: { itemId?: string; actionId?: string }): Chain;
  }
  const chain: Chain = {
    add(type, mins, data, ids = { itemId: ITEM }) {
      events.push({ seq: events.length + 1, id: `ev-${events.length + 1}`, type, at: at(mins), ...ids, data, schemaVersion: 1 } as WorkEvent);
      return chain;
    },
  };
  return { events, add: chain.add };
}

const upserted = (revision: number, fromMeOnly = false, mins = 0): EventData<'item.upserted'> => ({
  source: 'slack',
  kind: 'thread',
  title: '#product',
  permalink: 'https://example.slack.com/archives/C1/p1791189720000100',
  participants: [{ id: 'U1', name: 'Dana Lee' }],
  lastActivityAt: at(mins),
  revision,
  messageCount: revision + 1,
  fromMeOnly,
});

const decision = (revision: number, attention: TriageDecision['attention'] = 'today'): TriageDecision => ({
  itemId: ITEM,
  itemRevision: revision,
  attention,
  confluence: { suggested: false },
  vault: { suggested: true, targetHint: 'Projects/Renewal' },
  containsPeopleObservations: false,
  summary: 'Pricing question',
  reason: 'Asks directly',
  decidedBy: 'model',
  decidedAt: at(10),
});

const decided = (revision: number, attention?: TriageDecision['attention']) => ({ decision: toLoggedDecision(decision(revision, attention)) });

describe('reduce', () => {
  it('refuses a gap or a repeat in seq, so the store can recover', () => {
    const { events, add } = log();
    add('item.upserted', 0, upserted(1)).add('item.done', 1, undefined);
    const p = emptyProjection();
    reduce(p, events[0]);
    expect(() => reduce(p, events[0])).toThrow(SeqGapError);
    expect(() => reduce(p, { ...events[1], seq: 3 })).toThrow(/expected seq 2, got 3/);
  });

  it('creates an item waiting for triage, then triages it', () => {
    const { events, add } = log();
    add('item.upserted', 0, upserted(1)).add('triage.decided', 10, decided(1));
    const it = replay(events).items[ITEM];
    expect(it).toMatchObject({ revision: 1, status: 'open', triageState: 'triaged', newReplies: false, decision: { attention: 'today' } });
  });

  it('re-triages new replies, but not Frank’s own or a replayed poll (FR-2.8, §5.3)', () => {
    const { events, add } = log();
    add('item.upserted', 0, upserted(1)).add('triage.decided', 10, decided(1)).add('item.upserted', 20, upserted(2, true, 20));
    expect(replay(events).items[ITEM]).toMatchObject({ revision: 2, triageState: 'triaged', newReplies: false });

    add('item.upserted', 30, upserted(3, false, 30));
    expect(replay(events).items[ITEM]).toMatchObject({ revision: 3, triageState: 'pending', newReplies: true });

    add('triage.decided', 40, decided(3)).add('item.upserted', 41, upserted(3, false, 30));
    expect(replay(events).items[ITEM]).toMatchObject({ revision: 3, triageState: 'triaged', newReplies: true });
  });

  it('ignores a decision made from older messages than the item has now', () => {
    const { events, add } = log();
    add('item.upserted', 0, upserted(2)).add('triage.decided', 10, decided(1, 'now'));
    const it = replay(events).items[ITEM];
    expect(it.triageState).toBe('pending');
    expect(it.decision).toBeUndefined();
  });

  it('reopens a done item when new replies are triaged, and wakes a snoozed one for Now', () => {
    const { events, add } = log();
    add('item.upserted', 0, upserted(1))
      .add('triage.decided', 10, decided(1))
      .add('item.done', 11, undefined)
      .add('item.upserted', 20, upserted(2, false, 20))
      .add('triage.decided', 30, decided(2));
    expect(replay(events).items[ITEM]).toMatchObject({ status: 'open', doneAt: undefined });

    add('item.snoozed', 31, { until: at(120) }).add('item.upserted', 40, upserted(3, false, 40)).add('triage.decided', 50, decided(3, 'now'));
    expect(replay(events).items[ITEM]).toMatchObject({ status: 'open', snoozedUntil: undefined, backFromSnooze: true });
  });

  it('follows done, reopen, snooze, its return and being seen (FR-8.2, FR-8.3)', () => {
    const { events, add } = log();
    add('item.upserted', 0, upserted(1)).add('item.done', 5, undefined);
    expect(replay(events).items[ITEM]).toMatchObject({ status: 'done', doneAt: at(5) });
    add('item.reopened', 6, undefined).add('item.snoozed', 7, { until: at(60) });
    expect(replay(events).items[ITEM]).toMatchObject({ status: 'snoozed', snoozedUntil: at(60), doneAt: undefined });
    add('item.unsnoozed', 60, undefined);
    expect(replay(events).items[ITEM]).toMatchObject({ status: 'open', backFromSnooze: true });
    add('item.seen', 61, undefined);
    expect(replay(events).items[ITEM].backFromSnooze).toBe(false);
  });

  it('lets a correction win until a newer decision replaces it', () => {
    const { events, add } = log();
    add('item.upserted', 0, upserted(1))
      .add('triage.failed', 10, { revision: 1, attempts: 2, reason: 'schema validation failed' })
      .add('triage.corrected', 12, { correction: { itemId: ITEM, itemRevision: 1, attention: 'now', confluence: false, vault: false, correctedAt: at(12) } });
    expect(replay(events).items[ITEM]).toMatchObject({ triageState: 'triaged', failCount: 2, correction: { attention: 'now' } });
    add('item.upserted', 20, upserted(2, false, 20)).add('triage.decided', 30, decided(2));
    expect(replay(events).items[ITEM]).toMatchObject({ correctedFrom: 'now', decision: { itemRevision: 2 } });
  });

  it('records notifications so an item is notified once (FR-11.2)', () => {
    const { events, add } = log();
    add('item.upserted', 0, upserted(1)).add('item.notified', 10, { kind: 'now', suppressed: 'quiet_hours' });
    expect(replay(events).items[ITEM].notified).toBe(true);
  });

  it('follows an action from request to write, keeping its target', () => {
    const { events, add } = log();
    const ids = { itemId: ITEM, actionId: 'act-1' };
    add('item.upserted', 0, upserted(1))
      .add('action.requested', 1, { type: 'confluence_entry', revision: 1, supersedes: 'act-0' }, ids)
      .add('action.drafted', 2, { type: 'confluence_entry', revision: 1, draftRef: 'drafts/act-1.json', tokens: 900, target: { pageId: '42', baseVersion: 7 } }, ids);
    expect(replay(events).actions['act-1']).toEqual({
      id: 'act-1',
      itemId: ITEM,
      itemRevision: 1,
      type: 'confluence_entry',
      status: 'ready',
      target: { pageId: '42', baseVersion: 7 },
      draftRef: 'drafts/act-1.json',
      supersedes: 'act-0',
      createdAt: at(1),
      updatedAt: at(2),
    });
    add('action.approved', 3, undefined, ids).add('action.executing', 4, { attempt: 1, expectedHash: 'sha256:x' }, ids);
    expect(replay(events).actions['act-1'].status).toBe('executing'); // the outbox reconciles this after a crash (FR-14.5)
    add('action.failed', 5, { reason: 'unreachable' }, ids);
    expect(replay(events).actions['act-1']).toMatchObject({ status: 'failed', failureReason: 'unreachable', updatedAt: at(5) });
  });

  it('ignores events for actions and items it never saw', () => {
    const { events, add } = log();
    add('action.approved', 0, undefined, { itemId: ITEM, actionId: 'nope' }).add('item.done', 1, undefined);
    const p = replay(events);
    expect(p.actions).toEqual({});
    expect(p.items).toEqual({});
    expect(p.lastSeq).toBe(2);
  });

  it('keeps the last cursor per source, so cursors can be rebuilt from the log', () => {
    const { events, add } = log();
    add('source.polled', 0, { source: 'slack', reason: 'first', fetched: 3, cursor: '1791189720.000100' }, {}).add('source.polled', 10, { source: 'slack', reason: 'scheduled', fetched: 0 }, {});
    expect(replay(events).sources.slack).toEqual({ lastPollAt: at(10), cursor: '1791189720.000100' });
  });
});

describe('topics', () => {
  const A = 'slack:G1:1791189720.000100';
  const B = 'slack:G1:1791193320.000100';
  const C = 'slack:G1:1791196920.000100';
  const on = (itemId: string) => ({ itemId });
  const piece = (mins: number, revision = 1, fromMeOnly = false) => ({ ...upserted(revision, fromMeOnly, mins), kind: 'dm' as const });
  const decidedOn = (itemId: string, revision: number, topicVersion?: number) => ({
    decision: toLoggedDecision({ ...decision(revision), itemId, ...(topicVersion !== undefined && { topicVersion }) }),
  });

  it('joins a piece to a topic: hidden behind the anchor, which waits for a fresh triage', () => {
    const { events, add } = log();
    add('item.upserted', 0, piece(0), on(A))
      .add('topic.routed', 10, { by: 'model' }, on(A))
      .add('triage.decided', 11, decidedOn(A, 1, 0), on(A))
      .add('item.upserted', 40, piece(40), on(B))
      .add('topic.routed', 50, { into: A, by: 'model' }, on(B));
    const p = replay(events);
    expect(p.items[B]).toMatchObject({ routed: true, topicOf: A });
    expect(p.items[A]).toMatchObject({ parts: [B], topicVersion: 1, triageState: 'pending', newReplies: true, lastActivityAt: at(40) });
  });

  it('marks a fresh topic pending without new replies, and a regroup too', () => {
    const { events, add } = log();
    add('item.upserted', 0, piece(0), on(A)).add('item.upserted', 5, piece(5), on(B)).add('topic.routed', 10, { into: A, by: 'model' }, on(B));
    expect(replay(events).items[A]).toMatchObject({ triageState: 'pending', newReplies: false });
  });

  it('re-triages the topic when a part grows, and drops a decision made before', () => {
    const { events, add } = log();
    add('item.upserted', 0, piece(0), on(A))
      .add('item.upserted', 5, piece(5), on(B))
      .add('topic.routed', 10, { into: A, by: 'model' }, on(B))
      .add('triage.decided', 20, decidedOn(A, 1, 1), on(A));
    expect(replay(events).items[A]).toMatchObject({ triageState: 'triaged', topicVersion: 1 });

    add('item.upserted', 30, piece(30, 2), on(B)).add('triage.decided', 31, decidedOn(A, 1, 1), on(A));
    expect(replay(events).items[A]).toMatchObject({ triageState: 'pending', newReplies: true, topicVersion: 2, lastActivityAt: at(30) });

    add('triage.decided', 40, decidedOn(A, 1, 2), on(A));
    expect(replay(events).items[A].triageState).toBe('triaged');
  });

  it('reopens a done topic when a part brings new replies, and parts follow the anchor', () => {
    const { events, add } = log();
    add('item.upserted', 0, piece(0), on(A))
      .add('item.upserted', 5, piece(5), on(B))
      .add('topic.routed', 10, { into: A, by: 'model' }, on(B))
      .add('triage.decided', 11, decidedOn(A, 1, 1), on(A))
      .add('item.done', 12, undefined, on(A));
    expect(replay(events).items[B]).toMatchObject({ status: 'done', doneAt: at(12) });

    add('item.upserted', 30, piece(30, 2), on(B)).add('triage.decided', 40, decidedOn(A, 1, 2), on(A));
    const p = replay(events);
    expect(p.items[A]).toMatchObject({ status: 'open', doneAt: undefined });
    expect(p.items[B].status).toBe('open');
  });

  it('merges a topic into another, parts and all, and routes into a part’s anchor', () => {
    const { events, add } = log();
    add('item.upserted', 0, piece(0), on(A))
      .add('item.upserted', 5, piece(5), on(B))
      .add('item.upserted', 6, piece(6), on(C))
      .add('topic.routed', 10, { into: B, by: 'model' }, on(C))
      .add('topic.routed', 11, { into: A, by: 'regroup' }, on(B));
    let p = replay(events);
    expect(p.items[A].parts).toEqual([B, C]);
    expect(p.items[C].topicOf).toBe(A);
    expect(p.items[B].parts).toBeUndefined();

    const d = 'slack:G1:1791200520.000100';
    add('item.upserted', 20, piece(20), on(d)).add('topic.routed', 21, { into: C, by: 'model' }, on(d));
    p = replay(events);
    expect(p.items[d].topicOf).toBe(A);
  });

  it('splits a piece out: on its own, waiting for triage, never routed back there', () => {
    const { events, add } = log();
    add('item.upserted', 0, piece(0), on(A))
      .add('triage.decided', 1, decidedOn(A, 1, 0), on(A))
      .add('item.upserted', 5, piece(5), on(B))
      .add('triage.decided', 6, decidedOn(B, 1, 0), on(B))
      .add('topic.routed', 10, { into: A, by: 'model' }, on(B))
      .add('triage.decided', 11, decidedOn(A, 1, 1), on(A))
      .add('topic.routed', 20, { by: 'user' }, on(B));
    const p = replay(events);
    expect(p.items[B]).toMatchObject({ topicOf: undefined, notWith: [A], triageState: 'pending', decision: undefined, status: 'open' });
    expect(p.items[A]).toMatchObject({ parts: undefined, topicVersion: 2, triageState: 'pending' });
  });

  it('ticks off asks by their wording', () => {
    const { events, add } = log();
    add('item.upserted', 0, piece(0), on(A)).add('topic.askDone', 5, { askId: askId('Approve the branch protection') }, on(A));
    expect(replay(events).items[A].asksDone).toEqual([askId('  approve the   branch protection ')]);
  });

  it('keys conversations by Slack channel only', () => {
    expect(conversationOf({ id: A, source: 'slack' })).toBe('G1');
    expect(conversationOf({ id: 'outlook:INBOX:1', source: 'outlook' })).toBeUndefined();
  });
});

describe('summaryOf', () => {
  const ctx = { actions: [], quietMinutes: 10, now: at(15), triageBudgetHit: false, text: {} };

  it('shows the start of the first message until there is a summary', () => {
    const { events, add } = log();
    add('item.upserted', 0, upserted(1));
    const it = replay(events).items[ITEM];
    const s = summaryOf(it, it, { ...ctx, text: { firstMessage: 'x'.repeat(200) } });
    expect(s).toMatchObject({ lane: 'waiting', quietUntil: at(10), modelPaused: false });
    expect(s.summary).toHaveLength(108);
    expect(summaryOf(it, it, { ...ctx, triageBudgetHit: true }).modelPaused).toBe(true);
  });

  it('marks a ready draft stale once the item has moved on', () => {
    const { events, add } = log();
    const ids = { itemId: ITEM, actionId: 'act-1' };
    add('item.upserted', 0, upserted(1))
      .add('action.requested', 1, { type: 'vault_note', revision: 1 }, ids)
      .add('action.drafted', 2, { type: 'vault_note', revision: 1, draftRef: 'drafts/act-1.json', tokens: 900, target: { path: 'a.md' } }, ids)
      .add('item.upserted', 3, upserted(2, true, 3));
    const p = replay(events);
    const s = summaryOf(p.items[ITEM], p.items[ITEM], { ...ctx, actions: Object.values(p.actions) });
    expect(s.actions.vault_note).toMatchObject({ status: 'ready', stale: true });
  });

  it('drops an action its retry replaced, so a discarded retry does not bring back the failure', () => {
    const { events, add } = log();
    const first = { itemId: ITEM, actionId: 'act-1' };
    const retry = { itemId: ITEM, actionId: 'act-2' };
    add('item.upserted', 0, upserted(1))
      .add('action.requested', 1, { type: 'confluence_entry', revision: 1 }, first)
      .add('action.failed', 2, { reason: 'model_error' }, first)
      .add('action.requested', 3, { type: 'confluence_entry', revision: 1, supersedes: 'act-1' }, retry)
      .add('action.drafted', 4, { type: 'confluence_entry', revision: 1, draftRef: 'drafts/act-2.json', tokens: 900, target: { pageId: '42', baseVersion: 7 } }, retry);
    const summary = () => {
      const p = replay(events);
      return summaryOf(p.items[ITEM], p.items[ITEM], { ...ctx, actions: Object.values(p.actions).reverse() }).actions;
    };
    expect(summary().confluence_entry).toMatchObject({ id: 'act-2', status: 'ready' });
    add('action.discarded', 5, { reason: 'discarded' }, retry);
    expect(summary().confluence_entry).toBeUndefined();
  });

  it('numbers entries by what was filed before: a draft after a filing is v2, and discarding it brings the filing back', () => {
    const { events, add } = log();
    const draft = (id: string) => ({ itemId: ITEM, actionId: id });
    const drafted = (id: string): EventData<'action.drafted'> => ({ type: 'confluence_entry', revision: 1, draftRef: `drafts/${id}.json`, tokens: 900, target: { pageId: '42', baseVersion: 7 } });
    add('item.upserted', 0, upserted(1))
      .add('action.requested', 1, { type: 'confluence_entry', revision: 1 }, draft('act-1'))
      .add('action.drafted', 2, drafted('act-1'), draft('act-1'))
      .add('action.approved', 3, undefined, draft('act-1'))
      .add('action.executed', 4, { dryRun: true, pageId: '42', pageVersion: 8 }, draft('act-1'));
    const summary = () => {
      const p = replay(events);
      return summaryOf(p.items[ITEM], p.items[ITEM], { ...ctx, actions: Object.values(p.actions).reverse() }).actions.confluence_entry;
    };
    expect(summary()).toMatchObject({ id: 'act-1', status: 'done', version: 1, repliesSince: false });
    add('item.upserted', 5, upserted(2, false, 5));
    expect(summary()).toMatchObject({ id: 'act-1', version: 1, repliesSince: true, stale: false });

    // A failed try and its retry don't count: the next entry is still v2.
    add('action.requested', 6, { type: 'confluence_entry', revision: 2 }, draft('act-2'))
      .add('action.failed', 7, { reason: 'model_error' }, draft('act-2'))
      .add('action.requested', 8, { type: 'confluence_entry', revision: 2, supersedes: 'act-2' }, draft('act-3'));
    expect(summary()).toMatchObject({ id: 'act-3', status: 'drafting', version: 2 });
    add('action.discarded', 9, { reason: 'discarded' }, draft('act-3'));
    expect(summary()).toMatchObject({ id: 'act-1', status: 'done', version: 1 });
  });
});

describe('openNext', () => {
  const asks = [
    { need: 'approve' as const, step: 'Approve branch protection', dueAt: at(60) },
    { need: 'review' as const, step: 'Review PR 63' },
  ];
  const next = { need: 'approve' as const, step: 'Approve branch protection', why: 'Team waiting', dueAt: at(60), asks };

  it('keeps the next step until it is ticked off, then moves to the first open ask', () => {
    expect(openNext(next, [])).toBe(next);
    expect(openNext(next, [askId('Review PR 63')])).toBe(next);
    expect(openNext(next, [askId('Approve branch protection')])).toEqual({ need: 'review', step: 'Review PR 63', why: '', asks });
    expect(openNext(next, asks.map((a) => askId(a.step)))).toBeUndefined();
  });
});

describe('budgetsOf', () => {
  const settings = { budgets: { triageCallsPerDay: 2, draftsPerDay: 5, costEquivalentPerDay: 1 }, baselineCostPerDay: 2 };

  it('counts today’s calls in London time and flags a hit budget', () => {
    const usage = [
      { at: '2026-10-04T22:59:00.000Z', purpose: 'triage' as const, costEquivalent: 0.5 }, // Sunday 23:59 London
      { at: '2026-10-04T23:01:00.000Z', purpose: 'triage' as const, costEquivalent: 0.1 },
      { at: '2026-10-05T07:00:00.000Z', purpose: 'triage' as const, costEquivalent: 0.1 },
      { at: '2026-10-05T07:30:00.000Z', purpose: 'draft_vault' as const, costEquivalent: 0.3 },
    ];
    const b = budgetsOf(usage, settings, new Date('2026-10-05T09:00:00.000Z'));
    expect(b.triage).toEqual({ used: 2, limit: 2, hit: true });
    expect(b.drafts).toEqual({ used: 1, limit: 5, hit: false });
    expect(b.cost.used).toBeCloseTo(0.5);
    expect(b.pctOfBaseline).toBe(25);
    expect(budgetsOf([], settings, new Date(T0), { drafts: true }).drafts.hit).toBe(true);
  });
});
