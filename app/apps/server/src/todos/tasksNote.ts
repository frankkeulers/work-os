import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTaskLine, taskKey, type EventDraft, type TaskLine } from '@work-os/shared';
import { checkNotePath, readOrNull } from '../actions/vaultFiles';
import type { VaultTargets } from '../actions/vaultExecutor';
import type { Logger } from '../log';
import type { Store } from '../store/store';
import type { TodoTextStore } from '../store/todos';

// The Tasks note read back (E15, FR-16.3). Read only: a line ticked in Obsidian closes its To Do,
// and a line unticked there reopens it, however it was closed. A To Do whose Done or reopen in Work
// OS is still to be mirrored to its line (FR-16.4) is left alone until it is. Lines are found by
// their id, else by their task (lines written before To Dos had ids). A To Do whose line isn't in
// the note is shown as such and otherwise left alone: Frank may have moved it to another note. In
// dry-run the sandbox copy, when there is one, stands in for the note, as for writes.

/** How often the note is looked at: its modified time first, the text only when that changed. */
export const TASKS_NOTE_EVERY_MS = 30_000;

export interface TasksNoteDeps {
  store: Store;
  todos: TodoTextStore;
  targets: () => VaultTargets;
  /** The Tasks note's path in the vault (Settings › Write targets). */
  path: () => string;
  now: () => Date;
  logger?: Logger;
}

export class TasksNoteWatcher {
  private lastAt = 0;
  private lastStamp?: string;
  private readOnce = false;
  private readonly missingIds = new Set<string>();
  private running?: Promise<number>;

  constructor(private readonly d: TasksNoteDeps) {}

  /** Whether the To Do's line is in the note: unknown until the note has been read. */
  inNote(todoId: string): boolean | undefined {
    return this.readOnce ? !this.missingIds.has(todoId) : undefined;
  }

  /** On every tick; `force` on wake and in tests. Resolves to the events it logged. */
  check(force = false): Promise<number> {
    if (this.running) return this.running;
    const at = this.d.now().getTime();
    if (!force && at - this.lastAt < TASKS_NOTE_EVERY_MS) return Promise.resolve(0);
    this.lastAt = at;
    this.running = this.run(force)
      .catch((err: unknown) => {
        this.d.logger?.warn({ err }, 'Reading the Tasks note failed; trying again shortly');
        return 0;
      })
      .finally(() => (this.running = undefined));
    return this.running;
  }

  private async run(force: boolean): Promise<number> {
    const todos = Object.values(this.d.store.projection.todos ?? {});
    if (!todos.length) return 0;
    const t = this.d.targets();
    let path: string;
    try {
      path = await checkNotePath(t.vaultRoot, this.d.path());
    } catch {
      return 0; // the setting is refused for writes too, which say so
    }
    const sandbox = join(t.sandboxRoot, path);
    const real = join(t.vaultRoot, path);
    const look = async () => {
      const file = t.dryRun && (await stat(sandbox).catch(() => undefined)) ? sandbox : real;
      const st = await stat(file).catch(() => undefined);
      return { file, st, at: `${file}|${st?.mtimeMs ?? 'none'}|${st?.size ?? 0}` };
    };
    const { file, st, at: seen } = await look();
    // Unchanged note and the same To Dos: nothing new to see.
    const stamp = `${seen}|${todos.length}|${todos.filter((x) => x.status === 'open').length}`;
    if (!force && stamp === this.lastStamp) return 0;
    this.lastStamp = stamp;
    const text = st ? await readOrNull(file) : null;
    // Written meanwhile (by the mirror, say, after a Done): what was read may be stale against
    // the To Dos now, so look again on the next tick.
    if ((await look()).at !== seen) {
      this.lastStamp = undefined;
      return 0;
    }
    // From here to the append, nothing waits: the note as read and the To Dos as they are now.
    const byId = new Map<string, TaskLine>();
    const byKey = new Map<string, TaskLine>();
    for (const l of (text ?? '').split(/\r?\n/)) {
      const p = parseTaskLine(l);
      if (!p) continue;
      if (p.lineId) byId.set(p.lineId, p);
      if (!byKey.has(p.key)) byKey.set(p.key, p);
    }
    const events: EventDraft[] = [];
    this.missingIds.clear();
    for (const todo of todos) {
      const words = this.d.todos.get(todo.id);
      if (!words) continue;
      const line = (todo.lineId && byId.get(todo.lineId)) || byKey.get(taskKey(words.line));
      if (!line) {
        this.missingIds.add(todo.id);
        continue;
      }
      // Done or reopened in Work OS and not yet mirrored: the line is still as it was (FR-16.4).
      if (todo.mirror) continue;
      if (line.ticked && todo.status === 'open') events.push({ type: 'todo.done', itemId: todo.itemId, actionId: todo.actionId, data: { todoId: todo.id, by: 'tasks_note', ...(line.doneOn && { on: line.doneOn }) } });
      if (!line.ticked && todo.status === 'done') events.push({ type: 'todo.reopened', itemId: todo.itemId, actionId: todo.actionId, data: { todoId: todo.id, by: 'tasks_note' } });
    }
    this.readOnce = true;
    if (events.length) await this.d.store.append(...events);
    return events.length;
  }
}
