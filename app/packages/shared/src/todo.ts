import { askId } from './projection/topics';
import type { NextStep } from './schemas';
import { londonAt, londonParts } from './time';

// To-dos (UX-5): an item's next steps as Obsidian Tasks lines in one Tasks note, built by code, never
// a model: `- [ ] {step} 📅 YYYY-MM-DD [source](permalink)`. The date is the step's deadline in
// London; a step with none has no date. Frank reviews the lines and approves; code appends them.

/** At most this many lines in one to-do, and this long each. */
export const TODO_MAX_LINES = 20;
export const TODO_MAX_STEP = 300;

export interface TodoStep {
  step: string;
  dueAt?: string;
}

/** One line of text, without list or checkbox markers of its own. */
export const cleanStep = (s: string) =>
  s
    .replace(/\s+/g, ' ')
    .replace(/^\s*(?:[-*+]\s*)?(?:\[[ xX]?\]\s*)?/, '')
    .trim()
    .slice(0, TODO_MAX_STEP);

/**
 * Frank's open steps on an item: a topic's open asks, each with its deadline; or a meeting's action
 * items; or the next step alone; or the summary as something to follow up.
 */
export function todoSteps(text: { summary?: string; next?: NextStep } | undefined, asksDone: readonly string[] = []): TodoStep[] {
  const next = text?.next;
  const asks = next?.asks?.filter((a) => !asksDone.includes(askId(a.step)));
  const out: TodoStep[] = asks?.length
    ? asks.map((a) => ({ step: a.step, ...(a.dueAt && { dueAt: a.dueAt }) }))
    : next?.actionItems?.length
      ? next.actionItems.map((step) => ({ step }))
      : next
        ? [{ step: next.step, ...(next.dueAt && { dueAt: next.dueAt }) }]
        : text?.summary
          ? [{ step: `Follow up: ${text.summary}` }]
          : [];
  return out.map((s) => ({ ...s, step: cleanStep(s.step) })).filter((s) => s.step).slice(0, TODO_MAX_LINES);
}

/** A Markdown link's text, with the characters that would end it escaped. */
const linkText = (s: string) => s.replace(/[[\]\\]/g, (c) => `\\${c}`);

/** `- [ ] Send the tier comparison 📅 2026-10-09 [#mvi-launch](https://…)` */
export function todoLine(s: TodoStep, source: { title: string; permalink: string }): string {
  const due = s.dueAt ? ` 📅 ${londonParts(s.dueAt).dateKey}` : '';
  return `- [ ] ${cleanStep(s.step)}${due} [${linkText(source.title)}](${source.permalink.replace(/\s/g, '%20')})`;
}

export const todoContent = (steps: readonly TodoStep[], source: { title: string; permalink: string }) => steps.map((s) => todoLine(s, source)).join('\n');

/** The task lines in a to-do's text, as written: every non-empty line, each made a task if it isn't one. */
export function todoLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/^- \[[ xX]\] /.test(l) ? l : `- [ ] ${cleanStep(l)}`))
    .slice(0, TODO_MAX_LINES);
}

// ---------------------------------------------------------------- To Dos in Work OS (E15)

// Each written line becomes a To Do that Work OS tracks (FR-16.1). A line carries the Tasks
// plugin's id field, `🆔 a1b2c3`, so it can be found again after Frank moves or edits it in
// Obsidian. Ids come from the action and the task, so writing the same line again gives it the
// same id, and an attempt cut short and finished later writes nothing new.

/** FNV-1a, as askId: it runs the same in the browser and on the server. */
function fnv(s: string, seed = 0x811c9dc5): string {
  let h = seed;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const ID_FIELD = /\s*🆔\s*([A-Za-z0-9_-]+)/u;
const DONE_FIELD = /\s*✅\s*(\d{4}-\d{2}-\d{2})/u;
const DUE_FIELD = /\s*📅\s*(\d{4}-\d{2}-\d{2})/u;
const TRAILING_LINK = /\s*\[((?:\\.|[^\]\\])*)\]\(([^)\s]*)\)\s*$/;

/**
 * A task as Frank may have left it: ticked or not, with or without the ✅ date the Tasks plugin
 * adds when it is ticked (✅ 2026-10-06), and with or without its id, it is the same task.
 */
export const taskKey = (line: string) => line.trim().replace(/^[-*+] \[.\]\s*/, '').replace(DONE_FIELD, '').replace(ID_FIELD, '').trim();

/** A line's id: from the action and the task, so the same line always gets the same one. */
export const lineIdFor = (actionId: string, line: string) => fnv(`${actionId}:${taskKey(line)}`).slice(0, 6);

/** A To Do's id, from the action that wrote its line and the line's id (or, without one, its task). */
export const todoIdFor = (actionId: string, lineId: string) => `todo-${fnv(`${actionId}:${lineId}`)}${fnv(lineId, 0x01000193).slice(0, 4)}`;

