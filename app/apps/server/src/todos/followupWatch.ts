import type { FollowupKind, TodoState, WorkEvent } from '@work-os/shared';
import type { Logger } from '../log';
import type { FollowupLabelStore } from '../store/followupLabels';
import type { Store } from '../store/store';
import type { TodoTextStore } from '../store/todos';

// Follow-ups missed (E15, FR-16.13): what Frank did himself soon after a To Do was done, that a
// follow-up would have offered, with none offered or used. Each is a `missed` label, once per To
// Do and kind, so the follow-ups' recall can be measured. The signals, on the To Do's item:
// - he pressed Done on it within 30 minutes: mark_source_done;
// - he added a to-do on it within 30 minutes: add_todo;
// - his own message arrived on it within two hours: reply.
// A suggestion of that kind he used (as is or changed) means nothing was missed. The web records
// his answer before doing the follow-up, so using one never reads as missing it.

export const MISSED_WINDOW_MINUTES: Record<Exclude<FollowupKind, 'file_note'>, number> = { mark_source_done: 30, add_todo: 30, reply: 120 };

/** What an event says Frank did on the item, if it is a signal. */
function signalOf(e: WorkEvent): Exclude<FollowupKind, 'file_note'> | undefined {
  if (e.type === 'item.done' && !e.data) return 'mark_source_done';
  if (e.type === 'todo.created') return 'add_todo';
  if (e.type === 'item.upserted' && e.data.fromMeOnly) return 'reply';
  return undefined;
}

export class FollowupWatch {
  constructor(private readonly d: { store: Store; texts: TodoTextStore; labels: FollowupLabelStore; now: () => Date; logger?: Logger }) {}

  /** After each append. Resolves once its labels are written. */
  async see(events: readonly WorkEvent[]): Promise<number> {
    let n = 0;
    for (const e of events) {
      const kind = signalOf(e);
      if (!kind || !e.itemId) continue;
      const at = Date.parse(e.at);
      const todos = Object.values(this.d.store.projection.todos ?? {}).filter(
        (t) => t.itemId === e.itemId && t.status === 'done' && !t.backfilled && t.doneAt && at >= Date.parse(t.doneAt) && at - Date.parse(t.doneAt) <= MISSED_WINDOW_MINUTES[kind] * 60_000 && !(e.type === 'todo.created' && e.data.todoId === t.id),
      );
      for (const t of todos) if (await this.missed(t, kind)) n++;
    }
    return n;
  }

  private async missed(t: TodoState, kind: FollowupKind): Promise<boolean> {
    if (this.d.labels.hasMissed(t.id, kind)) return false;
    const f = t.followups;
    const used = f?.kinds.some((k, i) => k === kind && (f.answers?.[i] === 'accepted' || f.answers?.[i] === 'edited'));
    if (used) return false;
    const words = this.d.texts.get(t.id);
    if (!words) return false;
    await this.d.labels
      .append({
        schemaVersion: 1,
        at: this.d.now().toISOString(),
        origin: 'missed',
        todoId: t.id,
        itemId: t.itemId,
        source: words.source.source,
        input: words.followups?.input ?? { step: words.step, source: words.source.source, title: words.source.title },
        kind,
        ...(f && { suggested: f.kinds }),
        ...(words.followups && { model: words.followups.model, promptVersion: words.followups.promptVersion }),
      })
      .catch((err: unknown) => this.d.logger?.warn({ err }, 'Writing a missed follow-up label failed'));
    return true;
  }
}
