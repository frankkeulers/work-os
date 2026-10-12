import { describe, expect, it } from 'vitest';
import type { ClaudeAdapter, RunSpec } from '../claude/adapter';
import { DEFAULT_FOLLOWUP_PROMPT, DEFAULT_SCHEDULE_PROMPT, type Prompt } from '../claude/prompts';
import { defaultSettings } from '../config/defaults';
import { followupCases, followupMiss, followupRows, type FollowupPredicted } from '../pipeline/evalFollowup';
import { scheduleCases, scheduleMeasures, scheduleMiss, scheduleRows, workingDaysApart, type ScheduleCase, type SchedulePredicted } from '../pipeline/evalSchedule';
import type { ScheduleInput } from '../pipeline/schedule';
import type { FollowupLabelRecord } from '../store/followupLabels';
import type { ScheduleLabelRecord } from '../store/scheduleLabels';
import { followupLoop } from './followupLoop';
import { scheduleLoop } from './scheduleLoop';
import { heldOut, propose } from './tuner';

// The To Do loops (E15, FR-16.14–16.15): labels made into cases, the rows and misses the tuner
// reads, and both adapters end to end with a fake Claude. No live calls.

const NOW = new Date('2026-10-12T16:00:00.000Z'); // a Monday
const settings = defaultSettings('/tmp/workos-test');

const sl = (todoId: string, origin: ScheduleLabelRecord['origin'], extra: Partial<ScheduleLabelRecord> = {}, itemId = 'slack:C1:1.0'): ScheduleLabelRecord => ({
  schemaVersion: 1,
  at: '2026-10-12T10:00:00.000Z',
  origin,
  todoId,
  itemId,
  source: 'slack',
  input: { id: todoId, step: 'Write the export spec', source: 'slack', title: 'Export' },
  was: { createdAt: '2026-10-12T09:00:00.000Z', deadlineFrom: 'none' },
  ...extra,
});

describe('schedule cases', () => {
  it('takes how long it took over Frank’s own estimate, and his deadline over an ideal he kept', () => {
    const cases = scheduleCases([
      sl('todo-a', 'actual', { actualMinutes: 90 }),
      sl('todo-a', 'actual', { actualMinutes: null }), // taken back
      sl('todo-a', 'estimate_edit', { set: { effortMinutes: 45 } }),
      sl('todo-b', 'estimate_edit', { set: { effortMinutes: 20 } }),
      sl('todo-b', 'actual', { actualMinutes: 60 }),
      sl('todo-c', 'deadline_edit', { set: { deadline: null } }),
      sl('todo-d', 'done', { was: { createdAt: '2026-10-12T09:00:00.000Z', deadlineFrom: 'none', ideal: '2026-10-14T16:00:00.000Z' } }),
      sl('todo-e', 'slot_moved', { set: { slot: { start: '2026-10-12T13:00:00.000Z', end: '2026-10-12T13:30:00.000Z' } } }),
    ]);
    expect(cases.map((c) => [c.todoId, c.effort, c.deadline])).toEqual([
      ['todo-a', { minutes: 45, from: 'estimate_edit' }, undefined],
      ['todo-b', { minutes: 60, from: 'actual' }, undefined],
      ['todo-c', undefined, { at: null, from: 'deadline_edit' }],
      ['todo-d', undefined, { at: '2026-10-14T16:00:00.000Z', from: 'kept' }],
    ]);
    expect(cases[0]).toMatchObject({ itemId: 'slack:C1:1.0', now: '2026-10-12T09:00:00.000Z', input: { id: 'todo-a', step: 'Write the export spec' } });
  });

  it('counts working days between two dates in London, either way round', () => {
    expect(workingDaysApart('2026-10-16T15:00:00.000Z', '2026-10-19T09:00:00.000Z')).toBe(1); // Friday to Monday
    expect(workingDaysApart('2026-10-14T09:00:00.000Z', '2026-10-12T09:00:00.000Z')).toBe(2);
    expect(workingDaysApart('2026-10-12T07:00:00.000Z', '2026-10-12T22:00:00.000Z')).toBe(0);
  });
});

const sc = (effort?: number, deadline?: string | null, input: Partial<ScheduleInput> = {}): ScheduleCase => ({
  todoId: 'todo-a',
  itemId: 'slack:C1:1.0',
  source: 'slack',
  now: '2026-10-12T09:00:00.000Z',
  input: { id: 'todo-a', step: 'Write the export spec', source: 'slack', title: 'Export', ...input },
  ...(effort && { effort: { minutes: effort, from: 'actual' as const } }),
  ...(deadline !== undefined && { deadline: { at: deadline, from: 'deadline_edit' as const } }),
});
const sp = (c: ScheduleCase, effortMinutes: number, ideal?: string): SchedulePredicted => ({ case: c, effortMinutes, ...(ideal && { ideal }) });
const WED = '2026-10-14T16:00:00.000Z';
const THU = '2026-10-15T16:00:00.000Z';
const MON = '2026-10-19T16:00:00.000Z';

