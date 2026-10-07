import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item, Message } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeAdapter, RunSpec } from '../claude/adapter';
import { ClaudeOutputError } from '../claude/errors';
import { topicsFor } from '../claude/fakeClaude';
import { DEFAULT_RULES, defaultSettings } from '../config/defaults';
import { initDataDir } from '../config/dataDir';
import { ItemFiles } from '../store/items';
import { Store } from '../store/store';
import { askId, topicItem } from '@work-os/shared';
import { resolveAssignments, routeTopics, type TopicsAnswer, type TopicsDeps } from './topics';
import { runTriage, type TriageAnswer } from './triage';
import type { TriageThread } from './truncate';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const ts = (m: number) => (Math.floor(Date.parse(minsAgo(m)) / 1000) + '.000100');
const pid = (m: number, channel = 'G1') => `slack:${channel}:${ts(m)}`;

const msg = (id: string, mins: number, text: string, authorId = 'U2'): Message => ({ id, authorId, ts: minsAgo(mins), text });
const piece = (mins: number, texts: string[], over: Partial<Item> = {}): Item => {
  const messages = texts.map((t, i) => msg(`${ts(mins)}-${i}`, mins - i, t));
  return {
    id: pid(mins),
    source: 'slack',
    kind: 'dm',
    title: 'Anuj, Shivam, Sourabh',
    permalink: 'https://polestar.slack.com/archives/G1/p1',
    participants: [{ id: 'U2', name: 'Anuj Singhal' }],
    messages,
    messageCount: messages.length,
    lastActivityAt: messages.at(-1)!.ts,
    revision: 1,
    schemaVersion: 1,
    ...over,
  };
};

describe('resolveAssignments', () => {
  const answer = (pairs: [string, string][]): TopicsAnswer => ({ assignments: pairs.map(([id, topic]) => ({ id, topic })) });
  const [a, b, c] = [pid(90), pid(60), pid(30)];
  const open = pid(300);

  it('joins an open topic, and starts a new one for "new" or an unknown id', () => {
    const r = resolveAssignments([a, b, c], [open], answer([[a, open], [b, 'new'], [c, 'slack:G1:nope']]));
    expect(Object.fromEntries(r)).toEqual({ [a]: open, [b]: undefined, [c]: undefined });
  });

  it('anchors a new topic on its earliest piece, whichever way the pieces point', () => {
    const r = resolveAssignments([a, b, c], [], answer([[a, c], [b, 'new'], [c, b]]));
    expect(Object.fromEntries(r)).toEqual({ [a]: undefined, [b]: a, [c]: a });
  });

  it('takes a whole group into the open topic one of its pieces names', () => {
    const r = resolveAssignments([a, b, c], [open], answer([[a, b], [b, open], [c, 'new']]));
    expect(Object.fromEntries(r)).toEqual({ [a]: open, [b]: open, [c]: undefined });
  });

  it('never puts a piece back in a topic Frank split it from', () => {
    const r = resolveAssignments([a, b], [open], answer([[a, open], [b, a]]), (id) => (id === b ? [open] : []));
    expect(Object.fromEntries(r)).toEqual({ [a]: open, [b]: undefined });
  });
});

describe('topicItem', () => {
  it('merges the pieces’ messages in time order under the anchor, and knows which were thread replies', () => {
    const anchor = piece(90, ['Pre-publish branch is live', 'needs end-to-end validation']);
    const thread = { ...piece(60, ['PR 63 adds GOVERNANCE-RULES.md', 'flagged the security scheme']), id: pid(60), thread: true };
    const window = piece(80, ['go on main branch protection?']);
    const { item, inThread } = topicItem(anchor, [thread, window]);
    expect(item.id).toBe(anchor.id);
    expect(item.messages.map((m) => m.text)).toEqual(['Pre-publish branch is live', 'needs end-to-end validation', 'go on main branch protection?', 'PR 63 adds GOVERNANCE-RULES.md', 'flagged the security scheme']);
    expect(item.messageCount).toBe(5);
    expect(item.lastActivityAt).toBe(thread.lastActivityAt);
    expect([...inThread]).toEqual(thread.messages.map((m) => m.id));
  });
});

