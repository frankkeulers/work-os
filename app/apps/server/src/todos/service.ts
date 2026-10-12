import type { TodoState } from '@work-os/shared';
import type { Logger } from '../log';
import type { ScheduleLabelRecord, ScheduleLabelStore } from '../store/scheduleLabels';
import type { Store } from '../store/store';
import type { TodoTextStore } from '../store/todos';
import type { TodoMirror } from './mirror';

// Done from the inbox (E15, FR-16.4–16.5). Frank's Done closes the To Do and is the approval for
// ticking its line in the Tasks note, which the mirror does at once; reopen (Undo) unticks it. How
// long it took, picked on Done, is a label for the plan's estimate. Labels are written before the
// event, and a label is never worth failing the click.

export interface TodoServiceDeps {
  store: Store;
  texts: TodoTextStore;
  mirror: TodoMirror;
  labels?: ScheduleLabelStore;
  now: () => Date;
  logger?: Logger;
}

export class TodoNotFoundError extends Error {
  constructor() {
    super('To Do not found. It may have been removed by retention.');
  }
}

export class TodoNotDoneError extends Error {
  constructor() {
    super('Only a To Do that is done has a time taken.');
  }
}

export class TodoService {
  /** To Dos a Done or reopen is on its way for: a double click is one event. */
  private readonly changing = new Set<string>();

  constructor(private readonly d: TodoServiceDeps) {}

  private get(id: string): TodoState {
    const t = this.d.store.projection.todos?.[id];
    if (!t) throw new TodoNotFoundError();
    return t;
  }

  async markDone(id: string): Promise<void> {
    const t = this.get(id);
    if (t.status === 'done' || this.changing.has(id)) return;
    await this.once(id, async () => {
      await this.label(t, 'done');
      await this.d.store.append({ type: 'todo.done', itemId: t.itemId, actionId: t.actionId, data: { todoId: id, by: 'you' } });
    });
  }

  async reopen(id: string): Promise<void> {
    const t = this.get(id);
    if (t.status === 'open' || this.changing.has(id)) return;
    await this.once(id, () => this.d.store.append({ type: 'todo.reopened', itemId: t.itemId, actionId: t.actionId, data: { todoId: id, by: 'you' } }));
  }

  /** How long it took, in minutes; null takes the answer back. */
  async setActual(id: string, minutes: number | null): Promise<void> {
    const t = this.get(id);
    if (t.status !== 'done') throw new TodoNotDoneError();
    if ((t.actualMinutes ?? null) === minutes) return;
    await this.label(t, 'actual', { actualMinutes: minutes });
    await this.d.store.append({ type: 'todo.timed', itemId: t.itemId, actionId: t.actionId, data: { todoId: id, minutes } });
  }

  private async once(id: string, write: () => Promise<unknown>) {
    this.changing.add(id);
    try {
      await write();
    } finally {
      this.changing.delete(id);
    }
    // The tick is local and quick: the answer can say whether it's in the note.
    await this.d.mirror.pump();
  }

  private async label(t: TodoState, origin: ScheduleLabelRecord['origin'], extra: Partial<ScheduleLabelRecord> = {}) {
    if (!this.d.labels) return;
    const words = this.d.texts.get(t.id);
    if (!words) return;
    await this.d.labels
      .append({
        schemaVersion: 1,
        at: this.d.now().toISOString(),
        origin,
        todoId: t.id,
        itemId: t.itemId,
        source: words.source.source,
        input: { step: words.step, sourceTitle: words.source.title, createdAt: t.createdAt, ...(t.deadline && { deadline: t.deadline }), deadlineFrom: t.deadlineFrom },
        ...extra,
      })
      .catch((err: unknown) => this.d.logger?.warn({ err }, 'Writing a schedule label failed'));
  }
}
