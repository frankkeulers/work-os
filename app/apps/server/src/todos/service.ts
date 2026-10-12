import type { TodoEdit, TodoState } from '@work-os/shared';
import type { Logger } from '../log';
import type { ScheduleLabelRecord, ScheduleLabelStore } from '../store/scheduleLabels';
import type { Store } from '../store/store';
import type { TodoTextStore } from '../store/todos';
import type { TodoMirror } from './mirror';

// Done from the inbox (E15, FR-16.4–16.5), and Frank's own estimate and deadline (FR-16.7). Done
// closes the To Do and is the approval for ticking its line in the Tasks note, which the mirror
// does at once; reopen (Undo) unticks it. How long it took, picked on Done, and each edit are
// labels for the plan. Labels are written before the event, and a label is never worth failing
// the click.

export interface TodoServiceDeps {
  store: Store;
  texts: TodoTextStore;
  mirror: TodoMirror;
  labels?: ScheduleLabelStore;
  now: () => Date;
  logger?: Logger;
}

/** The To Do's plan and dates when Frank answered: what a label says was there. */
const wasOf = (t: TodoState) => ({
  createdAt: t.createdAt,
  ...(t.deadline && { deadline: t.deadline }),
  deadlineFrom: t.deadlineFrom,
  ...(t.effortMinutes && { effortMinutes: t.effortMinutes, effortBy: t.effortBy }),
  ...(t.confidence && { confidence: t.confidence }),
  ...(t.ideal && { ideal: t.ideal }),
});

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

  /**
   * Frank's own estimate or deadline (FR-16.7): the plan never overrides it. Each change is a
   * label, with the plan it replaced.
   */
  async edit(id: string, e: TodoEdit): Promise<void> {
    const t = this.get(id);
    const effort = e.effortMinutes !== undefined && e.effortMinutes !== t.effortMinutes ? e.effortMinutes : undefined;
    const deadline = e.deadline !== undefined && (e.deadline ?? undefined) !== t.deadline ? e.deadline : undefined;
    if (effort === undefined && deadline === undefined) return;
    if (effort !== undefined) await this.label(t, 'estimate_edit', { set: { effortMinutes: effort } });
    if (deadline !== undefined) await this.label(t, 'deadline_edit', { set: { deadline } });
    await this.d.store.append({ type: 'todo.edited', itemId: t.itemId, actionId: t.actionId, data: { todoId: id, ...(effort !== undefined && { effortMinutes: effort }), ...(deadline !== undefined && { deadline }) } });
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
        // As the schedule prompt saw it when it planned; else what it would have seen.
        input: words.plan?.input ?? { step: words.step, source: words.source.source, title: words.source.title, ...(t.deadline && { deadline: t.deadline }) },
        was: wasOf(t),
        ...(words.plan && { model: words.plan.model, promptVersion: words.plan.promptVersion }),
        ...extra,
      })
      .catch((err: unknown) => this.d.logger?.warn({ err }, 'Writing a schedule label failed'));
  }
}