describe('routeTopics', () => {
  let dir: string;
  let store: Store;
  let items: ItemFiles;
  let answers: (TopicsAnswer | Error | 'fake')[];
  let calls: RunSpec[];
  let deps: TopicsDeps;

  const claude = {
    structured: async (spec: RunSpec) => {
      calls.push(spec);
      const next = answers.shift() ?? 'fake';
      if (next instanceof Error) throw next;
      const value = next === 'fake' ? topicsFor(JSON.parse(/<conversations>\n([\s\S]*)\n<\/conversations>/.exec(spec.prompt)![1])) : next;
      return { value, attempts: 1, usage: [{}] };
    },
  } as unknown as ClaudeAdapter;

  async function add(it: Item, triaged?: { summary: string }) {
    await items.write({ item: it, ...(triaged && { text: { summary: triaged.summary, reason: 'r' } }), schemaVersion: 1 });
    await store.append({
      type: 'item.upserted',
      itemId: it.id,
      data: { source: it.source, kind: it.kind, title: it.title, permalink: it.permalink, participants: it.participants, lastActivityAt: it.lastActivityAt, revision: it.revision, messageCount: it.messageCount, fromMeOnly: false },
    });
    if (triaged) {
      await store.append({ type: 'topic.routed', itemId: it.id, data: { by: 'model' } });
      await store.append({
        type: 'triage.decided',
        itemId: it.id,
        data: { decision: { itemId: it.id, itemRevision: 1, topicVersion: 0, attention: 'today', confluence: { suggested: false }, vault: { suggested: false }, containsPeopleObservations: false, decidedBy: 'model', decidedAt: minsAgo(1) } },
      });
    }
  }
  const p = () => store.projection.items;
  /** Routed, and a topic of its own. */
  const alone = (id: string) => {
    expect(p()[id].routed).toBe(true);
    expect(p()[id].topicOf).toBeUndefined();
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workos-topics-'));
    const settings = defaultSettings(dir);
    await initDataDir(dir, { settings, rules: DEFAULT_RULES });
    ({ store } = await Store.open({ dataDir: dir, now: () => NOW }));
    items = new ItemFiles(join(dir, 'items'));
    answers = [];
    calls = [];
    deps = {
      store,
      items,
      claude,
      now: () => NOW,
      config: () => ({ settings }),
      me: () => ({ id: 'UFRANK' }),
      topicsPrompt: async () => ({ text: 'topics', version: 'v1' }),
      budgetHit: () => false,
    };
  });
  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('places a lone new piece without a call', async () => {
    await add(piece(60, ['Hello']));
    expect(await routeTopics(deps, new AbortController().signal)).toEqual({ calls: 0, routed: 1, joined: 0 });
    expect(calls).toHaveLength(0);
    alone(pid(60));
  });

  it('joins new pieces to the open topic they continue, in one call per run', async () => {
    await add(piece(300, ['PR 63 adds GOVERNANCE-RULES.md for contract checks']), { summary: 'PR 63 governance rules' });
    await add(piece(120, ['Security scheme in PR 63 lands on the wrong module']));
    await add(piece(60, ['Shivani asks for a review of the timestamp_end default']));
    await add(piece(40, ['Approved; timestamp_end clamps to now']), undefined);
    await add({ ...piece(200, ['PR 63 looks fine'], {}), id: pid(200, 'C9'), title: '#api' });
    const run = await routeTopics(deps, new AbortController().signal);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: 'routing', model: 'haiku-4.5', system: 'topics' });
    expect(run).toMatchObject({ calls: 1, joined: 1 });
    expect(p()[pid(120)].topicOf).toBe(pid(300));
    expect(p()[pid(300)]).toMatchObject({ parts: [pid(120)], triageState: 'pending', newReplies: true });
    alone(pid(60));
    alone(pid(200, 'C9')); // another conversation
  });

  it('waits for a piece to go quiet, and leaves routed pieces alone', async () => {
    await add(piece(300, ['PR 63 rules']), { summary: 'PR 63' });
    await add(piece(5, ['PR 63 again']));
    await routeTopics(deps, new AbortController().signal);
    expect(calls).toHaveLength(0);
    expect(p()[pid(5)].routed).toBe(false);
  });

  it('leaves every piece on its own after two bad answers', async () => {
    await add(piece(300, ['PR 63 rules']), { summary: 'PR 63' });
    await add(piece(60, ['PR 63 again']));
    answers.push(new ClaudeOutputError(2, 'bad'));
    expect(await routeTopics(deps, new AbortController().signal)).toEqual({ calls: 2, routed: 1, joined: 0 });
    alone(pid(60));
  });

  it('makes no call once the budget is spent', async () => {
    await add(piece(300, ['PR 63 rules']), { summary: 'PR 63' });
    await add(piece(60, ['PR 63 again']));
    deps.budgetHit = () => true;
    expect(await routeTopics(deps, new AbortController().signal)).toMatchObject({ calls: 0, paused: true });
    expect(calls).toHaveLength(0);
    expect(p()[pid(60)].routed).toBe(false);
  });

  it('regroups a conversation’s open topics into the earliest', async () => {
    await add(piece(300, ['PR 63 rules']), { summary: 'PR 63' });
    await add(piece(200, ['Grooming items']), { summary: 'Grooming' });
    await add(piece(100, ['PR 63 security scheme']), { summary: 'PR 63 scheme' });
    const run = await routeTopics(deps, new AbortController().signal, { regroup: 'G1' });
    expect(run).toEqual({ calls: 1, routed: 1, joined: 1 });
    expect(calls[0].prompt).toMatch(/Group these open topics/);
    expect(p()[pid(300)]).toMatchObject({ parts: [pid(100)], triageState: 'pending', newReplies: false });
    expect(p()[pid(200)].topicOf).toBeUndefined();
  });
});

