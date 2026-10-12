import { FOLLOWUP_MAX_PER_CALL, FollowupAnswer, clampFollowups, followupWanted, type EventDraft, type Me, type Projection, type Settings, type SourceId, type TodoState } from '@work-os/shared';
import type { ClaudeAdapter } from '../claude/adapter';
import { ClaudeOutputError } from '../claude/errors';
import type { Prompt } from '../claude/prompts';
import type { Logger } from '../log';
import { DEADLINES } from '../net/http';
import type { ItemFiles } from '../store/items';
import type { Store } from '../store/store';
import type { TodoText, TodoTextStore } from '../store/todos';

// Follow-ups on Done (E15, FR-16.11): a short model call, no tools, suggests what comes next once
// a To Do is done, in Work OS or in Obsidian: a reply for Frank to send, closing the item, a next
// To Do, a note to file. It runs after triage, with the plans, and counts towards triage's
// budget. Code clamps the answer (clampFollowups). The suggestions and the input go to todos/
// first, then `todo.followups` logs their kinds. Work OS never sends the reply (NF-4): Frank copies
// it and sends it himself.

/** The conversation's end, as sent. */
export const FOLLOWUP_EXCERPT_MAX = 3000;

export interface FollowupDeps {
  store: Store;
  items: ItemFiles;
  texts: TodoTextStore;
  claude: ClaudeAdapter;
  now: () => Date;
  logger?: Logger;
  config: () => { settings: Settings };
  prompt: () => Promise<Prompt>;
  /** Today's triage calls or cost-equivalent are at their budget (CL-6). Follow-ups count towards it. */
  budgetHit: () => boolean;
  me?: (source?: SourceId) => Me;
}

export interface FollowupRun {
  calls: number;
  suggested: number;
  failed: number;
  paused: number;
}

/** One done To Do as the model sees it. */
export interface FollowupInput {
  id: string;
  step: string;
  took?: number;
  source: SourceId;
  kind?: string;
  title: string;
  canReply: boolean;
  summary?: string;
  asks?: string[];
  excerpt?: string;
  itemOpen: boolean;
  otherTodos: string[];
}

/** Done To Dos waiting for follow-ups, oldest first. */
export const followupQueue = (p: Projection, now: Date): TodoState[] =>
  Object.values(p.todos ?? {})
    .filter((t) => followupWanted(t, now))
    .sort((a, b) => (a.doneAt ?? '').localeCompare(b.doneAt ?? ''));

/** What the clamp and the prompt know of the To Do's item. */
function contextOf(p: Projection, t: TodoState) {
  const item = p.items[t.itemId];
  const others = Object.values(p.todos ?? {}).filter((o) => o.itemId === t.itemId && o.id !== t.id && o.status === 'open');
  return { itemOpen: !!item && item.status !== 'done', others };
}

/** A done To Do as sent, from its words and its item's file while there is one. */
export async function followupInputOf(d: Pick<FollowupDeps, 'items' | 'texts' | 'me' | 'store'>, t: TodoState, words: TodoText): Promise<FollowupInput> {
  const stored = await d.items.read(words.source.source, t.itemId).catch(() => undefined);
  const { itemOpen, others } = contextOf(d.store.projection, t);
  const me = d.me?.(words.source.source).id;
  const names = new Map(stored?.item.participants.map((p) => [p.id, p.name || p.id]));
  const tail = stored?.item.messages.map((m) => `${m.authorId === me ? 'me' : (names.get(m.authorId) ?? m.authorId)}: ${m.text}`).join('\n\n') ?? '';
  const asks = stored?.text?.next?.asks?.map((a) => a.step);
  return {
    id: t.id,
    step: words.step,
    ...(t.actualMinutes && { took: t.actualMinutes }),
    source: words.source.source,
    ...(stored && { kind: stored.item.kind }),
    title: words.source.title,
    canReply: !!words.source.permalink && ['slack', 'outlook', 'teams'].includes(words.source.source),
    ...(stored?.text?.summary && { summary: stored.text.summary }),
    ...(asks?.length && { asks }),
    ...(tail && { excerpt: tail.length > FOLLOWUP_EXCERPT_MAX ? `…${tail.slice(-FOLLOWUP_EXCERPT_MAX)}` : tail }),
    itemOpen,
    otherTodos: others.flatMap((o) => d.texts.get(o.id)?.step ?? []),
  };
}

/** The user message: the time, then the To Dos just done. */
export function renderFollowup(todos: FollowupInput[], now: Date): string {
  return [`Now: ${now.toISOString()}`, `Suggest follow-ups for ${todos.length === 1 ? 'this To Do' : `these ${todos.length} To Dos`}, just done. Answer with the JSON only.`, '<done>', JSON.stringify(todos), '</done>'].join('\n');
}

/** Asks for every done To Do waiting for follow-ups. Throws ClaudeError (for health) or the abort reason. */
export async function runFollowups(d: FollowupDeps, signal: AbortSignal): Promise<FollowupRun> {
  const settings = d.config().settings;
  const run: FollowupRun = { calls: 0, suggested: 0, failed: 0, paused: 0 };
  const queue = followupQueue(d.store.projection, d.now()).filter((t) => d.texts.get(t.id));
  if (!queue.length) return run;
  if (d.budgetHit()) return { ...run, paused: queue.length };

  const failed = (t: TodoState, reason: 'output' | 'claude'): EventDraft => ({ type: 'todo.followupsFailed', itemId: t.itemId, actionId: t.actionId, data: { todoId: t.id, attempts: (t.followupFailures ?? 0) + 1, reason } });
  const prompt = await d.prompt();
  for (let n = 0; n * FOLLOWUP_MAX_PER_CALL < queue.length; n++) {
    const batch = queue.slice(n * FOLLOWUP_MAX_PER_CALL, (n + 1) * FOLLOWUP_MAX_PER_CALL);
    if (n > 0 && d.budgetHit()) {
      run.paused += queue.length - n * FOLLOWUP_MAX_PER_CALL;
      break;
    }
    const now = d.now();
    const inputs = await Promise.all(batch.map((t) => followupInputOf(d, t, d.texts.get(t.id)!)));
    let answer: FollowupAnswer;
    try {
      const r = await d.claude.structured(
        {
          purpose: 'followup',
          model: settings.models.triage,
          system: prompt.text,
          prompt: renderFollowup(inputs, now),
          promptVersion: prompt.version,
          timeoutMs: DEADLINES.triage,
          signal,
          itemIds: [...new Set(batch.map((t) => t.itemId))],
        },
        FollowupAnswer,
      );
      run.calls += r.usage.length;
      answer = r.value;
    } catch (err) {
      if (signal.aborted) throw err;
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
      // Against the item as it is now: Frank may have closed it meanwhile.
      const { itemOpen, others } = contextOf(d.store.projection, t);
      const suggestions = clampFollowups(a.suggestions, { now, source: words.source.source, permalink: !!words.source.permalink, itemOpen, otherOpenTodos: others.length, vault: !!settings.vaultPath });
      await d.texts.put({ ...words, followups: { at: now.toISOString(), model: settings.models.triage, promptVersion: prompt.version, input: { ...inputs[i] }, suggestions } });
      out.push({ type: 'todo.followups', itemId: t.itemId, actionId: t.actionId, data: { todoId: t.id, kinds: suggestions.map((s) => s.kind) } });
      run.suggested += suggestions.length;
    }
    if (out.length) await d.store.append(...out);
  }
  d.logger?.info({ ...run }, 'To Do follow-ups');
  return run;
}
