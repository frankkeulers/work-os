import { SCHEDULE_MAX_ATTEMPTS, SCHEDULE_MAX_PER_CALL, ScheduleAnswer, clampPlan, londonParts, type EventDraft, type Projection, type Settings, type TodoState } from '@work-os/shared';
import type { ClaudeAdapter } from '../claude/adapter';
import { ClaudeOutputError } from '../claude/errors';
import type { Prompt } from '../claude/prompts';
import type { Logger } from '../log';
import { DEADLINES } from '../net/http';
import type { SnapEvent } from '../sources/calendar/store';
import type { ItemFiles } from '../store/items';
import type { Store } from '../store/store';
import type { TodoText, TodoTextStore } from '../store/todos';

// A To Do's plan (E15, FR-16.6): a short model call, no tools, estimates how long each new To Do
// takes, how sure it is, and when it would ideally be done. It runs after triage, with the settle
// and finish checks, and counts towards triage's budget. Code clamps the answer (clampPlan): a
// deadline the To Do already has is a ceiling. The whys and the input go to todos/ first, then
// one append logs `todo.planned` for each. A failed try is logged and retried on the next run;
// after SCHEDULE_MAX_ATTEMPTS the To Do shows without an estimate.

/** The conversation's end, as sent: enough to see what the step is about. */
export const EXCERPT_MAX = 1500;
/** The calendar sent: the next five working days, at most this many meetings. */
export const CALENDAR_DAYS = 7;
export const CALENDAR_MAX = 60;

export interface ScheduleDeps {
  store: Store;
  items: ItemFiles;
  texts: TodoTextStore;
  claude: ClaudeAdapter;
  now: () => Date;
  logger?: Logger;
  config: () => { settings: Settings };
  prompt: () => Promise<Prompt>;
  /** Today's triage calls or cost-equivalent are at their budget (CL-6). Plans count towards it. */
  budgetHit: () => boolean;
  /** The calendar snapshot's events, while Outlook Calendar is on. */
  calendar?: () => readonly SnapEvent[] | undefined;
}

export interface ScheduleRun {
  calls: number;
  planned: number;
  failed: number;
  /** Waiting, but not sent: the budget is spent. */
  paused: number;
}

/** One To Do as the model sees it. */
export interface ScheduleInput {
  id: string;
  step: string;
  source: string;
  kind?: string;
  title: string;
  summary?: string;
  asks?: string[];
  deadline?: string;
  deadlineLondon?: string;
  excerpt?: string;
}

/** The To Dos waiting for a plan: open, unplanned, and not given up on. */
export const scheduleQueue = (p: Projection): TodoState[] =>
  Object.values(p.todos ?? {})
    .filter((t) => t.status === 'open' && !t.planned && (t.planFailures ?? 0) < SCHEDULE_MAX_ATTEMPTS)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

const hhmm = (d: Date | string) => {
  const p = londonParts(d);
  return `${String(p.hours).padStart(2, '0')}:${String(p.minutes).padStart(2, '0')}`;
};
const when = (iso: string) => `${londonParts(iso).weekday} ${londonParts(iso).dateKey} ${hhmm(iso)}`;

/** A To Do as sent, from its words and its item's file while there is one. */
export async function scheduleInputOf(d: Pick<ScheduleDeps, 'items'>, t: TodoState, words: TodoText): Promise<ScheduleInput> {
  const stored = await d.items.read(words.source.source, t.itemId).catch(() => undefined);
  const asks = stored?.text?.next?.asks?.map((a) => a.step);
  const tail = stored?.item.messages.map((m) => m.text).join('\n\n') ?? '';
  return {
    id: t.id,
    step: words.step,
    source: words.source.source,
    ...(stored && { kind: stored.item.kind }),
    title: words.source.title,
    ...(stored?.text?.summary && { summary: stored.text.summary }),
    ...(asks && asks.length > 1 && { asks }),
    ...(t.deadline && { deadline: t.deadline, deadlineLondon: when(t.deadline) }),
    ...(tail && { excerpt: tail.length > EXCERPT_MAX ? `…${tail.slice(-EXCERPT_MAX)}` : tail }),
  };
}

/** Meetings that take Frank's time over the coming days: not cancelled, declined or free. */
export function calendarFor(events: readonly SnapEvent[], now: Date) {
  const to = new Date(now.getTime() + CALENDAR_DAYS * 86_400_000).toISOString();
  return events
    .filter((e) => !e.cancelled && e.response !== 'declined' && e.showAs !== 'free' && e.end > now.toISOString() && e.start < to)
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, CALENDAR_MAX)
    .map((e) => ({ start: e.start, end: e.end, ...(e.allDay && { allDay: true }), title: e.subject }));
}