describe('triage per topic', () => {
  let dir: string;
  let store: Store;
  let items: ItemFiles;
  let seen: TriageThread[][];
  let reply: (threads: TriageThread[]) => TriageAnswer;

  const claude = {
    structured: async (spec: RunSpec) => {
      if (spec.purpose === 'routing') return { value: topicsFor(JSON.parse(/<conversations>\n([\s\S]*)\n<\/conversations>/.exec(spec.prompt)![1])), attempts: 1, usage: [{}] };
      const threads = JSON.parse(/<threads>\n([\s\S]*)\n<\/threads>/.exec(spec.prompt)![1]) as TriageThread[];
      seen.push(threads);
      return { value: reply(threads), attempts: 1, usage: [{}] };
    },
  } as unknown as ClaudeAdapter;

  const decision = (id: string, asks: { need: 'approve' | 'review' | 'reply'; step: string }[]) => ({
    id,
    attention: 'today' as const,
    confluence: { suggested: false },
    vault: { suggested: false },
    containsPeopleObservations: false,
    summary: 'Pre-publish branch workflow',
    reason: 'Asks wait on Frank',
    next: { need: asks[0].need, step: asks[0].step, why: 'Team waiting', asks },
  });

  async function add(it: Item) {
    // As a poll does: new content, the decision's text kept.
    await items.update(it.source, it.id, (stored) => ({ item: it, ...(stored?.text && { text: stored.text }), schemaVersion: 1 as const }));
    await store.append({
      type: 'item.upserted',
      itemId: it.id,
      data: { source: it.source, kind: it.kind, title: it.title, permalink: it.permalink, participants: it.participants, lastActivityAt: it.lastActivityAt, revision: it.revision, messageCount: it.messageCount, fromMeOnly: false },
    });
  }
  const triage = () => {
    const settings = defaultSettings(dir);
    return runTriage(
      {
        store,
        items,
        claude,
        now: () => NOW,
        config: () => ({ settings, rules: [] }),
        me: () => ({ id: 'UFRANK' }),
        prompt: async () => ({ text: 'triage', version: 'v3' }),
        topicsPrompt: async () => ({ text: 'topics', version: 'v1' }),
        budgetHit: () => false,
      },
      new AbortController().signal,
    );
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workos-topic-triage-'));
    await initDataDir(dir, { settings: defaultSettings(dir), rules: DEFAULT_RULES });
    ({ store } = await Store.open({ dataDir: dir, now: () => NOW }));
    items = new ItemFiles(join(dir, 'items'));
    seen = [];
    reply = (threads) => ({ decisions: threads.map((t) => decision(t.id, [{ need: 'approve', step: 'Approve main branch protection' }])) });
  });
  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('routes, then triages a topic once over every piece, keeping each piece’s first and latest messages', async () => {
    const long = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} message ${i}`);
    await add(piece(300, ['PR 63 adds GOVERNANCE-RULES.md', ...long(6, 'early')]));
    await add({ ...piece(200, ['PR 63: can you approve the security scheme fix?', ...long(6, 'middle')]), thread: true });
    await add(piece(100, ['PR 63 is merged', ...long(6, 'late')]));
    const run = await triage();
    expect(run).toMatchObject({ triaged: 1, failed: 0 });
    expect(seen).toHaveLength(1);
    const [t] = seen[0];
    expect(t.id).toBe(pid(300));
    const texts = t.messages.map((m) => m.text);
    expect(texts).toContain('PR 63: can you approve the security scheme fix?'); // a middle piece's first message
    expect(texts).toContain('middle message 5'); // and its latest
    expect(texts).not.toContain('middle message 1');
    expect(t.messages.find((m) => m.text.startsWith('PR 63: can'))?.thread).toBe(true);
    expect(t.messages.find((m) => m.text === 'PR 63 is merged')?.thread).toBeUndefined();

    const anchor = store.projection.items[pid(300)];
    expect(anchor).toMatchObject({ triageState: 'triaged', parts: [pid(200), pid(100)], decision: { topicVersion: 2 } });
    expect((await items.read('slack', pid(300)))?.text?.next?.asks).toEqual([{ need: 'approve', step: 'Approve main branch protection' }]);
  });

  it('passes ticked asks as done, and keeps them off if the model lists them again', async () => {
    await add(piece(300, ['PR 63 rules']));
    await triage();
    await store.append({ type: 'topic.askDone', itemId: pid(300), data: { askId: askId('Approve main branch protection') } });
    await add({ ...piece(300, ['PR 63 rules', 'and one more thing']), revision: 2 });
    reply = (threads) => ({ decisions: threads.map((t) => decision(t.id, [{ need: 'approve', step: 'Approve main branch protection' }, { need: 'review', step: 'Review the timestamp_end change' }])) });
    await triage();
    expect(seen[1][0].done).toEqual(['Approve main branch protection']);
    expect((await items.read('slack', pid(300)))?.text?.next?.asks).toEqual([{ need: 'review', step: 'Review the timestamp_end change' }]);
  });
});
