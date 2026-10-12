import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RULES, defaultSettings } from '../config/defaults';
import { initDataDir } from '../config/dataDir';
import type { CalendarSnapshot, SnapEvent } from '../sources/calendar/store';
import { Store } from '../store/store';
import { TodoPlanner } from './planner';

const NOW = new Date('2026-10-12T08:02:00.000Z'); // Mon 09:02 London
const ITEM = 'slack:C1:1791189720.000100';
const ids = { itemId: ITEM, actionId: 'act-1' };

describe('the To Do planner (FR-16.8, FR-16.9)', () => {
  let dir: string;
  let store: Store;
  let settings: ReturnType<typeof defaultSettings>;
  let cal: { on: boolean; snapshot?: CalendarSnapshot };
  let planner: TodoPlanner;

  const meeting = (id: string, start: string, end: string): SnapEvent => ({ id, uri: id, subject: id, attendees: [], start, end, allDay: false, cancelled: false, isOrganizer: false });
  const snapshot = (events: SnapEvent[]): CalendarSnapshot => ({ schemaVersion: 1, polledAt: NOW.toISOString(), from: '2026-10-12T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z', events, invites: [] });
  const slot = (id: string) => store.projection.todos![id].slot;
  const todo = async (todoId: string) => store.append({ type: 'todo.created', ...ids, data: { todoId, deadlineFrom: 'none' } });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workos-planner-'));
    settings = defaultSettings(dir);
    await initDataDir(dir, { settings, rules: DEFAULT_RULES });
    ({ store } = await Store.open({ dataDir: dir, now: () => NOW }));
    cal = { on: true, snapshot: snapshot([]) };
    planner = new TodoPlanner({ store, now: () => NOW, config: () => ({ settings }), calendar: () => cal });
  });
  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('gives each open To Do a slot, and is quiet while nothing changes', async () => {
    await todo('todo-a');
    await todo('todo-b');
    expect(await planner.plan()).toBe(2);
    expect(slot('todo-a')).toEqual({ start: '2026-10-12T08:15:00.000Z', end: '2026-10-12T08:45:00.000Z', by: 'plan' });
    expect(slot('todo-b')).toEqual({ start: '2026-10-12T08:45:00.000Z', end: '2026-10-12T09:15:00.000Z', by: 'plan' });
    expect(await planner.plan()).toBe(0);
  });

  it('moves only the slot a new meeting lands on', async () => {
    await todo('todo-a');
    await todo('todo-b');
    await planner.plan();
    cal = { on: true, snapshot: snapshot([meeting('m', '2026-10-12T09:00:00.000Z', '2026-10-12T09:10:00.000Z')]) };
    expect(await planner.plan()).toBe(1);
    expect(slot('todo-a')?.start).toBe('2026-10-12T08:15:00.000Z');
    expect(slot('todo-b')).toEqual({ start: '2026-10-12T09:30:00.000Z', end: '2026-10-12T10:00:00.000Z', by: 'plan' });
  });

  it('never moves Frank’s own slot, and plans the rest around it', async () => {
    await todo('todo-a');
    await todo('todo-b');
    await store.append({ type: 'todo.scheduled', ...ids, data: { todoId: 'todo-a', start: '2026-10-12T08:15:00.000Z', end: '2026-10-12T08:45:00.000Z', by: 'you' } });
    cal = { on: true, snapshot: snapshot([meeting('m', '2026-10-12T08:00:00.000Z', '2026-10-12T08:30:00.000Z')]) };
    expect(await planner.plan()).toBe(1);
    expect(slot('todo-a')?.by).toBe('you');
    expect(planner.slots()?.['todo-a']).toMatchObject({ kind: 'slot', by: 'you', clash: true });
    expect(slot('todo-b')).toEqual({ start: '2026-10-12T08:45:00.000Z', end: '2026-10-12T09:15:00.000Z', by: 'plan' });
  });

  it('takes the plan’s slots back once the calendar is off, and waits for the first poll', async () => {
    await todo('todo-a');
    await planner.plan();
    cal = { on: true };
    expect(planner.slots()).toBeUndefined();
    expect(await planner.plan()).toBe(0);
    expect(slot('todo-a')).toBeDefined();
    cal = { on: false, snapshot: snapshot([]) };
    expect(await planner.plan()).toBe(1);
    expect(slot('todo-a')).toBeUndefined();
    expect(planner.slots()?.['todo-a']).toEqual({ kind: 'none', reason: 'no_calendar' });
  });

  it('leaves done To Dos alone', async () => {
    await todo('todo-a');
    await store.append({ type: 'todo.done', ...ids, data: { todoId: 'todo-a', by: 'you' } });
    expect(await planner.plan()).toBe(0);
  });

  it('runs one pass at a time, with one more after for calls made meanwhile', async () => {
    await todo('todo-a');
    const first = planner.plan();
    const second = planner.plan();
    expect(await first).toBe(1);
    expect(await second).toBe(1); // the same pass
    await todo('todo-b');
    await planner.plan();
    expect(slot('todo-b')).toBeDefined();
  });
});
