import { join } from 'node:path';
import { SCHEDULE_MAX_PER_CALL, ScheduleAnswer, clampPlan, londonParts, type LoopScore, type Rate, type Settings, type SourceId } from '@work-os/shared';
import type { ClaudeAdapter } from '../claude/adapter';
import { ClaudeOutputError } from '../claude/errors';
import type { Prompt } from '../claude/prompts';
import type { Logger } from '../log';
import { DEADLINES } from '../net/http';
import { writeJsonAtomic } from '../store/atomic';
import type { ScheduleLabelRecord } from '../store/scheduleLabels';
import { renderSchedule, type ScheduleInput } from './schedule';

// The schedule eval (E15, FR-16.15): the schedule prompt and model over labels/schedule.jsonl,
// one case per labelled To Do, scored on its estimate (against how long it took, or Frank's own
// estimate) and its ideal deadline (against the deadline Frank set, or the ideal he kept until
// Done). The calendar isn't in the labels, so the prompt is re-run without it. Saved to
// logs/schedule-eval-<timestamp>.json. Calls are logged with purpose `eval`.

/** The estimate is far too short when it took over 1.5 times as long; far too long under half. */
const UNDER = 1.5;
const OVER = 0.5;
/** An ideal deadline is right within a working day of Frank's. */
const DEADLINE_SLACK_DAYS = 1;
/** Plans too short leave Frank short of time: the stricter target is on them. */
const ESTIMATE_TARGET = { target: 0.8, recallTarget: 0.7 };

/** One labelled To Do: what the prompt saw, and what Frank's labels say it should have said. */
export interface ScheduleCase {
  todoId: string;
  itemId: string;
  source: SourceId;
  /** When it was planned: the time the prompt is re-run at. */
  now: string;
  input: ScheduleInput;
  /** How long it should take: his answer on Done, else his own estimate. */
  effort?: { minutes: number; from: 'actual' | 'estimate_edit' };
  /** When it should be done: the deadline he set (null: none), else the ideal he kept until Done. */
  deadline?: { at: string | null; from: 'deadline_edit' | 'kept' };
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Every labelled To Do with something to score, in the order first labelled. */
export function scheduleCases(records: readonly ScheduleLabelRecord[]): ScheduleCase[] {
  const by = new Map<string, ScheduleLabelRecord[]>();
  for (const r of records) by.set(r.todoId, [...(by.get(r.todoId) ?? []), r]);
  const out: ScheduleCase[] = [];
  for (const [todoId, lines] of by) {
    const last = lines.at(-1)!;
    let actual: number | undefined;
    let estimate: number | undefined;
    let set: { at: string | null } | undefined;
    let kept: string | undefined;
    for (const l of lines) {
      if (l.origin === 'actual') actual = l.actualMinutes ?? undefined;
      if (l.origin === 'estimate_edit' && typeof l.set?.effortMinutes === 'number') estimate = l.set.effortMinutes;
      if (l.origin === 'deadline_edit' && l.set && 'deadline' in l.set) set = { at: str(l.set.deadline) ?? null };
      if (l.origin === 'done') kept = str(l.was?.ideal);
    }
    const effort = actual ? { minutes: actual, from: 'actual' as const } : estimate ? { minutes: estimate, from: 'estimate_edit' as const } : undefined;
    const deadline = set ? { ...set, from: 'deadline_edit' as const } : kept ? { at: kept, from: 'kept' as const } : undefined;
    if (!effort && !deadline) continue;
    const input = last.input as Partial<ScheduleInput>;
    out.push({
      todoId,
      itemId: last.itemId,
      source: last.source,
      now: str(lines.find((l) => l.was?.createdAt)?.was?.createdAt) ?? lines[0].at,
      input: { ...input, id: todoId, step: input.step ?? '', source: input.source ?? last.source, title: input.title ?? '' },
      ...(effort && { effort }),
      ...(deadline && { deadline }),
    });
  }
  return out;
}

/** Working days (London, Monday to Friday) between two times' dates. */
export function workingDaysApart(a: string, b: string): number {
  const [from, to] = [londonParts(a).dateKey, londonParts(b).dateKey].sort();
  let n = 0;
  for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) < to; ) {
    d = new Date(d.getTime() + 86_400_000);
    if (d.getUTCDay() % 6 !== 0) n++;
  }
  return n;
}

