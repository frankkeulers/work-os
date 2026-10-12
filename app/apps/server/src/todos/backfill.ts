import type { Logger } from '../log';
import type { DraftStore } from '../store/drafts';
import type { Store } from '../store/store';
import type { TodoTextStore } from '../store/todos';
import { todoRecords } from './records';

// To-dos written before Work OS tracked To Dos (E15, FR-16.1): at start, each written to-do with
// no To Dos gets them from its draft, marked backfilled. Their lines have no id, so they are found
// again by their task; the first read of the Tasks note closes those already ticked. Runs every
// start and does nothing once every written to-do has its To Dos. A draft retention removed is
// skipped: its words are gone.

export async function backfillTodos(d: { store: Store; drafts: DraftStore; todos: TodoTextStore; logger?: Logger }): Promise<number> {
  const p = d.store.projection;
  const have = new Set(Object.values(p.todos ?? {}).map((t) => t.actionId));
  let n = 0;
  for (const a of Object.values(p.actions)) {
    if (a.type !== 'todo' || a.status !== 'done' || have.has(a.id)) continue;
    const it = p.items[a.itemId];
    const stored = await d.drafts.read(a.id);
    if (!it || stored?.draft?.kind !== 'todo') continue;
    const made = todoRecords(a, stored.draft, it, (id) => !!p.todos?.[id], true);
    if (!made.events.length) continue;
    await d.todos.put(...made.texts);
    await d.store.append(...made.events);
    n += made.events.length;
  }
  if (n) d.logger?.info({ todos: n }, 'Backfilled To Dos from to-dos written before Work OS tracked them');
  return n;
}
