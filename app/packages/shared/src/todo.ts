import { askId } from './projection/topics';
import type { NextStep } from './schemas';
import { londonParts } from './time';

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
