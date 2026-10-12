import { describe, expect, it } from 'vitest';
import { askId } from './projection/topics';
import { lineIdFor, newTodos, parseTaskLine, taskKey, todoContent, todoDeadline, todoDues, todoIdFor, todoLine, todoLines, todoSteps, todoWriteLines, withLineId, withTick } from './todo';
import type { TodoState } from './projection/state';
import { slotOf, todoGroups, todoSlots, type TodoSummary } from './todos';

const SRC = { title: '#mvi-launch', permalink: 'https://polestar.slack.com/archives/C06/p1791' };

describe('to-dos (UX-5)', () => {
  it('writes an Obsidian Tasks line: the step, the deadline in London, and a link back', () => {
    // 23:30 UTC on 8 Oct is already 9 Oct in London (BST).
    expect(todoLine({ step: 'Send the notes', dueAt: '2026-10-08T23:30:00.000Z' }, SRC)).toBe('- [ ] Send the notes 📅 2026-10-09 [#mvi-launch](https://polestar.slack.com/archives/C06/p1791)');
    expect(todoLine({ step: '  - [ ] Already a task\nwith a break ' }, { title: 'Dana [ops]', permalink: 'https://x.test/a b' })).toBe('- [ ] Already a task with a break [Dana \\[ops\\]](https://x.test/a%20b)');
  });

  it('starts from the open asks, then a meeting’s action items, then the next step, then the summary', () => {
    const asks = [
      { need: 'approve' as const, step: 'Approve the wording', dueAt: '2026-10-06T11:00:00.000Z' },
      { need: 'review' as const, step: 'Review the deck' },
    ];
    expect(todoSteps({ next: { need: 'approve', step: asks[0].step, why: 'w', asks } }, [askId('Review the deck')])).toEqual([{ step: 'Approve the wording', dueAt: '2026-10-06T11:00:00.000Z' }]);
    expect(todoSteps({ next: { need: 'actions', step: 'Confirm', why: 'w', actionItems: ['Send the sample · by Friday', 'Book the kick-off'] } })).toEqual([{ step: 'Send the sample · by Friday' }, { step: 'Book the kick-off' }]);
    expect(todoSteps({ next: { need: 'reply', step: 'Answer Matt', why: 'w', dueAt: '2026-10-06T16:30:00.000Z' } })).toEqual([{ step: 'Answer Matt', dueAt: '2026-10-06T16:30:00.000Z' }]);
    expect(todoSteps({ summary: 'Ops is fixing access' })).toEqual([{ step: 'Follow up: Ops is fixing access' }]);
    expect(todoSteps(undefined)).toEqual([]);
    expect(todoContent([{ step: 'a' }, { step: 'b' }], SRC).split('\n')).toHaveLength(2);
  });

  it('reads Frank’s edit back as task lines: blank lines dropped, plain lines made tasks, ticked ones kept', () => {
    expect(todoLines('- [ ] One\n\n  Two  \n- [x] Done already\n* Three')).toEqual(['- [ ] One', '- [ ] Two', '- [x] Done already', '- [ ] Three']);
  });
});

