import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FollowupTodoAnswer, clampFollowups, type FollowupContext, type Item } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeAdapter, RunSpec } from '../claude/adapter';
import { ClaudeError, ClaudeOutputError } from '../claude/errors';
import { followupFor } from '../claude/fakeClaude';
import { DEFAULT_RULES, defaultSettings } from '../config/defaults';
import { initDataDir } from '../config/dataDir';
import { ItemFiles } from '../store/items';
import { Store } from '../store/store';
import { TodoTextStore } from '../store/todos';
import { followupQueue, renderFollowup, runFollowups, type FollowupDeps, type FollowupInput } from './followup';

const NOW = new Date('2026-10-12T15:10:00.000Z');
const FIXTURES = join(import.meta.dirname, '../claude/fixtures/followup');
const ITEM = 'slack:D1:1791189720.000100';

type Fixture = { about: string; now: string; todo: FollowupInput; context: Omit<FollowupContext, 'now'>; answer: FollowupTodoAnswer; kinds: string[] };

describe('follow-up fixtures (FR-16.11)', () => {
  it('each holds an answer in the shape the prompt asks for, and clamps to the kinds it shows', async () => {
    const names = (await readdir(FIXTURES)).filter((f) => f.endsWith('.json'));
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const f of names) {
      const x = JSON.parse(await readFile(join(FIXTURES, f), 'utf8')) as Fixture;
      expect(FollowupTodoAnswer.safeParse(x.answer).success, f).toBe(true);
      expect(clampFollowups(x.answer.suggestions, { ...x.context, now: new Date(x.now) }).map((s) => s.kind), f).toEqual(x.kinds);
    }
  });

  it('sends the time, then the To Dos just done', () => {
    expect(renderFollowup([], NOW).split('\n').slice(0, 3)).toEqual(['Now: 2026-10-12T15:10:00.000Z', 'Suggest follow-ups for these 0 To Dos, just done. Answer with the JSON only.', '<done>']);
  });
});

