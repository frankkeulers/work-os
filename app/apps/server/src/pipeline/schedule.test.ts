import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEDULE_MAX_PER_CALL, ScheduleTodoAnswer, clampPlan, type Item } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeAdapter, RunSpec } from '../claude/adapter';
import { ClaudeError, ClaudeOutputError } from '../claude/errors';
import { scheduleFor } from '../claude/fakeClaude';
import { DEFAULT_RULES, defaultSettings } from '../config/defaults';
import { initDataDir } from '../config/dataDir';
import type { SnapEvent } from '../sources/calendar/store';
import { ItemFiles } from '../store/items';
import { Store } from '../store/store';
import { TodoTextStore } from '../store/todos';
import { calendarFor, renderSchedule, runSchedule, scheduleQueue, type ScheduleDeps, type ScheduleInput } from './schedule';

const NOW = new Date('2026-10-12T12:48:00.000Z'); // Mon 13:48 London
const inHours = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();
const FIXTURES = join(import.meta.dirname, '../claude/fixtures/schedule');
const ITEM = 'slack:C1:1791189720.000100';

type Fixture = { about: string; now: string; todo: ScheduleInput; answer: ScheduleTodoAnswer; plan: { effortMinutes: number; confidence: string; ideal?: string } };
const fixture = async (name: string): Promise<Fixture> => JSON.parse(await readFile(join(FIXTURES, name), 'utf8')) as Fixture;

describe('schedule fixtures (FR-16.6)', () => {
  it('each holds an answer in the shape the prompt asks for, and clamps to the plan it shows', async () => {
    const names = (await readdir(FIXTURES)).filter((f) => f.endsWith('.json'));
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const f of names) {
      const x = await fixture(f);
      expect(ScheduleTodoAnswer.safeParse(x.answer).success, f).toBe(true);
      expect(clampPlan(x.answer, { now: new Date(x.now), ...(x.todo.deadline && { deadline: x.todo.deadline }) }), f).toMatchObject(x.plan);
    }
  });
});

describe('the plan’s clamp (FR-16.6)', () => {
  const a = (deadline?: string): ScheduleTodoAnswer => ({ id: 't', effortMinutes: 30, confidence: 'medium', estimateWhy: 'why', ...(deadline && { deadline, deadlineWhy: 'sooner' }) });
  it.each([
    ['before the To Do’s deadline', inHours(4), inHours(28), inHours(4)],
    ['with no deadline of its own', inHours(4), undefined, inHours(4)],
    ['at its deadline: nothing gained', inHours(28), inHours(28), undefined],
    ['after its deadline: the deadline is a ceiling', inHours(30), inHours(28), undefined],
    ['already past', inHours(-1), undefined, undefined],
    ['more than 30 days off', inHours(31 * 24), undefined, undefined],
    ['in another zone, read as the same moment', '2026-10-12T19:00:00+01:00', undefined, '2026-10-12T18:00:00.000Z'],
  ])('keeps an ideal deadline %s only when it helps', (_, ideal, deadline, kept) => {
    const plan = clampPlan(a(ideal), { now: NOW, ...(deadline && { deadline }) });
    expect(plan.ideal).toBe(kept);
    expect(plan.deadlineWhy).toBe(kept ? 'sooner' : undefined);
  });

  it('cuts a long why to one line', () => {
    const plan = clampPlan({ ...a(), estimateWhy: `${'word '.repeat(60)}\n\nmore` }, { now: NOW });
    expect(plan.estimateWhy.length).toBeLessThanOrEqual(160);
    expect(plan.estimateWhy).not.toContain('\n');
  });
});