describe('To Dos’ lines (E15, FR-16.1)', () => {
  const dated = todoLine({ step: 'Send the notes', dueAt: '2026-10-09T10:00:00.000Z' }, SRC);
  const undated = todoLine({ step: 'Book the kick-off' }, SRC);

  it('gives each line an id after its date, or before the link back, and keeps an id a line has', () => {
    const id = lineIdFor('act-1', dated);
    expect(id).toMatch(/^[0-9a-f]{6}$/);
    expect(withLineId(dated, 'act-1')).toBe(`- [ ] Send the notes 📅 2026-10-09 🆔 ${id} [#mvi-launch](https://polestar.slack.com/archives/C06/p1791)`);
    expect(withLineId(undated, 'act-1')).toBe(`- [ ] Book the kick-off 🆔 ${lineIdFor('act-1', undated)} [#mvi-launch](https://polestar.slack.com/archives/C06/p1791)`);
    expect(withLineId('- [ ] Plain', 'act-1')).toBe(`- [ ] Plain 🆔 ${lineIdFor('act-1', '- [ ] Plain')}`);
    const once = withLineId(dated, 'act-1');
    expect(withLineId(once, 'act-2')).toBe(once);
    // The same task gets the same id each time; another action's gets another.
    expect(lineIdFor('act-1', dated)).toBe(lineIdFor('act-1', '- [x] Send the notes 📅 2026-10-09 [#mvi-launch](https://polestar.slack.com/archives/C06/p1791) ✅ 2026-10-10'));
    expect(lineIdFor('act-2', dated)).not.toBe(id);
  });

  it('reads a line back: ticked or not, its done date, deadline, id and words', () => {
    const line = `- [x] Send the notes 📅 2026-10-09 🆔 a1b2c3 [#mvi-launch](https://x.test/p) ✅ 2026-10-08`;
    expect(parseTaskLine(line)).toEqual({ ticked: true, doneOn: '2026-10-08', due: '2026-10-09', lineId: 'a1b2c3', step: 'Send the notes', key: 'Send the notes 📅 2026-10-09 [#mvi-launch](https://x.test/p)' });
    expect(parseTaskLine('- [ ] Just words')).toEqual({ ticked: false, step: 'Just words', key: 'Just words' });
    expect(parseTaskLine('# Tasks')).toBeUndefined();
    expect(parseTaskLine('Some prose')).toBeUndefined();
    // Ticked or not, done date or not, id or not: the same task.
    expect(taskKey(line)).toBe(taskKey('- [ ] Send the notes 📅 2026-10-09 [#mvi-launch](https://x.test/p)'));
  });

  it('ticks a line as the Tasks plugin does, and unticks it, leaving the rest of it alone (FR-16.4)', () => {
    const open = `- [ ] Send the notes 📅 2026-10-09 🆔 a1b2c3 [#mvi-launch](https://x.test/p)`;
    const ticked = withTick(open, '2026-10-08');
    expect(ticked).toBe(`- [x] Send the notes 📅 2026-10-09 🆔 a1b2c3 [#mvi-launch](https://x.test/p) ✅ 2026-10-08`);
    expect(parseTaskLine(ticked)).toMatchObject({ ticked: true, doneOn: '2026-10-08', lineId: 'a1b2c3', step: 'Send the notes' });
    expect(withTick(ticked, '2026-10-10')).toBe(ticked); // already ticked: its date stays
    expect(withTick(ticked)).toBe(open);
    expect(withTick('  * [ ] Indented ', '2026-10-08')).toBe('  * [x] Indented ✅ 2026-10-08');
    expect(withTick('# Tasks', '2026-10-08')).toBe('# Tasks');
  });

  it('keeps triage’s deadline while the line keeps its date; else 17:30 on the line’s date; else none', () => {
    const steps = [{ step: 'Send the notes', dueAt: '2026-10-09T10:00:00.000Z' }];
    const dues = todoDues(steps, SRC);
    expect(todoDeadline(withLineId(dated, 'act-1'), dues)).toEqual({ deadline: '2026-10-09T10:00:00.000Z', deadlineFrom: 'triage' });
    // Frank moved the date while reviewing: the new date, at the end of the day (BST in October).
    expect(todoDeadline(dated.replace('2026-10-09', '2026-10-12'), dues)).toEqual({ deadline: '2026-10-12T16:30:00.000Z', deadlineFrom: 'line' });
    expect(todoDeadline(undated, dues)).toEqual({ deadlineFrom: 'none' });
    expect(todoDues([{ step: 'x' }], SRC)).toBeUndefined();
  });

  it('makes one To Do per line, the same ones every time, leaving out those it knows', () => {
    const content = `${dated}\n${undated}\n\n`;
    const first = newTodos('act-1', { content }, () => false);
    expect(first.map((t) => t.step)).toEqual(['Send the notes', 'Book the kick-off']);
    expect(first[0]).toMatchObject({ todoId: todoIdFor('act-1', first[0].lineId!), deadlineFrom: 'line', line: todoWriteLines(content, 'act-1')[0] });
    expect(newTodos('act-1', { content }, () => false)).toEqual(first);
    expect(newTodos('act-1', { content }, (id) => id === first[0].todoId).map((t) => t.step)).toEqual(['Book the kick-off']);
    // Backfilled: as written, with no id.
    const back = newTodos('act-1', { content }, () => false, true);
    expect(back[0].lineId).toBeUndefined();
    expect(back[0].line).toBe(dated);
  });
});

