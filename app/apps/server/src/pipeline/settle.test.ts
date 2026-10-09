import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettleDecision, askId, type Attention, type Item, type Message, type NextStep } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClaudeAdapter, RunSpec } from '../claude/adapter';
import { ClaudeError, ClaudeOutputError } from '../claude/errors';
import { settleFor } from '../claude/fakeClaude';
import { DEFAULT_RULES, defaultSettings } from '../config/defaults';
import { initDataDir } from '../config/dataDir';
import { ItemFiles } from '../store/items';
import { Store } from '../store/store';
import { judge, openAsks, renderChecks, runSettle, trailingReply, type SettleCheck, type SettleDeps } from './settle';

const NOW = new Date('2026-10-09T12:48:00.000Z'); // Fri 13:48 London
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const ID = 'slack:C1:1791189720.000100';
const FIXTURES = join(import.meta.dirname, '../claude/fixtures/settle');

type Fixture = { about: string; reply: string[]; answer: Omit<SettleDecision, 'itemId' | 'itemRevision'> };
const fixture = async (name: string): Promise<Fixture> => JSON.parse(await readFile(join(FIXTURES, `${name}.json`), 'utf8')) as Fixture;

describe('settle fixtures', () => {
  it('each holds an answer in the shape the check expects', async () => {
    const names = (await readdir(FIXTURES)).filter((f) => f.endsWith('.json'));
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const f of names) {
      const x = await fixture(f.replace(/\.json$/, ''));
      expect(SettleDecision.safeParse({ itemId: ID, itemRevision: 2, ...x.answer }).success, f).toBe(true);
    }
  });
});

describe('the settle check’s input', () => {
  it('lists a topic’s open asks, or the next step alone, or the summary as a reply', () => {
    const asks = [
      { need: 'decide' as const, step: 'Pick the three FQ3 items' },
      { need: 'reply' as const, step: 'Say who owns bulk export' },
    ];
    expect(openAsks({ next: { need: 'decide', step: asks[0].step, why: 'w', asks } }, [askId(asks[0].step)])).toEqual([{ index: 0, need: 'reply', step: 'Say who owns bulk export' }]);
    expect(openAsks({ next: { need: 'approve', step: 'Approve the go/no-go', why: 'w' } })).toEqual([{ index: 0, need: 'approve', step: 'Approve the go/no-go' }]);
    expect(openAsks({ summary: 'Matt asks for the slot' })).toEqual([{ index: 0, need: 'reply', step: 'Matt asks for the slot' }]);
  });

  it('takes Frank’s messages after the last one from anyone else as his reply', () => {
    const m = (author: string, text: string) => ({ author, at: NOW.toISOString(), text });
    expect(trailingReply([m('me', 'earlier'), m('Matt', 'go?'), m('me', 'yes'), m('me', 'at 14:00')]).map((x) => x.text)).toEqual(['yes', 'at 14:00']);
    expect(trailingReply([m('me', 'hi'), m('Matt', 'go?')])).toEqual([]);
  });

  it('gives the time in London and the checks as JSON', () => {
    expect(renderChecks([], NOW).split('\n').slice(0, 3)).toEqual(['Now: 2026-10-09T12:48:00.000Z (Fri 13:48 in London)', 'Check these 0 replies. Answer with the JSON only.', '<checks>']);
  });

  it('closes only when every ask sent is settled, whatever the model says of the whole', () => {
    const check = { asks: [{ index: 0 }, { index: 1 }].map((a) => ({ ...a, need: 'reply' as const, step: `ask ${a.index}` })) } as SettleCheck;
    const d = (asks: SettleDecision['asks'], allSettled: boolean): SettleDecision => ({ itemId: ID, itemRevision: 2, asks, allSettled });
    expect(judge(check, d([{ index: 0, settled: true, why: 'a' }], true))).toEqual({ settled: [check.asks[0]], allSettled: false });
    expect(judge(check, d([{ index: 0, settled: true, why: 'a' }, { index: 1, settled: false, why: 'b' }], false))).toMatchObject({ allSettled: false, why: 'b' });
    expect(judge(check, d([{ index: 0, settled: true, why: 'a' }, { index: 1, settled: true, why: 'b' }, { index: 7, settled: false, why: 'c' }], false))).toMatchObject({ allSettled: true });
  });
});