describe('the schedule input (FR-16.6)', () => {
  it('lists Frank’s meetings ahead, leaving out cancelled, declined and free ones', () => {
    const ev = (id: string, h: number, extra: Partial<SnapEvent> = {}): SnapEvent => ({ id, uri: id, subject: id, attendees: [], start: inHours(h), end: inHours(h + 1), allDay: false, cancelled: false, isOrganizer: false, ...extra });
    const cal = calendarFor([ev('later', 30), ev('soon', 2), ev('gone', -3), ev('off', 3, { cancelled: true }), ev('no', 4, { response: 'declined' }), ev('free', 5, { showAs: 'free' }), ev('far', 24 * 9)], NOW);
    expect(cal.map((e) => e.title)).toEqual(['soon', 'later']);
  });

  it('gives the time in London, the hours, the calendar and the To Dos', () => {
    const text = renderSchedule([], { now: NOW, workHours: 'Mon–Fri 08:00–18:30' });
    expect(text.split('\n').slice(0, 5)).toEqual(['Now: 2026-10-12T12:48:00.000Z (Mon 13:48 in London)', 'Working hours: Mon–Fri 08:00–18:30', 'Plan these 0 To Dos. Answer with the JSON only.', '<calendar>', 'Not known.']);
  });
});

describe('runSchedule (FR-16.6)', () => {
  let dir: string;
  let store: Store;
  let items: ItemFiles;
  let texts: TodoTextStore;
  let settings: ReturnType<typeof defaultSettings>;
  let answers: (Partial<ScheduleTodoAnswer> | Error | 'none')[];
  let calls: RunSpec[];
  let deps: ScheduleDeps;
  let budgetHit: boolean;

  const claude = {
    structured: async (spec: RunSpec) => {
      calls.push(spec);
      const todos = JSON.parse(/<todos>\n([\s\S]*)\n<\/todos>/.exec(spec.prompt)![1]) as ScheduleInput[];
      const next = answers.shift();
      if (next instanceof Error) throw next;
      if (next === 'none') return { value: { todos: [] }, attempts: 1, usage: [{}] };
      const fake = scheduleFor(todos, NOW);
      return { value: next ? { todos: fake.todos.map((t) => ({ ...t, ...next })) } : fake, attempts: 1, usage: [{}] };
    },
  } as unknown as ClaudeAdapter;

  const signal = () => new AbortController().signal;
  let n = 0;

  /** A To Do on the thread, as a written to-do makes it. */
  async function todo(step: string, deadline?: string) {
    const todoId = `todo-${(++n).toString(16).padStart(12, '0')}`;
    await texts.put({ schemaVersion: 1, todoId, itemId: ITEM, actionId: 'act-1', step, line: `- [ ] ${step}`, source: { source: 'slack', title: '#mvi-launch', permalink: 'https://x/p1' } });
    await store.append({ type: 'todo.created', itemId: ITEM, actionId: 'act-1', data: { todoId, ...(deadline && { deadline }), deadlineFrom: deadline ? 'triage' : 'none' } });
    return todoId;
  }
  const t = (id: string) => store.projection.todos![id];

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workos-schedule-'));
    settings = defaultSettings(dir);
    await initDataDir(dir, { settings, rules: DEFAULT_RULES });
    ({ store } = await Store.open({ dataDir: dir, now: () => NOW }));
    items = new ItemFiles(join(dir, 'items'));
    texts = await TodoTextStore.open(join(dir, 'todos'));
    const messages = [{ id: 'm1', authorId: 'U2', ts: NOW.toISOString(), text: 'Can you send the go/no-go reason before Thursday?' }];
    const it: Item = { id: ITEM, source: 'slack', kind: 'thread', title: '#mvi-launch', permalink: 'https://x/p1', participants: [{ id: 'U2', name: 'Matt' }], messages, messageCount: 1, lastActivityAt: NOW.toISOString(), revision: 1, schemaVersion: 1 };
    await items.write({ item: it, text: { summary: 'Matt asks for the go/no-go reason', reason: 'r' }, schemaVersion: 1 });
    answers = [];
    calls = [];
    budgetHit = false;
    deps = { store, items, texts, claude, now: () => NOW, config: () => ({ settings }), prompt: async () => ({ text: 'schedule', version: 'schedule v1#abc' }), budgetHit: () => budgetHit };
  });
  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('plans each new To Do once: the estimate in the log, its whys and input in todos/', async () => {
    const a = await todo('Send Matt the go/no-go reason today', inHours(48));
    const b = await todo('Review the pricing deck');
    expect(await runSchedule(deps, signal())).toMatchObject({ calls: 1, planned: 2, failed: 0 });
    expect(calls[0]).toMatchObject({ purpose: 'schedule', model: settings.models.triage, itemIds: [ITEM] });
    expect(calls[0].prompt).toContain('Matt asks for the go/no-go reason');
    expect(t(a)).toMatchObject({ planned: true, effortMinutes: 15, effortBy: 'model', confidence: 'high', ideal: '2026-10-12T16:00:00.000Z' });
    expect(t(b)).toMatchObject({ planned: true, effortMinutes: 60, confidence: 'medium' });
    expect(t(b).ideal).toBeUndefined();
    expect(texts.get(a)?.plan).toMatchObject({ promptVersion: 'schedule v1#abc', estimateWhy: 'A 15-minute step, by the fake.', deadlineWhy: 'The step says today.', input: { step: 'Send Matt the go/no-go reason today', deadline: inHours(48), excerpt: 'Can you send the go/no-go reason before Thursday?' } });
    expect(await runSchedule(deps, signal())).toMatchObject({ calls: 0 });
    expect(scheduleQueue(store.projection)).toEqual([]);
  });

  it('sends at most 20 To Dos a call', async () => {
    for (let i = 0; i < SCHEDULE_MAX_PER_CALL + 3; i++) await todo(`Send note ${i}`);
    expect(await runSchedule(deps, signal())).toMatchObject({ calls: 2, planned: SCHEDULE_MAX_PER_CALL + 3 });
  });

  it('keeps Frank’s own estimate and deadline over the model’s', async () => {
    const id = await todo('Send the reason today');
    await store.append({ type: 'todo.edited', itemId: ITEM, actionId: 'act-1', data: { todoId: id, effortMinutes: 45, deadline: inHours(2) } });
    await runSchedule(deps, signal());
    expect(t(id)).toMatchObject({ planned: true, effortMinutes: 45, effortBy: 'you', deadline: inHours(2), deadlineFrom: 'you' });
    expect(t(id).ideal).toBeUndefined();
  });

  it('waits while the budget is spent', async () => {
    await todo('Send the reason');
    budgetHit = true;
    expect(await runSchedule(deps, signal())).toMatchObject({ calls: 0, paused: 1 });
  });

  it('gives up on a To Do after two failed tries; a To Do left out of the answer counts as one', async () => {
    const id = await todo('Send the reason');
    answers = [new ClaudeOutputError(2, 'bad'), 'none'];
    expect(await runSchedule(deps, signal())).toMatchObject({ failed: 1 });
    expect(t(id).planFailures).toBe(1);
    expect(await runSchedule(deps, signal())).toMatchObject({ failed: 1 });
    expect(t(id).planFailures).toBe(2);
    expect(await runSchedule(deps, signal())).toMatchObject({ calls: 0 });
    expect(t(id).planned).toBeUndefined();
  });

  it('counts a failed call against each To Do and passes the error on for health', async () => {
    const id = await todo('Send the reason');
    answers = [new ClaudeError({ state: 'degraded', reason: 'overloaded' })];
    await expect(runSchedule(deps, signal())).rejects.toBeInstanceOf(ClaudeError);
    expect(t(id).planFailures).toBe(1);
  });

  it('plans only open To Dos', async () => {
    const id = await todo('Send the reason');
    await store.append({ type: 'todo.done', itemId: ITEM, actionId: 'act-1', data: { todoId: id, by: 'tasks_note' } });
    expect(await runSchedule(deps, signal())).toMatchObject({ calls: 0 });
  });
});
