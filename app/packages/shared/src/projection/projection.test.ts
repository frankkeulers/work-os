import { describe, expect, it } from 'vitest';
import { toLoggedDecision, type EventData, type EventType, type WorkEvent } from '../events';
import type { TriageDecision } from '../schemas';
import { SeqGapError, reduce, replay } from './reduce';
import { emptyProjection } from './state';
import { finishQueue } from './transitions';
import { askId, conversationOf } from './topics';
import { budgetsOf, closedByReply, confirmedNow, filedAll, openNext, replyCloseCriteria, summaryOf } from './views';

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

  it('keeps "triage was right" for the decision it was said of, until a correction or a re-triage', () => {
    const { events, add } = log();
    add('item.upserted', 0, upserted(1)).add('triage.decided', 1, decided(1)).add('triage.confirmed', 2, { revision: 1 });
    expect(confirmedNow(replay(events).items[ITEM])).toBe(true);
    add('item.upserted', 3, upserted(2, false, 3)).add('triage.decided', 4, decided(2));
    expect(confirmedNow(replay(events).items[ITEM])).toBe(false); // a new decision, not yet confirmed
    add('triage.confirmed', 5, { revision: 2 });
    expect(confirmedNow(replay(events).items[ITEM])).toBe(true);
    add('triage.corrected', 6, { correction: { itemId: ITEM, itemRevision: 2, attention: 'now', confluence: false, vault: false, correctedAt: at(6) } });
    expect(confirmedNow(replay(events).items[ITEM])).toBe(false); // his correction stands instead
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

  it('keeps an approval from a batch, and knows when every suggested filing is written (CK-4.4)', () => {
    const { events, add } = log();
    const vault = { itemId: ITEM, actionId: 'act-v' };
    const conf = { itemId: ITEM, actionId: 'act-c' };
    add('item.upserted', 0, upserted(1))
      .add('triage.decided', 1, decided(1, 'none'))
      .add('action.requested', 2, { type: 'vault_note', revision: 1 }, vault)
      .add('action.drafted', 3, { type: 'vault_note', revision: 1, draftRef: 'drafts/act-v.json', tokens: 900, target: { path: 'Inbox/x.md' } }, vault)
      .add('action.approved', 4, { markDoneWhenFiled: true }, vault);
    let p = replay(events);
    expect(p.actions['act-v']).toMatchObject({ status: 'approved', markDoneWhenFiled: true });
    const newest = () => Object.values(p.actions).reverse();
    expect(filedAll(p.items[ITEM], newest())).toBe(false);
    add('action.executed', 5, { dryRun: true, path: 'Inbox/x.md' }, vault);
    p = replay(events);
    expect(filedAll(p.items[ITEM], newest())).toBe(true); // the decision suggests the vault only
    // A thread that mentions people still counts its Confluence suggestion (FR-10.1, amended).
    const flagged = { ...p.items[ITEM], decision: { ...p.items[ITEM].decision!, containsPeopleObservations: true, confluence: { suggested: true } } };
    expect(filedAll(flagged, newest())).toBe(false);
    // Corrected to Confluence as well: not filed until that is written too.
    add('triage.corrected', 6, { correction: { itemId: ITEM, itemRevision: 1, attention: 'none', confluence: true, vault: true, correctedAt: at(6) } });
    p = replay(events);
    expect(filedAll(p.items[ITEM], newest())).toBe(false);
    add('action.requested', 7, { type: 'confluence_entry', revision: 1 }, conf).add('action.drafted', 8, { type: 'confluence_entry', revision: 1, draftRef: 'drafts/act-c.json', tokens: 900, target: { pageId: '42', baseVersion: 7 } }, conf);
    add('action.approved', 9, undefined, conf).add('action.executed', 10, { dryRun: true, pageId: '42' }, conf);
    p = replay(events);
    expect(p.actions['act-c'].markDoneWhenFiled).toBeUndefined();
    expect(filedAll(p.items[ITEM], newest())).toBe(true);
    // Nothing suggested: nothing to have filed.
    expect(filedAll({ decision: undefined, correction: undefined }, newest())).toBe(false);
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

  it('takes a piece of Frank’s own as his reply: a settle check, not a re-triage (cockpit CK-2.1)', () => {
    const { events, add } = log();
    add('item.upserted', 0, piece(0), on(A))
      .add('topic.routed', 10, { by: 'model' }, on(A))
      .add('triage.decided', 11, decidedOn(A, 1, 0), on(A))
      .add('item.upserted', 40, piece(40), on(B))
      .add('topic.routed', 50, { into: A, by: 'model', fromMeOnly: true }, on(B));
    expect(replay(events).items[A]).toMatchObject({ parts: [B], topicVersion: 1, triageState: 'triaged', newReplies: false, settlePending: at(40) });
  });

  it('leaves a topic that no longer needs Frank alone when his own piece joins it', () => {
    const { events, add } = log();
    add('item.upserted', 0, piece(0), on(A))
      .add('topic.routed', 10, { by: 'model' }, on(A))
      .add('triage.decided', 11, { decision: toLoggedDecision({ ...decision(1, 'none'), itemId: A, topicVersion: 0 }) }, on(A))
      .add('item.upserted', 40, piece(40), on(B))
      .add('topic.routed', 50, { into: A, by: 'model', fromMeOnly: true }, on(B));
    const a = replay(events).items[A];
    expect(a).toMatchObject({ triageState: 'triaged', newReplies: false });
    expect(a.settlePending).toBeUndefined();
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

  it('counts settle checks against the triage budget (CK-2.2)', () => {
    const usage = [{ at: '2026-10-05T07:00:00.000Z', purpose: 'settle' as const, costEquivalent: 0.1 }];
    expect(budgetsOf(usage, settings, new Date('2026-10-05T09:00:00.000Z')).triage.used).toBe(1);
  });
});

describe('settle checks on Frank’s replies (cockpit CK-2.1–2.3)', () => {
  const ITEM_SUMMARY = { actions: [], quietMinutes: 10, now: at(60), triageBudgetHit: false, text: {} };
  const checked = (through: number, settled: string[], allSettled: boolean): EventData<'settle.checked'> => ({ revision: 2, through: at(through), batchId: 'settle-1', allSettled, settled });

  it('waits for a check when Frank replies to an open item that needs him, and not otherwise', () => {
    const { events, add } = log();
    add('item.upserted', 0, upserted(1)).add('triage.decided', 10, decided(1)).add('item.upserted', 20, upserted(2, true, 20));
    expect(replay(events).items[ITEM]).toMatchObject({ settlePending: at(20), triageState: 'triaged' });
    expect(summaryOf(replay(events).items[ITEM], replay(events).items[ITEM], ITEM_SUMMARY)).toMatchObject({ settling: true });

    // Low priority, To file, snoozed, done or not yet triaged: his reply asks nothing of the check.
    for (const prep of [
      (c: ReturnType<typeof log>) => c.add('triage.decided', 10, decided(1, 'none')),
      (c: ReturnType<typeof log>) => c.add('triage.decided', 10, decided(1)).add('item.snoozed', 11, { until: at(300) }),
      (c: ReturnType<typeof log>) => c.add('triage.decided', 10, decided(1)).add('item.done', 11, undefined),
      () => undefined,
    ]) {
      const c = log();
      c.add('item.upserted', 0, upserted(1));
      prep(c);
      c.add('item.upserted', 20, upserted(2, true, 20));
      expect(replay(c.events).items[ITEM].settlePending).toBeUndefined();
    }
  });

  it('closes the item when the check finds every ask settled, and says it was his reply', () => {
    const { events, add } = log();
    add('item.upserted', 0, upserted(1)).add('triage.decided', 10, decided(1)).add('item.upserted', 20, upserted(2, true, 20));
    add('settle.checked', 21, checked(20, ['a1'], true)).add('item.done', 21, { by: 'reply', source: 'slack', messageId: '1791190000.000200', check: 'settle-1' });
    const it = replay(events).items[ITEM];
    expect(it).toMatchObject({ status: 'done', doneBy: 'reply', doneSource: 'slack', replyCheck: { allSettled: true, settled: 1 } });
    expect(it.settlePending).toBeUndefined();
    expect(summaryOf(it, it, ITEM_SUMMARY)).toMatchObject({ lane: 'done', doneBy: 'reply', doneSource: 'slack' });

    // Undo: back in its lane, nothing left of the close or the check.
    add('item.reopened', 22, undefined);
    const back = replay(events).items[ITEM];
    expect(back).toMatchObject({ status: 'open' });
    expect(back.doneBy).toBeUndefined();
    expect(back.replyCheck).toBeUndefined();

    // Or someone else writes: it comes back with the next decision, no longer closed by anyone.
    add('item.done', 23, { by: 'reply', source: 'slack', messageId: '1791190000.000200', check: 'settle-2' }).add('item.upserted', 30, upserted(3, false, 30)).add('triage.decided', 40, decided(3));
    expect(replay(events).items[ITEM]).toMatchObject({ status: 'open', newReplies: true });
    expect(replay(events).items[ITEM].doneBy).toBeUndefined();
  });

  it('ticks the settled asks of a topic and keeps it open on the first one left', () => {
    const asks = [
      { need: 'decide' as const, step: 'Pick the three FQ3 items' },
      { need: 'reply' as const, step: 'Say who owns bulk export' },
    ];
    const next = { need: 'decide' as const, step: asks[0].step, why: 'The plan locks this week', asks };
    const { events, add } = log();
    add('item.upserted', 0, upserted(1)).add('triage.decided', 10, decided(1)).add('item.upserted', 20, upserted(2, true, 20));
    add('settle.checked', 21, checked(20, [askId(asks[0].step)], false)).add('topic.askDone', 21, { askId: askId(asks[0].step), by: 'reply' });
    const it = replay(events).items[ITEM];
    expect(it).toMatchObject({ status: 'open', asksDone: [askId(asks[0].step)], replyCheck: { allSettled: false, settled: 1 } });
    expect(openNext(next, it.asksDone)?.step).toBe('Say who owns bulk export');
    expect(summaryOf(it, it, { ...ITEM_SUMMARY, text: { next, settleWhy: 'Bulk export’s owner is still open' } }).replyCheck).toEqual({ at: at(21), allSettled: false, settled: 1, why: 'Bulk export’s owner is still open' });
  });

  it('keeps waiting when he replies again during a check, and drops the check once someone else writes', () => {
    const { events, add } = log();
    add('item.upserted', 0, upserted(1)).add('triage.decided', 10, decided(1)).add('item.upserted', 20, upserted(2, true, 20)).add('item.upserted', 25, upserted(3, true, 25));
    add('settle.checked', 26, checked(20, [], false)); // the check only saw the first reply
    expect(replay(events).items[ITEM]).toMatchObject({ settlePending: at(25), replyCheck: { allSettled: false, settled: 0 } });

    add('item.upserted', 30, upserted(4, false, 30));
    const it = replay(events).items[ITEM];
    expect(it).toMatchObject({ triageState: 'pending', newReplies: true });
    expect(it.settlePending).toBeUndefined();
    expect(it.replyCheck).toBeUndefined();
  });

  it('retries a failed check, and gives up after the third failure with the item as it was', () => {
    const { events, add } = log();
    add('item.upserted', 0, upserted(1)).add('triage.decided', 10, decided(1)).add('item.upserted', 20, upserted(2, true, 20));
    add('settle.failed', 21, { revision: 2, attempts: 1, reason: 'claude unavailable' });
    expect(replay(events).items[ITEM]).toMatchObject({ status: 'open', settlePending: at(20), settleFailures: 1 });
    add('settle.failed', 31, { revision: 2, attempts: 3, reason: 'claude unavailable' });
    const it = replay(events).items[ITEM];
    expect(it).toMatchObject({ status: 'open', settleFailures: 3 });
    expect(it.settlePending).toBeUndefined();
  });

  it('says who closed each done item: Frank, his reply, or the source', () => {
    const { events, add } = log();
    add('item.upserted', 0, upserted(1)).add('item.done', 1, undefined);
    expect(replay(events).items[ITEM]).toMatchObject({ doneBy: 'you' });
    add('item.reopened', 2, undefined).add('item.done', 3, { by: 'source', reason: 'You accepted it in Outlook' });
    expect(replay(events).items[ITEM]).toMatchObject({ doneBy: 'source', doneReason: 'You accepted it in Outlook' });
  });

  it('counts today’s closes by reply for Needs you’s footer, latest first', () => {
    const rows = [
      { doneBy: 'reply' as const, doneAt: '2026-10-05T12:40:00.000Z', title: 'Head of Sales' },
      { doneBy: 'reply' as const, doneAt: '2026-10-05T09:10:00.000Z', title: '#mvi-launch' },
      { doneBy: 'reply' as const, doneAt: '2026-10-04T16:00:00.000Z', title: 'yesterday' },
      { doneBy: 'you' as const, doneAt: '2026-10-05T12:50:00.000Z', title: 'by hand' },
    ];
    expect(closedByReply(rows, '2026-10-05T12:48:00.000Z')).toEqual({ today: 2, latestAt: '2026-10-05T12:40:00.000Z', latestTitle: 'Head of Sales' });
    expect(closedByReply([], '2026-10-05T12:48:00.000Z')).toEqual({ today: 0 });
  });
});

describe('Looks finished (cockpit CK-2.10)', () => {
  /** Today at revision 1; others write; the re-triage at revision 2 asks for a finish check. */
  const pending = () => {
    const { events, add } = log();
    add('item.upserted', 0, upserted(1))
      .add('triage.decided', 1, decided(1))
      .add('item.upserted', 20, upserted(2))
      .add('triage.decided', 30, { ...decided(2, 'none'), finishCheck: true });
    return { events, add };
  };

  it('waits for the check after a decision that asks for one, and looks finished once it settles every ask', () => {
    const { events, add } = pending();
    expect(replay(events).items[ITEM]).toMatchObject({ finishPending: at(10) });
    expect(finishQueue(replay(events).items[ITEM])).toBe(true);
    add('finish.checked', 31, { revision: 2, batchId: 'b', allSettled: true });
    const it = replay(events).items[ITEM];
    expect(it).toMatchObject({ looksFinished: at(31) });
    expect(it.finishPending).toBeUndefined();
  });

  it('suggests nothing when the check finds an ask still open, or fails', () => {
    const open = pending();
    open.add('finish.checked', 31, { revision: 2, batchId: 'b', allSettled: false });
    expect(replay(open.events).items[ITEM]).not.toHaveProperty('looksFinished', expect.anything());
    const failed = pending();
    failed.add('finish.failed', 31, { revision: 2, reason: 'content missing' });
    const it = replay(failed.events).items[ITEM];
    expect(it.finishPending).toBeUndefined();
    expect(it.looksFinished).toBeUndefined();
  });

  it('drops the suggestion on Done, a correction, or new messages from someone else, and old decisions never ask for a check', () => {
    for (const next of [
      (add: ReturnType<typeof log>['add']) => add('item.done', 40, undefined),
      (add: ReturnType<typeof log>['add']) => add('triage.corrected', 40, { correction: { itemId: ITEM, itemRevision: 2, attention: 'today', confluence: false, vault: false, correctedAt: at(40) } }),
      (add: ReturnType<typeof log>['add']) => add('item.upserted', 40, upserted(3)),
    ]) {
      const { events, add } = pending();
      add('finish.checked', 31, { revision: 2, batchId: 'b', allSettled: true });
      next(add);
      expect(replay(events).items[ITEM].looksFinished).toBeUndefined();
    }
    const { events, add } = log();
    add('item.upserted', 0, upserted(1)).add('triage.decided', 1, decided(1)).add('item.upserted', 20, upserted(2)).add('triage.decided', 30, decided(2, 'none'));
    expect(replay(events).items[ITEM].finishPending).toBeUndefined();
  });
});

describe('C1 and C2: closes by reply (cockpit CK-2.8)', () => {
  const reply = { by: 'reply' as const, source: 'slack' as const, messageId: 'm', check: 'settle-1' };

  it('counts Needs you exits, those closed by Frank’s reply, and reply closes he undid within a day', () => {
    const { events, add } = log();
    const other = { itemId: 'slack:C1:2' };
    const low = { itemId: 'slack:C1:3' };
    add('item.upserted', 0, upserted(1)).add('triage.decided', 1, decided(1)).add('item.done', 30, reply); // closed by reply
    add('item.reopened', 90, undefined); // undone within 24 h: a false close
    add('item.upserted', 0, upserted(1), other).add('triage.decided', 1, { decision: toLoggedDecision({ ...decision(1, 'now'), itemId: other.itemId }) }, other).add('item.done', 40, undefined, other); // by hand
    add('item.upserted', 0, upserted(1), low).add('triage.decided', 1, { decision: toLoggedDecision({ ...decision(1, 'none'), itemId: low.itemId }) }, low).add('item.done', 50, undefined, low); // Low priority: not an exit
    expect(replay(events).closes).toEqual({ '2026-10-05': { exits: 2, byReply: 1, undone: 1 } });

    // Reopened a day later: not counted as undone.
    const late = log();
    late.add('item.upserted', 0, upserted(1)).add('triage.decided', 1, decided(1)).add('item.done', 30, reply).add('item.reopened', 30 + 25 * 60, undefined);
    expect(replay(late.events).closes).toEqual({ '2026-10-05': { exits: 1, byReply: 1, undone: 0 } });
  });

  it('reads the last 14 days into C1 and C2', () => {
    const now = new Date('2026-10-09T12:00:00.000Z');
    expect(replyCloseCriteria(undefined, now).map((c) => [c.id, c.status])).toEqual([
      ['C1', 'pending'],
      ['C2', 'pending'],
    ]);
    const c = replyCloseCriteria({ '2026-10-09': { exits: 10, byReply: 4, undone: 0 }, '2026-10-01': { exits: 10, byReply: 1, undone: 1 }, '2026-09-20': { exits: 50, byReply: 0, undone: 0 } }, now);
    expect(c).toEqual([
      { id: 'C1', name: 'Needs you closed by your reply', value: '25%', target: '≥ 40%', status: 'at_risk', statusLabel: '5 of 20 in 14 days' },
      { id: 'C2', name: 'False closes', value: '20%', target: '≤ 2%', status: 'at_risk', statusLabel: '1 of 5 undone' },
    ]);
  });
});