describe('schedule rows', () => {
  it('has nothing to say without labels', () => {
    expect(scheduleRows([])).toEqual([
      { key: 'estimate', label: 'Estimate', precision: 0, recall: 0, n: 0, target: 0.8, recallTarget: 0.7 },
      { key: 'deadline', label: 'Ideal deadline', precision: 1, recall: 1, n: 0 },
    ]);
  });

  it('is all right when every estimate is close and every ideal lands', () => {
    expect(scheduleRows([sp(sc(30, WED), 30, WED), sp(sc(40, THU), 30, WED)]).map((r) => [r.precision, r.recall, r.n])).toEqual([
      [1, 1, 2],
      [1, 1, 2],
    ]);
  });

  it('counts estimates far too short against precision, far too long against recall', () => {
    const [estimate] = scheduleRows([sp(sc(100), 30), sp(sc(10), 30), sp(sc(30), 30)]);
    expect(estimate).toMatchObject({ precision: expect.closeTo(2 / 3), recall: expect.closeTo(2 / 3), n: 3 });
  });

  it('scores ideals within a working day of Frank’s, and his dates the plan gets, its deadline included', () => {
    const [, deadline] = scheduleRows([
      sp(sc(undefined, WED), 30, THU), // a day out: right
      sp(sc(undefined, WED), 30, MON), // wrong
      sp(sc(undefined, WED, { deadline: WED }), 30), // no ideal, its deadline is his
      sp(sc(undefined, null), 30, THU), // he wanted none
    ]);
    expect(deadline).toMatchObject({ precision: 1 / 3, recall: 2 / 3, n: 4 });
  });

  it('shows the tuner what went wrong, nothing for a right one', () => {
    expect(scheduleMiss(sp(sc(30, WED), 30, WED))).toBeUndefined();
    expect(scheduleMiss(sp(sc(90, WED), 30, MON))).toEqual({
      todo: sc().input,
      plannedAt: '2026-10-12T09:00:00.000Z',
      wrong: ['effort: 90 minutes (his answer on Done); the prompt estimated 30', 'ideal deadline: Wed 2026-10-14 (he set it himself); the prompt said Mon 2026-10-19'],
    });
    expect(scheduleMiss(sp(sc(undefined, WED, { deadline: MON }), 30))).toMatchObject({ wrong: ['ideal deadline: Wed 2026-10-14 (he set it himself); the prompt said no ideal, so its deadline Mon 2026-10-19'] });
  });
});

describe('schedule measures', () => {
  it('counts planned times kept until Done, and To Dos done by their deadline', () => {
    const plan = { start: '2026-10-12T13:00:00.000Z', end: '2026-10-12T13:30:00.000Z' };
    const was = (extra: object) => ({ createdAt: '2026-10-12T09:00:00.000Z', deadlineFrom: 'none', ...extra });
    const m = scheduleMeasures([
      sl('todo-a', 'done', { at: '2026-10-12T14:00:00.000Z', was: was({ slot: { ...plan, by: 'plan' }, deadline: WED }) }),
      sl('todo-b', 'slot_moved', { set: { slot: plan } }),
      sl('todo-b', 'done', { at: '2026-10-15T14:00:00.000Z', was: was({ slot: { ...plan, by: 'you' }, ideal: WED }) }),
      sl('todo-c', 'done', { was: was({}) }),
    ]);
    expect(m).toEqual({ slotsKept: { rate: 0.5, n: 2 }, doneByDeadline: { rate: 0.5, n: 2 } });
    expect(scheduleMeasures([])).toEqual({ slotsKept: { rate: 0, n: 0 }, doneByDeadline: { rate: 0, n: 0 } });
  });
});

const INPUT = { step: 'Send Matt the go/no-go reason', source: 'slack', title: 'Matt M.', canReply: true, itemOpen: true, otherTodos: [] };
const EDITED = 'Sent you the go no go reason it is in the release page now';
const fl = (todoId: string, origin: FollowupLabelRecord['origin'], kind: FollowupLabelRecord['kind'], extra: Partial<FollowupLabelRecord> = {}, itemId = 'slack:D1:1.0'): FollowupLabelRecord => ({
  schemaVersion: 1,
  at: '2026-10-12T15:00:00.000Z',
  origin,
  todoId,
  itemId,
  source: 'slack',
  input: { id: todoId, ...INPUT },
  kind,
  ...extra,
});
const reply = { kind: 'reply', why: 'Matt asked', reply: { text: 'Done: the reason is on the page.' } };

