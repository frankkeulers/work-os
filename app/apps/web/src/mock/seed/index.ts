import type { WorkEvent } from '@work-os/shared';
import { addMins, buildDecision, makeEvent, newRec } from '../build';
import { buildDraft } from '../drafts';
import { firstMatchingRule } from '../rules';
import type { ItemRec, MockState, ThreadSeed } from '../types';
import { SEED_RULE_HITS, SEED_RULES, SEED_SETTINGS } from './config';
import { BATCH_TWELVE, SEED_THREADS, TIMELINE } from './threads';
import { SEED_EVALS, seedUsage } from './usage';
import { isWorkHours } from '../../lib/time';

export const SEED_CLOCK = '2026-10-05T08:45:00.000Z'; // Mon 5 Oct 2026, 09:45 London
export const STATE_VERSION = 3;

export type Preset = 'default' | 'firstRun' | 'inboxZero' | 'heavy' | 'noBaseline';

const clone = <T>(v: T): T => structuredClone(v);

/** The poll that would have picked up a thread that went quiet at `iso`. */
function pollAfter(iso: string, workHours: string): string {
  const quiet = new Date(addMins(iso, SEED_SETTINGS.triage.quietMinutes));
  const step = isWorkHours(quiet, workHours) ? 10 : 60;
  const ms = step * 60_000;
  return new Date(Math.ceil(quiet.getTime() / ms) * ms + 2 * 60_000).toISOString();
}