describe('runSettle (cockpit CK-2.2, CK-2.3)', () => {
  let dir: string;
  let store: Store;
  let items: ItemFiles;
  let settings: ReturnType<typeof defaultSettings>;
  let answers: (Omit<SettleDecision, 'itemId' | 'itemRevision'> | Error)[];
  let calls: RunSpec[];
  let deps: SettleDeps;
  let budgetHit: boolean;

  const claude = {
    structured: async (spec: RunSpec) => {
      calls.push(spec);
      const checks = JSON.parse(/<checks>\n([\s\S]*)\n<\/checks>/.exec(spec.prompt)![1]) as SettleCheck[];
      const next = answers.shift();
      if (next instanceof Error) throw next;
      const value = next ? { decisions: checks.map((c) => ({ itemId: c.itemId, itemRevision: c.itemRevision, ...next })) } : settleFor(checks);
      return { value, attempts: 1, usage: [{}] };
    },
  } as unknown as ClaudeAdapter;

  const msg = (id: string, mins: number, text: string, authorId = 'U2'): Message => ({ id, authorId, ts: minsAgo(mins), text });
  const upsert = (it: Item, fromMeOnly: boolean) =>
    store.append({
      type: 'item.upserted',
      itemId: it.id,
      data: { source: it.source, kind: it.kind, title: it.title, permalink: it.permalink, participants: it.participants, lastActivityAt: it.lastActivityAt, revision: it.revision, messageCount: it.messageCount, fromMeOnly },
    });

  /** A triaged thread from Matt, with its next step. */
  async function add(attention: Attention = 'now', next?: NextStep, id = ID) {
    const messages = [msg('m1', 30, 'Can we lock the go/no-go for 14:00?')];
    const it: Item = { id, source: 'slack', kind: 'thread', title: '#mvi-launch', permalink: 'https://x/p1', participants: [{ id: 'U2', name: 'Matt' }], messages, messageCount: 1, lastActivityAt: messages[0].ts, revision: 1, schemaVersion: 1 };
    await items.write({ item: it, text: { summary: 'Matt asks to lock the go/no-go', reason: 'r', ...(next && { next }) }, schemaVersion: 1 });
    await upsert(it, false);
    await store.append({
      type: 'triage.decided',
      itemId: id,
      data: { decision: { itemId: id, itemRevision: 1, topicVersion: 0, attention, confluence: { suggested: false }, vault: { suggested: false }, containsPeopleObservations: false, decidedBy: 'model', decidedAt: minsAgo(20) } },
    });
    return it;
  }

  /** A new revision of the thread: Frank's reply, or someone else's. */
  async function reply(text: string, mins = 2, author = 'UFRANK', id = ID) {
    const stored = (await items.read('slack', id))!;
    const messages = [...stored.item.messages, msg(`m${stored.item.messages.length + 1}`, mins, text, author)];
    const it = { ...stored.item, messages, messageCount: messages.length, lastActivityAt: messages.at(-1)!.ts, revision: stored.item.revision + 1 };
    await items.write({ ...stored, item: it });
    await upsert(it, author === 'UFRANK');
    return it;
  }

  const p = () => store.projection.items[ID];
  const signal = () => new AbortController().signal;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workos-settle-'));
    settings = defaultSettings(dir);
    await initDataDir(dir, { settings, rules: DEFAULT_RULES });
    ({ store } = await Store.open({ dataDir: dir, now: () => NOW }));
    items = new ItemFiles(join(dir, 'items'));
    answers = [];
    calls = [];
    budgetHit = false;
    deps = { store, items, claude, now: () => NOW, config: () => ({ settings }), me: () => ({ id: 'UFRANK' }), prompt: async () => ({ text: 'settle', version: 'settle v1#abc' }), budgetHit: () => budgetHit };
  });
  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('closes the item when Frank’s reply settles its ask, saying it was his reply', async () => {
    await add();
    await reply('Yes, go ahead with the 14:00 slot.');
    answers.push((await fixture('settled')).answer);
    const run = await runSettle(deps, signal());
    expect(run).toEqual({ calls: 1, checked: 1, closed: 1, failed: 0, paused: 0 });
    expect(calls[0]).toMatchObject({ purpose: 'settle', model: settings.models.triage, system: 'settle', itemIds: [ID] });
    const sent = JSON.parse(/<checks>\n([\s\S]*)\n<\/checks>/.exec(calls[0].prompt)![1]) as SettleCheck[];
    expect(sent[0]).toMatchObject({ itemId: ID, itemRevision: 2, asks: [{ index: 0, need: 'reply', step: 'Matt asks to lock the go/no-go' }], reply: [{ text: 'Yes, go ahead with the 14:00 slot.' }] });
    expect(sent[0].thread.messages.map((m) => m.author)).toEqual(['Matt', 'me']);
    expect(p()).toMatchObject({ status: 'done', doneBy: 'reply', doneSource: 'slack', replyCheck: { allSettled: true } });
    expect(p().settlePending).toBeUndefined();
    const done = store.projection.lastSeq;
    expect(done).toBeGreaterThan(0);
    // The snapshot for a label if Frank undoes it, in the item's file, never the log.
    const stored = await items.read('slack', ID);
    expect(stored?.settle).toMatchObject({ batchId: expect.stringMatching(/^settle-/), promptVersion: 'settle v1#abc', decision: { allSettled: true }, input: { itemId: ID } });
    // Nothing waits any more: no second call.
    await runSettle(deps, signal());
    expect(calls).toHaveLength(1);
  });

  it('keeps the item when the reply only holds it, with the reason for its row', async () => {
    await add('today');
    await reply('Will look later today');
    answers.push((await fixture('holding')).answer);
    expect(await runSettle(deps, signal())).toMatchObject({ checked: 1, closed: 0 });
    expect(p()).toMatchObject({ status: 'open', replyCheck: { allSettled: false, settled: 0 } });
    expect(p().settlePending).toBeUndefined();
    expect(items.text(ID)?.settleWhy).toBe('You said you’d look later; the go/no-go is still yours.');
  });

  it('ticks off the asks the reply settles and leaves the rest open', async () => {
    const asks = [
      { need: 'decide' as const, step: 'Pick the three FQ3 items' },
      { need: 'reply' as const, step: 'Say who owns bulk export' },
    ];
    await add('today', { need: 'decide', step: asks[0].step, why: 'The plan locks this week', asks });
    await reply("Let's take bulk export, AIS gaps and the alerts API for FQ3.");
    answers.push((await fixture('partial')).answer);
    expect(await runSettle(deps, signal())).toMatchObject({ checked: 1, closed: 0 });
    expect(p()).toMatchObject({ status: 'open', asksDone: [askId(asks[0].step)], replyCheck: { allSettled: false, settled: 1 } });
  });

  it('leaves it open when closing on reply is off, while still checking', async () => {
    settings = { ...settings, triage: { ...settings.triage, closeOnReply: { enabled: false, sources: { slack: true } } } };
    await add();
    await reply('Yes, go ahead.');
    expect(await runSettle(deps, signal())).toMatchObject({ calls: 1, checked: 1, closed: 0 });
    expect(p()).toMatchObject({ status: 'open', replyCheck: { allSettled: true } });
  });

  it('checks only open items in Needs you or This week, on a source it runs for', async () => {
    await add('none');
    await reply('thanks');
    expect(await runSettle(deps, signal())).toEqual({ calls: 0, checked: 0, closed: 0, failed: 0, paused: 0 });

    // Outlook waits for Frank to turn it on (CK-2.9).
    settings = { ...settings, triage: { ...settings.triage, closeOnReply: { enabled: true, sources: { slack: false } } } };
    await add('now', undefined, 'slack:C2:1791189720.000200');
    await reply('Done.', 2, 'UFRANK', 'slack:C2:1791189720.000200');
    expect((await runSettle(deps, signal())).calls).toBe(0);
  });

  it('drops a check that someone else’s message overtook, and checks a later reply again', async () => {
    await add();
    await reply('Yes, go ahead.', 3);
    // Matt writes while the call runs: the item is triaged again instead.
    const slow = claude.structured.bind(claude);
    deps.claude = { structured: async (spec: RunSpec, schema: unknown) => {
      await reply('Actually wait', 1, 'U2');
      return (slow as (s: RunSpec, z: unknown) => Promise<unknown>)(spec, schema);
    } } as unknown as ClaudeAdapter;
    expect(await runSettle(deps, signal())).toMatchObject({ checked: 0, closed: 0 });
    expect(p()).toMatchObject({ status: 'open', triageState: 'pending', newReplies: true });
    expect(p().replyCheck).toBeUndefined();
  });

  it('waits while the budget is spent', async () => {
    await add();
    await reply('Yes.');
    budgetHit = true;
    expect(await runSettle(deps, signal())).toMatchObject({ calls: 0, paused: 1 });
    expect(p().settlePending).toBe(minsAgo(2));
  });

  it('retries a failed check and gives up after the third, leaving the item as it was', async () => {
    await add();
    await reply('Yes.');
    answers.push(new ClaudeOutputError(2, 'bad'));
    expect(await runSettle(deps, signal())).toMatchObject({ calls: 2, failed: 1 });
    expect(p()).toMatchObject({ status: 'open', settleFailures: 1, settlePending: minsAgo(2) });

    answers.push(new ClaudeError({ state: 'degraded', reason: 'overloaded' }));
    await expect(runSettle(deps, signal())).rejects.toBeInstanceOf(ClaudeError); // health hears of it
    expect(p()).toMatchObject({ settleFailures: 2, settlePending: minsAgo(2) });

    answers.push(new ClaudeOutputError(2, 'bad'));
    await runSettle(deps, signal());
    expect(p()).toMatchObject({ status: 'open', settleFailures: 3 });
    expect(p().settlePending).toBeUndefined();
    await runSettle(deps, signal());
    expect(calls).toHaveLength(3);
  });

  it('lands each check whole or not at all: a failed append leaves the reply waiting', async () => {
    await add();
    await reply('Yes.');
    const append = vi.spyOn(store, 'append').mockRejectedValueOnce(new Error('disk full'));
    await expect(runSettle(deps, signal())).rejects.toThrow('disk full');
    append.mockRestore();
    expect(p()).toMatchObject({ status: 'open', settlePending: minsAgo(2) });
    expect(p().replyCheck).toBeUndefined();
    // The next poll checks it again and closes it.
    expect(await runSettle(deps, signal())).toMatchObject({ closed: 1 });
    expect(p()).toMatchObject({ status: 'done', doneBy: 'reply' });
  });
});