describe('follow-up cases and rows', () => {
  const cases = followupCases([
    fl('todo-a', 'answered', 'reply', { index: 0, answer: 'accepted', suggestion: reply, suggested: ['reply', 'add_todo'] }),
    fl('todo-a', 'answered', 'add_todo', { index: 1, answer: 'dismissed', suggestion: { kind: 'add_todo', why: 'w', todo: { step: 'Book the review' } }, suggested: ['reply', 'add_todo'] }),
    fl('todo-b', 'missed', 'mark_source_done'),
    fl('todo-c', 'answered', 'reply', { index: 0, answer: 'edited', text: EDITED, suggestion: reply, suggested: ['reply', 'mark_source_done'] }),
  ]);

  it('reads what Frank wanted of each kind, and knows nothing of one he never answered', () => {
    expect(cases.map((c) => Object.fromEntries(Object.entries(c.truth).map(([k, t]) => [k, t.wanted])))).toEqual([
      { reply: true, add_todo: false, mark_source_done: false, file_note: false },
      { mark_source_done: true },
      { reply: true, add_todo: false, file_note: false },
    ]);
    expect(cases[2]).toMatchObject({ edited: [EDITED], suggested: ['Done: the reason is on the page.'], input: { id: 'todo-c', canReply: true } });
    expect(cases[1].truth.mark_source_done?.how).toBe('Frank did it himself soon after');
  });

  it('scores each kind where it is known, with the targets for replies and closing', () => {
    const rows: FollowupPredicted[] = [
      { case: cases[0], kinds: ['reply'] },
      { case: cases[1], kinds: [] },
      { case: cases[2], kinds: ['reply', 'mark_source_done'] },
    ];
    expect(followupRows(rows)).toEqual([
      { key: 'reply', label: 'Reply', precision: 1, recall: 1, n: 2, target: 0.7 },
      { key: 'mark_source_done', label: 'Mark the item done', precision: 1, recall: 0, n: 2, target: 0.9 },
      { key: 'add_todo', label: 'Add a To Do', precision: 1, recall: 1, n: 2 },
      { key: 'file_note', label: 'File a vault note', precision: 1, recall: 1, n: 2 },
    ]);
    expect(followupMiss(rows[0])).toBeUndefined();
    expect(followupMiss(rows[1])).toEqual({ done: cases[1].input, wrong: ['mark_source_done: wanted (Frank did it himself soon after); the prompt didn’t suggest it'] });
    expect(followupMiss({ case: cases[0], kinds: ['add_todo'] })).toMatchObject({ wrong: ['reply: wanted (Frank used it); the prompt didn’t suggest it', 'add_todo: not wanted (Frank dismissed it); the prompt suggested it'] });
  });
});

/** A fake Claude: `eval` answers by the policy's words, `tune` with the answer given. */
function fakeClaude(evalAnswer: (spec: RunSpec) => unknown, tune: () => unknown) {
  const calls: RunSpec[] = [];
  const claude = {
    structured: async (spec: RunSpec) => {
      calls.push(spec);
      return { value: spec.purpose === 'tune' ? tune() : evalAnswer(spec), attempts: 1, usage: [{ inputTokens: 10, outputTokens: 5, cacheTokens: 0, costEquivalent: 0.001 }] };
    },
  } as unknown as ClaudeAdapter;
  return { claude, calls };
}
const idsIn = (prompt: string, tag: string) => (JSON.parse(new RegExp(`<${tag}>\\n([\\s\\S]*)\\n</${tag}>`).exec(prompt)![1]) as { id: string }[]).map((t) => t.id);
const bump = (p: string, id: string) => p.replace(`<!-- prompt: ${id} v1 -->`, `<!-- prompt: ${id} v2 -->`);
const tuneDeps = (claude: ClaudeAdapter, current: string) => ({ claude, now: () => NOW, policy: async (): Promise<Prompt> => ({ text: current, version: 'v1#aaaa' }), prompt: async (): Promise<Prompt> => ({ text: 'tune', version: 'tune-policy v3#bbbb' }) });