/** The line with its id, after the date when there is one, else before the link back. A line that has an id keeps it. */
export function withLineId(line: string, actionId: string): string {
  if (ID_FIELD.test(line)) return line;
  const id = ` 🆔 ${lineIdFor(actionId, line)}`;
  const due = DUE_FIELD.exec(line);
  if (due) return line.slice(0, due.index + due[0].length) + id + line.slice(due.index + due[0].length);
  const link = TRAILING_LINK.exec(line);
  return link ? line.slice(0, link.index) + id + line.slice(link.index) : line + id;
}

export interface TaskLine {
  ticked: boolean;
  /** The ✅ date the Tasks plugin added when it was ticked. */
  doneOn?: string;
  /** The 📅 date. */
  due?: string;
  lineId?: string;
  /** The task's own words: no checkbox, dates, id or link back. */
  step: string;
  key: string;
}

/** A Tasks line read back, or undefined for a line that isn't a task. */
export function parseTaskLine(line: string): TaskLine | undefined {
  const m = /^\s*[-*+] \[(.)\]\s?(.*)$/.exec(line);
  if (!m) return undefined;
  const body = m[2];
  const done = DONE_FIELD.exec(body)?.[1];
  const due = DUE_FIELD.exec(body)?.[1];
  const lineId = ID_FIELD.exec(body)?.[1];
  return {
    ticked: m[1] !== ' ',
    ...(done && { doneOn: done }),
    ...(due && { due }),
    ...(lineId && { lineId }),
    // The done date goes first: the Tasks plugin adds it after the link back.
    step: body.replace(DONE_FIELD, '').replace(ID_FIELD, '').replace(TRAILING_LINK, '').replace(DUE_FIELD, '').trim(),
    key: taskKey(line),
  };
}

/**
 * The line ticked on `on` (YYYY-MM-DD), as the Tasks plugin ticks it: [x] and a ✅ date at the
 * end; or, without `on`, unticked, the ✅ date gone (FR-16.4). Anything else on the line stays.
 */
export function withTick(line: string, on?: string): string {
  const m = /^(\s*[-*+] )\[(.)\](.*)$/.exec(line);
  if (!m) return line;
  if (on === undefined) return `${m[1]}[ ]${m[3].replace(DONE_FIELD, '')}`;
  const rest = m[3].replace(/\s+$/, '');
  return `${m[1]}[x]${DONE_FIELD.test(rest) ? rest : `${rest} ✅ ${on}`}`;
}

/** Where a To Do's deadline came from: triage, the line's date, none, or Frank's own (FR-16.7). */
export type DeadlineFrom = 'triage' | 'line' | 'none' | 'you';

/**
 * A To Do's deadline: triage's, while the line still has its date; else the line's 📅 date at
 * 17:30 London, as triage reads "end of day"; else none. `dues` are triage's deadlines by task.
 */
export function todoDeadline(line: string, dues?: Record<string, string>): { deadline?: string; deadlineFrom: Exclude<DeadlineFrom, 'you'> } {
  const p = parseTaskLine(line);
  if (!p?.due) return { deadlineFrom: 'none' };
  const iso = dues?.[p.key];
  if (iso && londonParts(iso).dateKey === p.due) return { deadline: iso, deadlineFrom: 'triage' };
  return { deadline: londonAt(new Date(`${p.due}T12:00:00Z`), '17:30'), deadlineFrom: 'line' };
}

/** The lines an approved to-do writes, each with its id. */
export const todoWriteLines = (content: string, actionId: string) => todoLines(content).map((l) => withLineId(l, actionId));

export interface NewTodo {
  todoId: string;
  /** Absent for a backfilled To Do: its line went into the note without one. */
  lineId?: string;
  step: string;
  line: string;
  deadline?: string;
  deadlineFrom: Exclude<DeadlineFrom, 'you'>;
}

/**
 * The To Dos a written to-do makes (FR-16.1): one per task line, those `known` left out. Ids come
 * from the action and the line, so the same action always makes the same To Dos. `backfilled`: a
 * to-do written before To Dos had ids, so its lines are read as written, without one.
 */
export function newTodos(actionId: string, d: { content: string; dues?: Record<string, string> }, known: (todoId: string) => boolean, backfilled = false): NewTodo[] {
  const out: NewTodo[] = [];
  for (const line of backfilled ? todoLines(d.content) : todoWriteLines(d.content, actionId)) {
    const p = parseTaskLine(line);
    if (!p?.step) continue;
    const todoId = todoIdFor(actionId, p.lineId ?? lineIdFor(actionId, line));
    if (known(todoId) || out.some((t) => t.todoId === todoId)) continue;
    const { deadline, deadlineFrom } = todoDeadline(line, d.dues);
    out.push({ todoId, ...(!backfilled && p.lineId && { lineId: p.lineId }), step: p.step, line, ...(deadline && { deadline }), deadlineFrom });
  }
  return out;
}

/** Triage's deadlines by task, for a to-do's lines as built, so todoDeadline can read them back. */
export function todoDues(steps: readonly TodoStep[], source: { title: string; permalink: string }): Record<string, string> | undefined {
  const out = Object.fromEntries(steps.filter((s) => s.dueAt).map((s) => [taskKey(todoLine(s, source)), s.dueAt!]));
  return Object.keys(out).length ? out : undefined;
}