describe('runFollowups (FR-16.11)', () => {
  let dir: string;
  let store: Store;
  let items: ItemFiles;
  let texts: TodoTextStore;
  let settings: ReturnType<typeof defaultSettings>;
  let answers: (Error | 'none' | undefined)[];
  let calls: RunSpec[];
  let deps: FollowupDeps;
  let budgetHit: boolean;
  let n = 0;

  const claude = {
    structured: async (spec: RunSpec) => {
      calls.push(spec);
      const todos = JSON.parse(/<done>\n([\s\S]*)\n<\/done>/.exec(spec.prompt)![1]) as FollowupInput[];
      const next = answers.shift();
      if (next instanceof Error) throw next;
      if (next === 'none') return { value: { todos: [] }, attempts: 1, usage: [{}] };
      return { value: followupFor(todos), attempts: 1, usage: [{}] };
    },
  } as unknown as ClaudeAdapter;
  const signal = () => new AbortController().signal;
  const ids = { itemId: ITEM, actionId: 'act-1' };

  /** A To Do on the DM, done just now. */
  async function done(step: string, open = false) {
    const todoId = `todo-${(++n).toString(16).padStart(12, '0')}`;
    await texts.put({ schemaVersion: 1, todoId, itemId: ITEM, actionId: 'act-1', step, line: `- [ ] ${step}`, source: { source: 'slack', title: 'Matt M.', permalink: 'https://x/p1' } });
    await store.append({ type: 'todo.created', ...ids, data: { todoId, deadlineFrom: 'none' } });
    if (!open) await store.append({ type: 'todo.done', ...ids, data: { todoId, by: 'you' } });
    return todoId;
  }
  const t = (id: string) => store.projection.todos![id];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workos-followup-'));
    settings = defaultSettings(dir);
    await initDataDir(dir, { settings, rules: DEFAULT_RULES });
    ({ store } = await Store.open({ dataDir: dir, now: () => NOW }));
    items = new ItemFiles(join(dir, 'items'));
    texts = await TodoTextStore.open(join(dir, 'todos'));
    const messages = [
      { id: 'm1', authorId: 'U2', ts: NOW.toISOString(), text: 'Can you send me the go/no-go reason?' },
      { id: 'm2', authorId: 'U1', ts: NOW.toISOString(), text: 'Will do' },
    ];
    const it: Item = { id: ITEM, source: 'slack', kind: 'dm', title: 'Matt M.', permalink: 'https://x/p1', participants: [{ id: 'U2', name: 'Matt' }], messages, messageCount: 2, lastActivityAt: NOW.toISOString(), revision: 1, schemaVersion: 1 };
    await items.write({ item: it, text: { summary: 'Matt asks for the go/no-go reason', reason: 'r' }, schemaVersion: 1 });
    await store.append({ type: 'item.upserted', itemId: ITEM, data: { source: 'slack', kind: 'dm', title: 'Matt M.', permalink: 'https://x/p1', participants: it.participants, lastActivityAt: NOW.toISOString(), revision: 1, messageCount: 2, fromMeOnly: false } });
    answers = [];
    calls = [];
    budgetHit = false;
    deps = { store, items, texts, claude, now: () => NOW, config: () => ({ settings }), prompt: async () => ({ text: 'followup', version: 'followup v1#abc' }), budgetHit: () => budgetHit, me: () => ({ id: 'U1' }) };
  });
  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('suggests follow-ups once for each To Do just done: the kinds in the log, the words and input in todos/', async () => {
    const id = await done('Send Matt the go/no-go reason');
    expect(await runFollowups(deps, signal())).toMatchObject({ calls: 1, suggested: 2, failed: 0 });
    expect(calls[0]).toMatchObject({ purpose: 'followup', model: settings.models.triage, itemIds: [ITEM] });
    expect(calls[0].prompt).toContain('me: Will do');
    expect(calls[0].prompt).toContain('Matt: Can you send me');
    expect(t(id).followups).toEqual({ kinds: ['reply', 'mark_source_done'] });
    expect(texts.get(id)?.followups).toMatchObject({ promptVersion: 'followup v1#abc', input: { step: 'Send Matt the go/no-go reason', canReply: true, itemOpen: true, otherTodos: [] }, suggestions: [{ kind: 'reply', reply: { text: 'Done: Matt the go/no-go reason.' } }, { kind: 'mark_source_done' }] });
    expect(JSON.stringify(store.projection.todos)).not.toContain('go/no-go');
    expect(await runFollowups(deps, signal())).toMatchObject({ calls: 0 });
  });

  it('never suggests closing the item while another To Do on it is open', async () => {
    await done('Book the kick-off', true);
    const id = await done('Send Matt the reason');
    await runFollowups(deps, signal());
    expect(t(id).followups?.kinds).toEqual(['reply']);
    expect(texts.get(id)?.followups?.input).toMatchObject({ otherTodos: ['Book the kick-off'] });
  });

  it('asks only for To Dos done in the last day', async () => {
    await done('Send the reason');
    expect(followupQueue(store.projection, new Date(NOW.getTime() + 25 * 3_600_000))).toEqual([]);
  });

  it('waits while the budget is spent', async () => {
    await done('Send the reason');
    budgetHit = true;
    expect(await runFollowups(deps, signal())).toMatchObject({ calls: 0, paused: 1 });
  });

  it('gives up after two failed tries, and passes a failed call on for health', async () => {
    const id = await done('Send the reason');
    answers = [new ClaudeOutputError(2, 'bad'), new ClaudeError({ state: 'degraded', reason: 'overloaded' })];
    expect(await runFollowups(deps, signal())).toMatchObject({ failed: 1 });
    await expect(runFollowups(deps, signal())).rejects.toBeInstanceOf(ClaudeError);
    expect(t(id).followupFailures).toBe(2);
    expect(await runFollowups(deps, signal())).toMatchObject({ calls: 0 });
  });
});