describe('the schedule loop end to end', () => {
  // Twenty To Dos on twenty items, each took 90 minutes; the prompt says 30 until it is told otherwise.
  const labels = scheduleCases(Array.from({ length: 20 }, (_, i) => sl(`todo-${i}`, 'actual', { actualMinutes: 90 }, `slack:C1:${i}.0`)));
  const REVISED = `${bump(DEFAULT_SCHEDULE_PROMPT, 'schedule')}- Writing a spec from scratch is longer: 90 minutes.\n`;

  it('re-plans the labelled To Dos, learns from the misses and scores both prompts on those held out', async () => {
    const { claude, calls } = fakeClaude(
      (spec) => ({ todos: idsIn(spec.prompt, 'todos').map((id) => ({ id, effortMinutes: spec.system.includes('is longer') ? 90 : 30, confidence: 'medium', estimateWhy: 'A page.' })) }),
      () => ({ policy: REVISED, changes: [{ kind: 'added', what: 'New pages take longer.' }] }),
    );
    const p = await propose(tuneDeps(claude, DEFAULT_SCHEDULE_PROMPT), scheduleLoop({ claude, settings: () => settings, now: () => NOW }), labels);
    const held = labels.filter((c) => heldOut(c.itemId)).length;
    expect(p).toMatchObject({ status: 'open', loop: 'schedule', promptId: 'schedule', train: 20 - held, heldOut: held, better: true });
    expect(p.scores?.before[0]).toMatchObject({ key: 'estimate', precision: 0, recall: 1 });
    expect(p.scores?.after[0]).toMatchObject({ key: 'estimate', precision: 1, recall: 1 });
    expect(calls[0]).toMatchObject({ purpose: 'eval', model: settings.models.triage });
    expect(calls[0].prompt).toContain('Now: 2026-10-12T09:00:00.000Z');
    expect(calls[0].prompt).toContain('<calendar>\nNot known.\n</calendar>');
    const tune = calls.find((c) => c.purpose === 'tune')!;
    expect(tune.prompt).toContain('<loop>schedule</loop>');
    expect(tune.prompt).toContain('effort: 90 minutes (his answer on Done); the prompt estimated 30');
  });
});

describe('the follow-up loop end to end', () => {
  // Twenty To Dos where Frank sent a reply of his own words; the prompt suggests none until told to.
  const records = Array.from({ length: 20 }, (_, i) => fl(`todo-${i}`, 'answered', 'reply', { index: 0, answer: 'edited', text: EDITED, suggestion: reply, suggested: ['reply'] }, `slack:D1:${i}.0`));
  const answer = (spec: RunSpec) => ({ todos: idsIn(spec.prompt, 'done').map((id) => ({ id, suggestions: spec.system.includes('always reply') ? [reply] : [] })) });

  it('scores the replies the prompt now suggests, and offers one only where Frank can reply', async () => {
    const REVISED = `${bump(DEFAULT_FOLLOWUP_PROMPT, 'followup')}When someone is waiting, always reply.\n`;
    const { claude } = fakeClaude(answer, () => ({ policy: REVISED, changes: [{ kind: 'changed', what: 'Reply when someone waits.' }] }));
    const p = await propose(tuneDeps(claude, DEFAULT_FOLLOWUP_PROMPT), followupLoop({ claude, settings: () => settings, now: () => NOW }), followupCases(records));
    expect(p).toMatchObject({ status: 'open', loop: 'followup', promptId: 'followup', better: true });
    expect(p.scores?.before[0]).toMatchObject({ key: 'reply', recall: 0 });
    expect(p.scores?.after[0]).toMatchObject({ key: 'reply', precision: 1, recall: 1 });
  });

  it('turns down a proposal that copies Frank’s own reply into the prompt', async () => {
    const { claude } = fakeClaude(answer, () => ({ policy: `${bump(DEFAULT_FOLLOWUP_PROMPT, 'followup')}For example: ${EDITED}\n`, changes: [] }));
    const p = await propose(tuneDeps(claude, DEFAULT_FOLLOWUP_PROMPT), followupLoop({ claude, settings: () => settings, now: () => NOW }), followupCases(records));
    expect(p).toMatchObject({ status: 'rejected', rejected: 'It copies eight or more words in a row from a labelled thread.' });
    expect(p.text).toBeUndefined();
  });

  it('keeps a reply only for an item Frank can answer on', async () => {
    const jira = records.map((r) => ({ ...r, input: { ...r.input, canReply: false } }));
    const { claude } = fakeClaude((spec) => ({ todos: idsIn(spec.prompt, 'done').map((id) => ({ id, suggestions: [reply] })) }), () => ({}));
    const r = await followupLoop({ claude, settings: () => settings, now: () => NOW }).evaluate({ text: 'always reply', version: 'v' }, followupCases(jira));
    expect(r.scores[0]).toMatchObject({ key: 'reply', recall: 0, n: 20 });
    expect(r.misses).toHaveLength(20);
  });
});