/** The user message: the time, Frank's hours and meetings, then the To Dos. */
export function renderSchedule(todos: ScheduleInput[], at: { now: Date; workHours: string; calendar?: ReturnType<typeof calendarFor> }): string {
  return [
    `Now: ${at.now.toISOString()} (${londonParts(at.now).weekday} ${hhmm(at.now)} in London)`,
    `Working hours: ${at.workHours}`,
    `Plan ${todos.length === 1 ? 'this To Do' : `these ${todos.length} To Dos`}. Answer with the JSON only.`,
    '<calendar>',
    at.calendar ? JSON.stringify(at.calendar) : 'Not known.',
    '</calendar>',
    '<todos>',
    JSON.stringify(todos),
    '</todos>',
  ].join('\n');
}

/** Plans every To Do waiting for one. Throws ClaudeError (for health) or the abort reason; batches that finished before stay. */
export async function runSchedule(d: ScheduleDeps, signal: AbortSignal): Promise<ScheduleRun> {
  const { settings } = d.config();
  const run: ScheduleRun = { calls: 0, planned: 0, failed: 0, paused: 0 };
  const queue = scheduleQueue(d.store.projection).filter((t) => d.texts.get(t.id));
  if (!queue.length) return run;
  if (d.budgetHit()) return { ...run, paused: queue.length };

  const failed = (t: TodoState, reason: 'output' | 'claude'): EventDraft => ({ type: 'todo.planFailed', itemId: t.itemId, actionId: t.actionId, data: { todoId: t.id, attempts: (t.planFailures ?? 0) + 1, reason } });
  const prompt = await d.prompt();
  const events = d.calendar?.();
  for (let n = 0; n * SCHEDULE_MAX_PER_CALL < queue.length; n++) {
    const batch = queue.slice(n * SCHEDULE_MAX_PER_CALL, (n + 1) * SCHEDULE_MAX_PER_CALL);
    if (n > 0 && d.budgetHit()) {
      run.paused += queue.length - n * SCHEDULE_MAX_PER_CALL;
      break;
    }
    const now = d.now();
    const inputs = await Promise.all(batch.map((t) => scheduleInputOf(d, t, d.texts.get(t.id)!)));
    let answer: ScheduleAnswer;
    try {
      const r = await d.claude.structured(
        {
          purpose: 'schedule',
          model: settings.models.triage,
          system: prompt.text,
          prompt: renderSchedule(inputs, { now, workHours: settings.schedule.workHours, ...(events && { calendar: calendarFor(events, now) }) }),
          promptVersion: prompt.version,
          timeoutMs: DEADLINES.triage,
          signal,
          itemIds: [...new Set(batch.map((t) => t.itemId))],
        },
        ScheduleAnswer,
      );
      run.calls += r.usage.length;
      answer = r.value;
    } catch (err) {
      if (signal.aborted) throw err; // cut off by sleep: not a failure
      run.failed += batch.length;
      if (err instanceof ClaudeOutputError) {
        run.calls += err.attempts;
        await d.store.append(...batch.map((t) => failed(t, 'output')));
        continue;
      }
      await d.store.append(...batch.map((t) => failed(t, 'claude')));
      throw err;
    }

    const byId = new Map(answer.todos.map((a) => [a.id, a]));
    const out: EventDraft[] = [];
    for (const [i, t] of batch.entries()) {
      const a = byId.get(t.id);
      const words = d.texts.get(t.id);
      if (!a || !words) {
        out.push(failed(t, 'output'));
        run.failed++;
        continue;
      }
      // Against the To Do as it is now: Frank may have set its deadline meanwhile.
      const current = d.store.projection.todos?.[t.id] ?? t;
      const plan = clampPlan(a, { now, ...(current.deadline && { deadline: current.deadline }) });
      await d.texts.put({ ...words, plan: { at: now.toISOString(), model: settings.models.triage, promptVersion: prompt.version, input: { ...inputs[i] }, estimateWhy: plan.estimateWhy, ...(plan.deadlineWhy && { deadlineWhy: plan.deadlineWhy }) } });
      out.push({ type: 'todo.planned', itemId: t.itemId, actionId: t.actionId, data: { todoId: t.id, effortMinutes: plan.effortMinutes, confidence: plan.confidence, ...(plan.ideal && { ideal: plan.ideal }) } });
      run.planned++;
    }
    if (out.length) await d.store.append(...out);
  }
  d.logger?.info({ ...run }, 'To Do plans');
  return run;
}
