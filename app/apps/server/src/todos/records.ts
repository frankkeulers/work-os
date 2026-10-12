import { newTodos, type EventDraft, type ItemMeta, type TodoDraft } from '@work-os/shared';
import type { TodoText } from '../store/todos';

// The To Dos a written to-do makes (E15, FR-16.1): one per line, with its words for todos/ and its
// todo.created event. Ids come from the action and the line, so building them again for the same
// action gives the same To Dos, and `known` ones are left out.

export interface TodoRecords {
  texts: TodoText[];
  events: EventDraft[];
}

/**
 * `backfilled`: a to-do written before To Dos had ids. Its lines went into the note without one,
 * so the To Do keeps none and is found again by its task.
 */
export function todoRecords(a: { id: string; itemId: string }, d: TodoDraft, item: Pick<ItemMeta, 'source' | 'title' | 'permalink'>, known: (todoId: string) => boolean, backfilled = false): TodoRecords {
  const made = newTodos(a.id, d, known, backfilled);
  return {
    texts: made.map((t) => ({ schemaVersion: 1, todoId: t.todoId, itemId: a.itemId, actionId: a.id, step: t.step, line: t.line, source: { source: item.source, title: item.title, permalink: item.permalink } })),
    events: made.map((t) => ({
      type: 'todo.created',
      itemId: a.itemId,
      actionId: a.id,
      data: { todoId: t.todoId, ...(t.lineId && { lineId: t.lineId }), ...(t.deadline && { deadline: t.deadline }), deadlineFrom: t.deadlineFrom, ...(backfilled && { backfilled: true as const }) },
    })),
  };
}