/** One case and what the prompt now plans for it. */
export interface SchedulePredicted {
  case: ScheduleCase;
  effortMinutes: number;
  /** The ideal deadline, after code's clamp. */
  ideal?: string;
}

/** When the plan says it is due: its ideal, else the deadline it already had. */
const dueOf = (r: SchedulePredicted) => r.ideal ?? r.case.input.deadline;
const near = (a: string | undefined, b: string | null) => !!a && !!b && workingDaysApart(a, b) <= DEADLINE_SLACK_DAYS;

/**
 * The estimate and the deadline as the tuner's rows. Estimate: precision is the share not far too
 * short, recall the share not far too long. Deadline: precision is the share of ideals the prompt
 * gives that land within a working day of Frank's; recall the share of his dates the plan gets.
 */
export function scheduleRows(rows: readonly SchedulePredicted[]): LoopScore[] {
  const timed = rows.filter((r) => r.case.effort);
  const under = timed.filter((r) => r.case.effort!.minutes > UNDER * r.effortMinutes).length;
  const over = timed.filter((r) => r.case.effort!.minutes < OVER * r.effortMinutes).length;
  const dated = rows.filter((r) => r.case.deadline);
  const ideals = dated.filter((r) => r.ideal);
  const wanted = dated.filter((r) => r.case.deadline!.at);
  return [
    { key: 'estimate', label: 'Estimate', precision: timed.length ? 1 - under / timed.length : 0, recall: timed.length ? 1 - over / timed.length : 0, n: timed.length, ...ESTIMATE_TARGET },
    {
      key: 'deadline',
      label: 'Ideal deadline',
      // No ideal given is never a wrong one; recall counts the dates it then misses.
      precision: ideals.length ? ideals.filter((r) => near(r.ideal, r.case.deadline!.at)).length / ideals.length : 1,
      recall: wanted.length ? wanted.filter((r) => near(dueOf(r), r.case.deadline!.at)).length / wanted.length : 1,
      n: dated.length,
    },
  ];
}

const day = (iso: string) => `${londonParts(iso).weekday} ${londonParts(iso).dateKey}`;
const EFFORT_HOW = { actual: 'his answer on Done', estimate_edit: 'his own estimate' } as const;
const DEADLINE_HOW = { deadline_edit: 'he set it himself', kept: 'he kept the ideal until Done' } as const;

/** What the plan got wrong on one To Do, or nothing. */
export function scheduleMiss(r: SchedulePredicted): object | undefined {
  const wrong: string[] = [];
  const e = r.case.effort;
  if (e && (e.minutes > UNDER * r.effortMinutes || e.minutes < OVER * r.effortMinutes)) wrong.push(`effort: ${e.minutes} minutes (${EFFORT_HOW[e.from]}); the prompt estimated ${r.effortMinutes}`);
  const d = r.case.deadline;
  if (d && !(d.at ? near(dueOf(r), d.at) : !r.ideal)) {
    const said = r.ideal ? day(r.ideal) : r.case.input.deadline ? `no ideal, so its deadline ${day(r.case.input.deadline)}` : 'no ideal deadline';
    wrong.push(`ideal deadline: ${d.at ? day(d.at) : 'none'} (${DEADLINE_HOW[d.from]}); the prompt said ${said}`);
  }
  return wrong.length ? { todo: r.case.input, plannedAt: r.case.now, wrong } : undefined;
}

export interface ScheduleEvalDeps {
  claude: ClaudeAdapter;
  settings: Settings;
  prompt: Prompt;
  now: () => Date;
  signal?: AbortSignal;
  logger?: Logger;
}

