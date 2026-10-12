import { z } from 'zod';
import type { SourceId } from './schemas';
import { cleanStep } from './todo';

// Follow-ups on Done (E15, FR-16.11): once a To Do is done, a short model call suggests what
// usually comes next: tell whoever asked, close the item it came from, a To Do it leads to, or a
// note to file. Code holds the answer to what may be suggested, and Frank does each one himself:
// Work OS never sends a message (NF-4). Shared by the server, the mock and the eval.

/** At most this many To Dos in one call, and suggestions for each. */
export const FOLLOWUP_MAX_PER_CALL = 10;
export const FOLLOWUP_MAX = 3;
/** A To Do whose follow-ups failed this often is left without them. */
export const FOLLOWUP_MAX_ATTEMPTS = 2;
/** Follow-ups are asked for To Dos done within this long; older ones are left alone. */
export const FOLLOWUP_WINDOW_HOURS = 24;
export const REPLY_MAX = 1200;
const WHY_MAX = 160;

export const FollowupKind = z.enum(['reply', 'mark_source_done', 'add_todo', 'file_note']);
export type FollowupKind = z.infer<typeof FollowupKind>;

export const FollowupAnswered = z.enum(['accepted', 'edited', 'dismissed']);
export type FollowupAnswered = z.infer<typeof FollowupAnswered>;

export const FollowupSuggestionAnswer = z.object({
  kind: FollowupKind,
  why: z.string().max(400),
  /** reply: the message for Frank to send, in his voice. */
  reply: z.object({ text: z.string().min(1).max(4000) }).optional(),
  /** add_todo: the next step. */
  todo: z.object({ step: z.string().min(1).max(1000), dueAt: z.iso.datetime({ offset: true }).optional() }).optional(),
});
export type FollowupSuggestionAnswer = z.infer<typeof FollowupSuggestionAnswer>;

export const FollowupTodoAnswer = z.object({ id: z.string().min(1), suggestions: z.array(FollowupSuggestionAnswer).max(6) });
export type FollowupTodoAnswer = z.infer<typeof FollowupTodoAnswer>;
export const FollowupAnswer = z.object({ todos: z.array(FollowupTodoAnswer).max(FOLLOWUP_MAX_PER_CALL) });
export type FollowupAnswer = z.infer<typeof FollowupAnswer>;

/** A suggestion as kept and shown, after the clamp. */
export interface Followup {
  kind: FollowupKind;
  why: string;
  reply?: { text: string };
  todo?: { step: string; dueAt?: string };
}

/** What the clamp needs to know about the To Do's item. */
export interface FollowupContext {
  now: Date;
  source: SourceId;
  /** The item has a link to open its conversation. */
  permalink: boolean;
  /** The item is still open. */
  itemOpen: boolean;
  /** Other To Dos on the item still open. */
  otherOpenTodos: number;
  /** Filing to the vault is set up. */
  vault: boolean;
}

/** Sources a reply can go back to: a conversation Frank can open and answer himself. */
const REPLY_SOURCES: ReadonlySet<SourceId> = new Set<SourceId>(['slack', 'outlook', 'teams']);

const cut = (s: string, max: number) => {
  const t = s.trim().replace(/[ \t]+/g, ' ');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * The model's suggestions for one To Do, held to what may be suggested: a reply only where Frank
 * can open the conversation; closing the item only while it is open with nothing else to do on
 * it; a To Do only as a clean step, its date in the future; a note only when vault filing is set
 * up. One of each kind, at most FOLLOWUP_MAX, in the model's order.
 */
export function clampFollowups(suggestions: readonly FollowupSuggestionAnswer[], c: FollowupContext): Followup[] {
  const out: Followup[] = [];
  const seen = new Set<FollowupKind>();
  for (const s of suggestions) {
    if (out.length >= FOLLOWUP_MAX || seen.has(s.kind)) continue;
    const why = cut(s.why.replace(/\n/g, ' '), WHY_MAX);
    if (s.kind === 'reply') {
      const text = s.reply?.text.trim();
      if (!text || !REPLY_SOURCES.has(c.source) || !c.permalink) continue;
      out.push({ kind: 'reply', why, reply: { text: cut(text, REPLY_MAX) } });
    } else if (s.kind === 'mark_source_done') {
      if (!c.itemOpen || c.otherOpenTodos > 0) continue;
      out.push({ kind: 'mark_source_done', why });
    } else if (s.kind === 'add_todo') {
      const step = s.todo ? cleanStep(s.todo.step) : '';
      if (!step) continue;
      const due = s.todo?.dueAt ? Date.parse(s.todo.dueAt) : NaN;
      out.push({ kind: 'add_todo', why, todo: { step, ...(Number.isFinite(due) && due > c.now.getTime() && { dueAt: new Date(due).toISOString() }) } });
    } else {
      if (!c.vault) continue;
      out.push({ kind: 'file_note', why });
    }
    seen.add(s.kind);
  }
  return out;
}

/** A follow-up's label on its button. */
export const FOLLOWUP_LABEL: Record<FollowupKind, string> = {
  reply: 'Copy reply & open',
  mark_source_done: 'Mark the item done',
  add_todo: 'Add this To Do',
  file_note: 'File a vault note',
};