export function buildState(preset: Preset = 'default'): MockState {
  const clock = SEED_CLOCK;
  const settings = clone(SEED_SETTINGS);
  const rules = clone(SEED_RULES);
  if (preset === 'noBaseline') settings.baselineCostPerDay = null;

  let seq = 0;
  const events: WorkEvent[] = [];
  const ev = (type: WorkEvent['type'], at: string, extra: Parameters<typeof makeEvent>[3] = {}) =>
    events.push(makeEvent(++seq, type, at, extra));

  const state: MockState = {
    schemaVersion: STATE_VERSION,
    clock,
    items: {},
    actions: {},
    drafts: {},
    results: {},
    events,
    usage: [],
    evals: clone(SEED_EVALS),
    settings,
    rules,
    ruleHits: { ...SEED_RULE_HITS },
    savedAt: '2026-10-02T16:40:00.000Z',
    checkedAt: '2026-10-05T07:02:00.000Z',
    labelCount: 200,
    correctionCount: 38,
    source: { status: 'healthy', lastPollAt: '2026-10-05T08:42:00.000Z', nextPollAt: '2026-10-05T08:52:00.000Z', rateLimitedToday: 0, cursor: '1759653720.000100' },
    poll: { phase: 'idle' },
    pollsSkippedToday: 9,
    timeline: TIMELINE.map((t) => ({ at: addMins(clock, t.afterMins), thread: t.thread, reply: t.reply })),
    firstRunSeeds: [],
    flags: { forceTriageBudget: false, forceDraftBudget: false, connection: 'up', fileVaultOff: false, firstRun: false },
    nextDraftOutcome: 'normal',
    evalRunning: false,
    seq: 0,
  };

  if (preset === 'firstRun') {
    state.firstRunSeeds = SEED_THREADS.filter((t) => !t.key.startsWith('d') && !t.key.startsWith('s'));
    state.flags.firstRun = true;
    state.source = { status: 'never', rateLimitedToday: 0 };
    state.evals = [];
    state.ruleHits = Object.fromEntries(rules.map((r) => [r.id, 0]));
    state.labelCount = 0;
    state.correctionCount = 0;
    state.pollsSkippedToday = 0;
    state.savedAt = clock;
    state.seq = seq;
    return state;
  }

  const seeds: ThreadSeed[] = [...SEED_THREADS];
  if (preset === 'heavy') {
    for (let round = 0; round < 4; round++) {
      BATCH_TWELVE.forEach((b, i) =>
        seeds.push({ ...b, key: `h${round}-${i}`, messages: b.messages.map((m) => ({ ...m, minsAgo: 40 + round * 95 + i * 7 })) }),
      );
    }
  }

  const byKey: Record<string, ItemRec> = {};
  for (const seed of seeds) {
    const rec = newRec(seed, clock);
    rec.arrivedAt = rec.item.messages[0]?.ts ?? clock;
    byKey[seed.key] = rec;
    state.items[rec.item.id] = rec;
    ev('item.upserted', rec.item.lastActivityAt, { itemId: rec.item.id, data: { revision: 1 } });
  }

  byKey.f1.item.revision = 2;

  // Triage everything except the threads still inside the quiet window and the failed one.
  const batches: Record<string, ItemRec[]> = {};
  for (const rec of Object.values(state.items)) {
    if (rec.key === 'q1' || rec.key === 'q2') continue;
    const at = pollAfter(rec.item.lastActivityAt, settings.schedule.workHours);
    if (rec.key === 'x1') {
      rec.triageState = 'failed';
      rec.failCount = 2;
      ev('triage.failed', at, { itemId: rec.item.id, data: { attempts: 2, reason: 'schema validation failed' } });
      continue;
    }
    const rule = firstMatchingRule(rec.item, rules, settings);
    let decision;
    if (rule && (rule.outcome.type === 'now' || rule.outcome.type === 'today')) {
      decision = buildDecision(rec, rec.item.lastActivityAt, { kind: 'rule', ruleId: rule.id, attention: rule.outcome.type });
    } else {
      const batchId = `batch-${at}`;
      (batches[batchId] ??= []).push(rec);
      decision = buildDecision(rec, at, {
        kind: 'model',
        batchId,
        ruleId: rule?.id,
        min: rule?.outcome.type === 'model' ? rule.outcome.min : undefined,
        model: 'haiku-4.5',
      });
    }
    rec.decision = decision;
    rec.triageState = 'triaged';
    rec.notified = decision.attention === 'now';
    ev('triage.decided', decision.decidedAt, { itemId: rec.item.id, data: { attention: decision.attention, by: decision.decidedBy, ruleId: decision.ruleId ?? null } });
  }
  for (const [batchId, recs] of Object.entries(batches)) {
    for (const rec of recs) rec.batch = { at: batchId.slice(6), threads: recs.length, calls: 1 };
  }

  // Item states.
  const snooze = (rec: ItemRec, until: string, at: string) => {
    rec.status = 'snoozed';
    rec.snoozedUntil = until;
    ev('item.snoozed', at, { itemId: rec.item.id, data: { until } });
  };
  snooze(byKey.s1, addMins(clock, 40), addMins(clock, -20));
  snooze(byKey.s2, '2026-10-06T08:00:00.000Z', addMins(clock, -60));

  const done = (rec: ItemRec, at: string) => {
    rec.status = 'done';
    rec.doneAt = at;
    ev('item.done', at, { itemId: rec.item.id });
  };
  done(byKey.d1, addMins(byKey.d1.item.lastActivityAt, 2));
  done(byKey.d2, addMins(byKey.d2.item.lastActivityAt, 60 * 24));
  done(byKey.d3, addMins(clock, -20));
  // d2 is past retention: raw content removed, permalink kept (FR-12.1).
  byKey.d2.item.messages = [];
  byKey.d2.item.contentExpired = true;

  // f1 already has both drafts ready, as in the Item detail artboard.
  const addAction = (rec: ItemRec, type: 'vault_note' | 'confluence_entry', at: string, status: 'ready' | 'done') => {
    const id = `act-${rec.key}-${type === 'vault_note' ? 'v' : 'c'}1`;
    const draft = buildDraft(rec, type, settings, at, { attempt: 1 });
    state.drafts[id] = draft;
    state.actions[id] = {
      id,
      itemId: rec.item.id,
      itemRevision: rec.item.revision,
      type,
      status,
      target: draft.kind === 'confluence' ? { pageId: draft.pageId, baseVersion: draft.baseVersion } : { path: draft.path },
      draftRef: `drafts/${id}.json`,
      createdAt: at,
      updatedAt: at,
    };
    ev('action.requested', at, { itemId: rec.item.id, actionId: id, data: { type } });
    ev('action.drafted', addMins(at, 1), { itemId: rec.item.id, actionId: id, data: { type, tokens: draft.tokens } });
    if (status === 'done') {
      ev('action.approved', addMins(at, 6), { itemId: rec.item.id, actionId: id });
      ev('action.executed', addMins(at, 6), { itemId: rec.item.id, actionId: id, data: { dryRun: false, pageVersion: draft.kind === 'confluence' ? draft.baseVersion + 1 : null } });
      state.results[id] = draft.kind === 'confluence' ? `Written to page v${draft.baseVersion + 1}. Logged action.executed.` : `Written to ${draft.path}.`;
    }
  };
  addAction(byKey.f1, 'confluence_entry', addMins(clock, -25), 'ready');
  addAction(byKey.f1, 'vault_note', addMins(clock, -14), 'ready');
  addAction(byKey.f3, 'confluence_entry', addMins(byKey.f3.item.lastActivityAt, 30), 'done');

  state.usage = seedUsage(byKey.f1.item.id);

  if (preset === 'inboxZero') {
    for (const rec of Object.values(state.items)) {
      if (rec.status !== 'done') done(rec, addMins(clock, -5));
      if (rec.triageState !== 'triaged') rec.triageState = 'triaged';
    }
    state.timeline = [];
  }

  events.sort((a, b) => a.at.localeCompare(b.at));
  state.seq = seq;
  return state;
}