/** What the prompt plans for each case, the To Dos planned on one day together. Throws ClaudeError when Claude can't be called. */
export async function predictSchedule(d: ScheduleEvalDeps, cases: readonly ScheduleCase[]): Promise<{ rows: SchedulePredicted[]; failed: number; tokens: number; cost: number }> {
  const days = new Map<string, ScheduleCase[]>();
  for (const c of cases) days.set(londonParts(c.now).dateKey, [...(days.get(londonParts(c.now).dateKey) ?? []), c]);
  const rows: SchedulePredicted[] = [];
  let failed = 0;
  let tokens = 0;
  let cost = 0;
  for (const same of days.values()) {
    for (let i = 0; i < same.length; i += SCHEDULE_MAX_PER_CALL) {
      const batch = same.slice(i, i + SCHEDULE_MAX_PER_CALL);
      // The latest of them, so none is planned before it existed.
      const now = new Date(batch.reduce((m, c) => (c.now > m ? c.now : m), batch[0].now));
      try {
        const out = await d.claude.structured(
          {
            purpose: 'eval',
            model: d.settings.models.triage,
            system: d.prompt.text,
            prompt: renderSchedule(
              batch.map((c) => c.input),
              { now, workHours: d.settings.schedule.workHours },
            ),
            promptVersion: d.prompt.version,
            timeoutMs: DEADLINES.triage,
            signal: d.signal,
            itemIds: [...new Set(batch.map((c) => c.itemId))],
          },
          ScheduleAnswer,
        );
        for (const u of out.usage) {
          tokens += u.inputTokens + u.outputTokens + u.cacheTokens;
          cost += u.costEquivalent;
        }
        const byId = new Map(out.value.todos.map((a) => [a.id, a]));
        for (const c of batch) {
          const a = byId.get(c.todoId);
          if (!a) {
            failed++;
            continue;
          }
          const plan = clampPlan(a, { now, ...(c.input.deadline && { deadline: c.input.deadline }) });
          rows.push({ case: c, effortMinutes: plan.effortMinutes, ...(plan.ideal && { ideal: plan.ideal }) });
        }
      } catch (err) {
        if (!(err instanceof ClaudeOutputError)) throw err;
        failed += batch.length; // out of shape twice: counted, not scored
      }
    }
  }
  return { rows, failed, tokens, cost };
}

/** A To Do loop's eval report: its rows, as Settings › Learning and the tuner read them. */
export interface LoopEvalReport {
  id: string;
  at: string;
  loop: 'schedule' | 'followup';
  model: string;
  promptVersion: string;
  /** Labelled To Dos scored. */
  labelCount: number;
  /** Got no usable answer: not scored. */
  failed: number;
  scores: LoopScore[];
  tokens: number;
  costEquivalent: number;
}

/** Re-plans every labelled To Do. Throws ClaudeError when Claude can't be called. */
export async function runScheduleEval(d: ScheduleEvalDeps, records: readonly ScheduleLabelRecord[]): Promise<LoopEvalReport> {
  const cases = scheduleCases(records);
  if (!cases.length) throw new Error('No To Do has a time taken or a deadline of Frank’s yet.');
  const { rows, failed, tokens, cost } = await predictSchedule(d, cases);
  const at = d.now().toISOString();
  const scores = scheduleRows(rows);
  d.logger?.info({ labels: cases.length, failed, tokens }, 'Schedule eval finished');
  return { id: `schedule-eval-${at}`, at, loop: 'schedule', model: d.settings.models.triage, promptVersion: d.prompt.version, labelCount: cases.length, failed, scores, tokens, costEquivalent: Math.round(cost * 10_000) / 10_000 };
}

/** logs/<loop>-eval-<timestamp>.json. */
export async function saveLoopReport(logsDir: string, report: LoopEvalReport): Promise<string> {
  const file = join(logsDir, `${report.loop}-eval-${report.at.replace(/[:.]/g, '-')}.json`);
  await writeJsonAtomic(file, report);
  return file;
}

/**
 * What code decides from the plan, measured and never tuned: planned times Frank kept until Done
 * (none moved by him), and To Dos done by their deadline, or their ideal one.
 */
export function scheduleMeasures(records: readonly ScheduleLabelRecord[]): { slotsKept: Rate; doneByDeadline: Rate } {
  const moved = new Set(records.filter((r) => r.origin === 'slot_moved').map((r) => r.todoId));
  const done = new Map<string, ScheduleLabelRecord>();
  for (const r of records) if (r.origin === 'done') done.set(r.todoId, r);
  const slot = (r: ScheduleLabelRecord) => r.was?.slot as { by?: string } | undefined;
  const planned = [...done.values()].filter((r) => slot(r) || moved.has(r.todoId));
  const kept = planned.filter((r) => slot(r)?.by === 'plan' && !moved.has(r.todoId)).length;
  const due = [...done.values()].flatMap((r) => str(r.was?.deadline) ?? str(r.was?.ideal) ?? []).length;
  const byDue = [...done.values()].filter((r) => {
    const by = str(r.was?.deadline) ?? str(r.was?.ideal);
    return by && r.at <= by;
  }).length;
  const rate = (k: number, n: number): Rate => ({ rate: n ? k / n : 0, n });
  return { slotsKept: rate(kept, planned.length), doneByDeadline: rate(byDue, due) };
}
