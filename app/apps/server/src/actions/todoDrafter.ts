import { londonParts, todoContent, TODO_MAX_LINES, TODO_MAX_STEP, type Item, type Me, type TodoDraft, type TodoStep } from '@work-os/shared';
import { z } from 'zod';
import type { ClaudeAdapter } from '../claude/adapter';
import type { Prompt } from '../claude/prompts';
import { DEADLINES } from '../net/http';
import { DraftError } from './errors';
import { additionalInfo, draftThread } from './vaultDrafter';

// "Add to-do" with Frank's information (FR-9.12): plain Add to-do is built by code from the open
// steps (UX-5), but what Frank adds (who does what, which steps to keep, the dates) needs reading.
// One Haiku call with no tools rewrites the steps; code still makes the Tasks lines, with the date
// and the link back to the source, so the model never writes the format.

export const TODO_MODEL = 'haiku-5.5' as const;

export const TodoAnswer = z.object({
  steps: z
    .array(z.object({ step: z.string().trim().min(1).max(TODO_MAX_STEP), due: z.iso.date().optional() }))
    .max(TODO_MAX_LINES),
});

export interface TodoDraftDeps {
  claude: ClaudeAdapter;
  prompt: Prompt;
  /** The Tasks note the lines go to. */
  path: string;
  now: () => Date;
  signal?: AbortSignal;
  /** A meeting's transcript, read live for this draft (R2.3). */
  transcript?: string;
  /** What Frank added when he asked for the to-do. */
  additionalInfo?: string;
}

export function renderTodoRequest(item: Item, me: Me, steps: TodoStep[], now: Date, transcript?: string, info?: string): string {
  return [
    `Today: ${now.toISOString().slice(0, 10)}`,
    '<thread>',
    JSON.stringify(draftThread(item, me, transcript)),
    '</thread>',
    '<open-steps>',
    steps.length ? steps.map((s) => JSON.stringify({ step: s.step, ...(s.dueAt && { due: londonParts(s.dueAt).dateKey }) })).join('\n') : 'None: triage found no open step for Frank.',
    '</open-steps>',
    ...additionalInfo(info),
    'Write the to-do. Answer with the JSON only.',
  ].join('\n');
}

/** `steps`: Frank's open steps as triage found them; `source`: what each line links back to. */
export async function draftTodo(d: TodoDraftDeps, item: Item, me: Me, steps: TodoStep[], source: { title: string; permalink: string }): Promise<{ draft: TodoDraft }> {
  const t0 = performance.now();
  const r = await d.claude.structured(
    {
      purpose: 'draft_todo',
      model: TODO_MODEL,
      system: d.prompt.text,
      prompt: renderTodoRequest(item, me, steps, d.now(), d.transcript, d.additionalInfo),
      promptVersion: d.prompt.version,
      timeoutMs: DEADLINES.triage,
      signal: d.signal,
      itemIds: [item.id],
    },
    TodoAnswer,
  );
  // Midday UTC is the same day in London, whatever the season: the line shows the date Frank meant.
  const list = r.value.steps.map((s) => ({ step: s.step, ...(s.due && { dueAt: `${s.due}T12:00:00.000Z` }) }));
  const content = todoContent(list, source);
  if (!content.trim()) throw new DraftError('The to-do came back with no steps.');
  return {
    draft: {
      kind: 'todo',
      path: d.path,
      content,
      model: TODO_MODEL,
      promptVersion: d.prompt.version,
      durationMs: Math.round(performance.now() - t0),
      tokens: r.usage.reduce((n, u) => n + u.inputTokens + u.outputTokens + u.cacheTokens, 0),
      edited: false,
      ...(d.additionalInfo && { additionalInfo: d.additionalInfo }),
    },
  };
}
