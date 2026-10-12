import { join } from 'node:path';
import { londonParts, parseTaskLine, taskKey, withTick, type EventDraft, type MirrorFailure, type TodoState } from '@work-os/shared';
import { checkNotePath, readOrNull, sha256, VaultPathError } from '../actions/vaultFiles';
import { writeVaultFile, type VaultTargets } from '../actions/vaultExecutor';
import { unchangedSince } from '../actions/todoExecutor';
import type { Logger } from '../log';
import type { Store } from '../store/store';
import type { TodoTextStore } from '../store/todos';

// Done in Work OS, mirrored to the Tasks note (E15, FR-16.4). Frank's Done is the approval for
// this one write: the To Do's own line, and nothing else in the note, is ticked (`[x]` and a ✅
// date, as the Tasks plugin does) or, on reopen, unticked. As for every vault write the path is
// checked against the vault, the note is re-read just before writing (Obsidian may have saved it
// meanwhile), and in dry-run the sandbox copy stands in for the note. A line already as wanted is
// left alone, so a write cut short by a crash or sleep is finished, never repeated. The Tasks
// note watcher leaves a To Do alone while its mirror is pending, so this write never echoes back.

/** A failed mirror is tried again after this long, in case Frank put the line back meanwhile. */
export const MIRROR_RETRY_MS = 10 * 60_000;

export interface TodoMirrorDeps {
  store: Store;
  todos: TodoTextStore;
  targets: () => VaultTargets;
  /** The Tasks note's path in the vault (Settings › Write targets). */
  path: () => string;
  /** False while asleep or quitting. */
  canWrite: () => boolean;
  now: () => Date;
  logger?: Logger;
}

type Want = NonNullable<TodoState['mirror']>['want'];

export class TodoMirror {
  private running?: Promise<number>;

  constructor(private readonly d: TodoMirrorDeps) {}

  /** To Dos whose line is still to mirror, failed ones only once MIRROR_RETRY_MS has passed. */
  private due(): TodoState[] {
    const at = this.d.now().getTime();
    return Object.values(this.d.store.projection.todos ?? {}).filter((t) => t.mirror && (!t.mirror.failedAt || at - Date.parse(t.mirror.failedAt) >= MIRROR_RETRY_MS));
  }

  /** On every tick, and right after Done. Resolves to the events it logged. */
  pump(): Promise<number> {
    // A Done while a pass runs: another pass after it, for the To Do that pass didn't see.
    if (this.running) return this.running.then(() => this.pump());
    if (!this.d.canWrite() || !this.due().length) return Promise.resolve(0);
    this.running = this.run()
      .catch((err: unknown) => {
        this.d.logger?.warn({ err }, 'Mirroring To Dos to the Tasks note failed; trying again shortly');
        return 0;
      })
      .finally(() => (this.running = undefined));
    return this.running;
  }

  private async run(): Promise<number> {
    const todos = this.due();
    if (!todos.length) return 0;
    const t = this.d.targets();
    const fail = (reason: MirrorFailure) => this.d.store.append(...todos.map((x) => failed(x, reason))).then(() => todos.length);
    let path: string;
    try {
      path = await checkNotePath(t.vaultRoot, this.d.path());
    } catch (e) {
      if (e instanceof VaultPathError) return fail('path_refused');
      throw e;
    }
    const real = join(t.vaultRoot, path);
    const file = t.dryRun ? join(t.sandboxRoot, path) : real;
    const read = async () => (t.dryRun ? ((await readOrNull(file)) ?? (await readOrNull(real))) : await readOrNull(real));
    const before = await read();
    if (before === null) return fail('no_note');

    const lines = before.split('\n');
    const on = londonParts(this.d.now()).dateKey;
    const events: EventDraft[] = [];
    let changed = false;
    for (const todo of todos) {
      const want = todo.mirror!.want;
      const at = this.find(lines, todo);
      if (at === undefined) {
        events.push(failed(todo, 'no_line'));
        continue;
      }
      const line = parseTaskLine(lines[at])!;
      if (line.ticked !== (want === 'ticked')) {
        // A line that keeps its \r keeps it.
        const cr = lines[at].endsWith('\r') ? '\r' : '';
        lines[at] = withTick(lines[at].replace(/\r$/, ''), want === 'ticked' ? on : undefined) + cr;
        changed = true;
      }
      events.push(mirrored(todo, want, t.dryRun));
    }
    if (changed) {
      const content = lines.join('\n');
      // Obsidian saved the note meanwhile: plan again on the next tick, on what is there now.
      if (!this.d.canWrite() || !(await unchangedSince({ file, real, baseHash: sha256(before) }, t.dryRun))) return 0;
      try {
        await writeVaultFile({ file, content, isNew: false });
      } catch (err) {
        this.d.logger?.warn({ err }, 'Writing the Tasks note failed');
        await this.d.store.append(...todos.map((x) => failed(x, 'write_failed')));
        return todos.length;
      }
    }
    if (events.length) await this.d.store.append(...events);
    return events.length;
  }

  /** The To Do's line: by its id, else by its task. */
  private find(lines: string[], todo: TodoState): number | undefined {
    const words = this.d.todos.get(todo.id);
    const key = words && taskKey(words.line);
    let byKey: number | undefined;
    for (let i = 0; i < lines.length; i++) {
      const p = parseTaskLine(lines[i].replace(/\r$/, ''));
      if (!p) continue;
      if (todo.lineId && p.lineId === todo.lineId) return i;
      if (byKey === undefined && key && p.key === key) byKey = i;
    }
    return byKey;
  }
}

const mirrored = (t: TodoState, state: Want, dryRun: boolean): EventDraft => ({ type: 'todo.mirrored', itemId: t.itemId, actionId: t.actionId, data: { todoId: t.id, state, dryRun } });
const failed = (t: TodoState, reason: MirrorFailure): EventDraft => ({ type: 'todo.mirrorFailed', itemId: t.itemId, actionId: t.actionId, data: { todoId: t.id, reason } });
