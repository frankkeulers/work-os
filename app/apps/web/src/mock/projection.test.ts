import { askId, replay, toLoggedDecision, type Projection, type WorkEvent } from '@work-os/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildState, type Preset } from './seed';
import { MockServer } from './server';
import type { MockState } from './types';

// The event log is the source of truth (PLAN.md §4.3): replaying the mock's events through the
// server's reducer must give back the mock's own inbox state.

function expectReplayMatches(s: MockState, events: WorkEvent[]) {
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
  const p: Projection = replay(events);

  expect(Object.keys(p.items).sort()).toEqual(Object.keys(s.items).sort());
  for (const rec of Object.values(s.items)) {
    const it = p.items[rec.item.id];
    expect(it, rec.key).toEqual({
      id: rec.item.id,
      source: rec.item.source,
      kind: rec.item.kind,
      title: rec.item.title,
      permalink: rec.item.permalink,
      participants: rec.item.participants,
      lastActivityAt: rec.item.lastActivityAt,
      revision: rec.item.revision,
      messageCount: rec.item.messageCount,
      status: rec.status,
      triageState: rec.triageState,
      decision: rec.decision && toLoggedDecision(rec.decision),
      correction: rec.correction,
      correctedFrom: rec.correctedFrom,
      snoozedUntil: rec.snoozedUntil,
      doneAt: rec.doneAt,
      doneBy: rec.doneBy,
      doneSource: rec.doneSource,
      doneReason: rec.doneReason,
      newReplies: rec.newReplies,
      backFromSnooze: rec.backFromSnooze,
      failCount: rec.failCount,
      notified: rec.notified,
      routed: rec.routed,
      topicOf: rec.topicOf,
      parts: rec.parts,
      notWith: rec.notWith,
      topicVersion: rec.topicVersion,
      asksDone: rec.asksDone,
      settlePending: rec.settlePending,
      settleFailures: rec.settleFailures,
      replyCheck: rec.replyCheck,
      finishPending: rec.finishPending,
      looksFinished: rec.looksFinished,
    });
  }

  expect(Object.keys(p.actions).sort()).toEqual(Object.keys(s.actions).sort());
  for (const a of Object.values(s.actions)) {
    const { error: _error, ...logged } = a;
    expect(p.actions[a.id], a.id).toEqual(logged);
  }
}

describe('replaying the seed log', () => {
  // inboxZero is left out: it marks waiting items triaged directly, to stage a screen.
  it.each<Preset>(['default', 'heavy', 'noBaseline', 'firstRun', 'topics'])('rebuilds the %s preset', (preset) => {
    const s = buildState(preset);
    expectReplayMatches(s, s.events);
  });
});

describe('replaying a session', () => {
  let server: MockServer;
  afterEach(() => {
    server.dispose();
    vi.useRealTimers();
  });

  const run = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const settle = async <T,>(p: Promise<T>, ms = 600): Promise<T> => {
    await run(ms);
    return p;
  };
  const state = () => (server as unknown as { s: MockState }).s;

  it('rebuilds the state after polls, replies, commands and drafts', async () => {
    vi.useFakeTimers();
    server = new MockServer();
    server.reset('topics'); // the default seed, plus topics
    const id = (key: string) => server.itemIdForKey(key)!;
    const ignore = () => undefined;

    // Polls: timeline threads, a VIP DM, twelve threads at once, replies to done, snoozed and corrected items.
    await settle(server.pollNow(), 4000);
    server.advanceClock(15);
    await run(4000);
    for (const outcome of ['vip_dm', 'batch12', 'reply_done', 'reply_snoozed', 'reply_corrected', 'reply_drafted'] as const) {
      server.simulatePoll(outcome);
      await run(4000);
    }

    // Inbox commands.
    await settle(server.markDone(id('t1')));
    await settle(server.reopen(id('t1')));
    await settle(server.markDone(id('t2')));
    await settle(server.snooze(id('t3'), new Date(server.now().getTime() + 5 * 60_000).toISOString()));
    await settle(server.correctTriage(id('e1'), { attention: 'today', confluence: false, vault: true }));
    await settle(server.correctTriage(id('x1'), { attention: 'none', confluence: false, vault: false }));
    server.advanceClock(6); // t3 comes back from snooze
    await run(6000);
    await settle(server.getItem(id('t3'))); // and is seen

    // Topics: tick an ask, done on a topic, split a piece out, regroup a conversation.
    const k1 = await settle(server.getItem(id('k1')));
    await settle(server.markAskDone(id('k1'), askId(k1.decision!.next!.asks![1].step)));
    await settle(server.markDone(id('k5')));
    await settle(server.splitPiece(id('k4')), 2000);
    await settle(server.regroup('C04INSIGHTS'), 2000);
    const items = state().items;
    expect(items[id('k4')]).toMatchObject({ topicOf: undefined, notWith: [id('k1')] });
    expect(items[id('k1')].parts).toEqual([id('k3'), id('k2')]);
    expect(items[id('k6')].status).toBe('done'); // a part follows its topic
    expect(items[id('r2')].topicOf).toBe(id('r1'));

    // Drafts: ready and approved, a page conflict, a people check, a cancel, a discard and a model error.
    const vault = await settle(server.requestDraft(id('f4'), 'vault_note'));
    await run(8000);
    await settle(server.saveDraftEdit(vault.id, 'Edited'));
    await settle(server.approveAction(vault.id), 3000);
    server.setNextDraftOutcome('confluence_conflict');
    const conf = (await settle(server.getItem(id('f1')))).actions.find((a) => a.type === 'confluence_entry')!;
    await settle(server.approveAction(conf.id), 3500);
    await run(8000);
    server.setNextDraftOutcome('people_check');
    await settle(server.requestDraft(id('t2'), 'confluence_entry'));
    await run(8000);
    const cancelled = await settle(server.requestDraft(id('f2'), 'vault_note'));
    await settle(server.cancelDraft(cancelled.id));
    const discarded = await settle(server.requestDraft(id('f3'), 'vault_note'));
    await run(8000);
    await settle(server.discardAction(discarded.id));
    server.setNextDraftOutcome('model_error');
    const failed = await settle(server.requestDraft(id('f2'), 'vault_note'));
    await run(8000);
    await settle(server.redraft(failed.id).catch(ignore));
    await run(8000);

    const s = state();
    expect(s.events.length).toBeLessThan(2000); // the mock keeps the last 2,000; the replay needs them all
    expectReplayMatches(s, s.events);
    // The session covered every item and action event type.
    const types = new Set(s.events.map((e) => e.type));
    for (const t of ['item.unsnoozed', 'item.seen', 'item.notified', 'item.reopened', 'triage.corrected', 'topic.routed', 'topic.askDone', 'action.edited', 'action.executing', 'action.executed', 'action.failed', 'action.discarded']) {
      expect(types, t).toContain(t);
    }
  });
});
