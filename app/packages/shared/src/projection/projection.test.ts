import { describe, expect, it } from 'vitest';
import { toLoggedDecision, type EventData, type EventType, type WorkEvent } from '../events';
import type { TriageDecision } from '../schemas';
import { SeqGapError, reduce, replay } from './reduce';
import { emptyProjection } from './state';
import { budgetsOf, summaryOf } from './views';

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