describe('To Do groups (E15, FR-16.2)', () => {
  const now = new Date('2026-10-05T12:48:00.000Z'); // Mon 13:48 London
  const t = (id: string, over: Partial<TodoSummary>): TodoSummary => ({ id, itemId: 'i', step: id, source: 'slack', sourceTitle: '#x', status: 'open', deadlineFrom: 'none', createdAt: '2026-10-01T09:00:00.000Z', ...over });

  it('sorts To Dos into overdue, today, upcoming and done today, soonest first', () => {
    const g = todoGroups(
      [
        t('later', { deadline: '2026-10-08T11:00:00.000Z', deadlineFrom: 'triage' }),
        t('none', {}),
        t('late', { deadline: '2026-10-02T16:30:00.000Z', deadlineFrom: 'line' }),
        t('eod', { deadline: '2026-10-05T16:30:00.000Z', deadlineFrom: 'line' }),
        t('four', { deadline: '2026-10-05T15:00:00.000Z', deadlineFrom: 'triage' }),
        t('doneToday', { status: 'done', doneAt: '2026-10-05T09:00:00.000Z' }),
        t('doneBefore', { status: 'done', doneAt: '2026-10-04T09:00:00.000Z' }),
      ],
      now,
    );
    expect(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map((x) => x.id)]))).toEqual({ overdue: ['late'], today: ['four', 'eod'], upcoming: ['later', 'none'], done: ['doneToday'] });
  });

  it('goes by the ideal date when there is one: due today ideally is today, and past it is not overdue (FR-16.6)', () => {
    const g = todoGroups(
      [
        t('idealToday', { deadline: '2026-10-08T11:00:00.000Z', deadlineFrom: 'triage', ideal: '2026-10-05T15:30:00.000Z' }),
        t('idealPast', { ideal: '2026-10-05T08:00:00.000Z' }),
        t('idealLater', { ideal: '2026-10-06T11:00:00.000Z' }),
        t('deadlineLater', { deadline: '2026-10-07T11:00:00.000Z', deadlineFrom: 'line' }),
      ],
      now,
    );
    expect(g.overdue).toEqual([]);
    expect(g.today.map((x) => x.id)).toEqual(['idealPast', 'idealToday']);
    expect(g.upcoming.map((x) => x.id)).toEqual(['idealLater', 'deadlineLater']);
  });

  it('puts a To Do with a slot today in today, in the order of the slots, then those without one (FR-16.8)', () => {
    const slot = (start: string) => ({ start, end: start.replace(':00.000Z', ':30.000Z'), by: 'plan' as const });
    const g = todoGroups(
      [
        t('dueToday', { deadline: '2026-10-05T16:30:00.000Z', deadlineFrom: 'line' }),
        t('four', { slot: slot('2026-10-05T15:00:00.000Z') }),
        t('two', { deadline: '2026-10-09T11:00:00.000Z', deadlineFrom: 'triage', slot: slot('2026-10-05T13:00:00.000Z') }),
        t('tomorrow', { slot: slot('2026-10-06T09:00:00.000Z') }),
      ],
      now,
    );
    expect(g.today.map((x) => x.id)).toEqual(['two', 'four', 'dueToday']);
    expect(g.upcoming.map((x) => x.id)).toEqual(['tomorrow']);
  });
});

describe('To Do slots (FR-16.8)', () => {
  const state = (id: string, over: Partial<TodoState> = {}): TodoState => ({ id, itemId: 'i', actionId: 'a', createdAt: '2026-10-12T07:00:00.000Z', status: 'open', deadlineFrom: 'none', ...over });

  it('places open To Dos only, and shows a slot or why there is none', () => {
    const r = todoSlots([state('a', { effortMinutes: 45 }), state('done', { status: 'done' }), state('long', { effortMinutes: 700 })], { now: new Date('2026-10-12T08:02:00.000Z'), workHours: 'Mon–Fri 08:00–18:30', events: [] });
    expect(Object.keys(r).sort()).toEqual(['a', 'long']);
    expect(slotOf(r.a)).toEqual({ slot: { start: '2026-10-12T08:15:00.000Z', end: '2026-10-12T09:00:00.000Z', by: 'plan' } });
    expect(slotOf(r.long)).toEqual({ noSlot: { reason: 'too_long' } });
    expect(slotOf(undefined)).toEqual({});
  });
});
