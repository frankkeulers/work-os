import { slotMinutes, type EventDraft, type FollowupAnswerBody, type TodoEdit, type TodoState } from '@work-os/shared';
import type { Logger } from '../log';
import type { FollowupLabelStore } from '../store/followupLabels';
import type { ScheduleLabelRecord, ScheduleLabelStore } from '../store/scheduleLabels';
import type { Store } from '../store/store';
import type { TodoTextStore } from '../store/todos';
import type { TodoMirror } from './mirror';
import type { TodoPlanner } from './planner';

// Done from the inbox (E15, FR-16.4–16.5), and Frank's own estimate, deadline (FR-16.7) and time
// (FR-16.9). Done closes the To Do and is the approval for ticking its line in the Tasks note, which the mirror
// does at once; reopen (Undo) unticks it. How long it took, picked on Done, and each edit are
// labels for the plan. Labels are written before the event, and a label is never worth failing
// the click.

export interface TodoServiceDeps {
  store: Store;
  texts: TodoTextStore;
  mirror: TodoMirror;
  labels?: ScheduleLabelStore;
  followupLabels?: FollowupLabelStore;
  /** Places the other To Dos again once Frank changes one. */
  planner?: TodoPlanner;
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
  ...(t.slot && { slot: t.slot }),
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

export class FollowupNotFoundError extends Error {
  constructor() {
    super('That follow-up isn’t there. It may not have been suggested yet.');
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
   * Frank's own estimate, deadline (FR-16.7) or time (FR-16.9): the plan never overrides them. A
   * time of his own that a new estimate changes the length of keeps its start. Each change is a
   * label, with the plan it replaced; null for the time hands it back to the plan.
   */
  async edit(id: string, e: TodoEdit): Promise<void> {
    const t = this.get(id);
    const effort = e.effortMinutes !== undefined && e.effortMinutes !== t.effortMinutes ? e.effortMinutes : undefined;
    const deadline = e.deadline !== undefined && (e.deadline ?? undefined) !== t.deadline ? e.deadline : undefined;
    const mine = t.slot?.by === 'you' ? t.slot : undefined;
    let slot = e.slot === null ? (mine ? null : undefined) : e.slot && (e.slot.start !== mine?.start || e.slot.end !== mine.end) ? e.slot : undefined;
    if (slot === undefined && effort !== undefined && mine && e.slot === undefined) {
      const end = new Date(Date.parse(mine.start) + slotMinutes(effort) * 60_000).toISOString();
      if (end !== mine.end) slot = { start: mine.start, end };
    }
    if (effort === undefined && deadline === undefined && slot === undefined) return;
    if (effort !== undefined) await this.label(t, 'estimate_edit', { set: { effortMinutes: effort } });
    if (deadline !== undefined) await this.label(t, 'deadline_edit', { set: { deadline } });
    if (slot !== undefined && e.slot !== undefined) await this.label(t, 'slot_moved', { set: { slot } });
    const ids = { itemId: t.itemId, actionId: t.actionId };
    const events: EventDraft[] = [];
    if (effort !== undefined || deadline !== undefined) events.push({ type: 'todo.edited', ...ids, data: { todoId: id, ...(effort !== undefined && { effortMinutes: effort }), ...(deadline !== undefined && { deadline }) } });
    if (slot === null) events.push({ type: 'todo.unscheduled', ...ids, data: { todoId: id, by: 'you' } });
    else if (slot) events.push({ type: 'todo.scheduled', ...ids, data: { todoId: id, ...slot, by: 'you' } });
    await this.d.store.append(...events);
    // The rest move around it at once, not at the next tick.
    await this.d.planner?.plan();
  }

  /**
   * Frank's answer to one follow-up (FR-16.12): used as suggested, used after changing it (`text`,
   * his words), or dismissed. Once each. The web does the follow-up itself, after this, so the
   * missed-follow-up watch sees it answered first.
   */
  async answerFollowup(id: string, index: number, body: FollowupAnswerBody): Promise<void> {
    const t = this.get(id);
    const words = this.d.texts.get(id);
    const suggestion = words?.followups?.suggestions[index];
    if (!t.followups || index >= t.followups.kinds.length || !suggestion) throw new FollowupNotFoundError();
    if (t.followups.answers?.[index]) return;
    await this.d.followupLabels
      ?.append({
        schemaVersion: 1,
        at: this.d.now().toISOString(),
        origin: 'answered',
        todoId: id,
        itemId: t.itemId,
        source: words.source.source,
        input: words.followups!.input,
        kind: suggestion.kind,
        index,
        suggestion: { ...suggestion },
        answer: body.answer,
        ...(body.answer === 'edited' && body.text && { text: body.text }),
        suggested: t.followups.kinds,
        model: words.followups!.model,
        promptVersion: words.followups!.promptVersion,
      })
      .catch((err: unknown) => this.d.logger?.warn({ err }, 'Writing a follow-up label failed'));
    await this.d.store.append({ type: 'todo.followupAnswered', itemId: t.itemId, actionId: t.actionId, data: { todoId: id, index, answer: body.answer } });
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
