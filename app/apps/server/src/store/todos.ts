import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { SourceId } from '@work-os/shared';
import { z } from 'zod';
import { writeJsonAtomic } from './atomic';
import { fileNameFor } from './items';

// todos/<todoId>.json (E15, FR-16.1): a To Do's words, which the event log never holds. The step
// paraphrases a thread, as a draft does, so retention removes it once the To Do has been done for
// longer than retentionDays. The files are few and small, so all of them are read at start and
// kept in memory: the inbox shows every open To Do on every load.

export const TodoText = z.object({
  schemaVersion: z.literal(1),
  todoId: z.string().min(1),
  itemId: z.string().min(1),
  actionId: z.string().min(1),
  /** The task's own words. */
  step: z.string().min(1),
  /** The line as written to the Tasks note, id and all: how a line without an id is found again. */
  line: z.string().min(1),
  source: z.object({ source: SourceId, title: z.string().min(1), permalink: z.string() }),
  /**
   * FR-16.6: its plan's words, and the To Do as the schedule prompt saw it, so a label for the
   * plan carries its input after the item's content has gone to retention.
   */
  plan: z
    .object({
      at: z.iso.datetime(),
      model: z.string(),
      promptVersion: z.string(),
      input: z.record(z.string(), z.unknown()),
      estimateWhy: z.string(),
      deadlineWhy: z.string().optional(),
    })
    .optional(),
});
export type TodoText = z.infer<typeof TodoText>;

export class TodoTextStore {
  private readonly texts = new Map<string, TodoText>();

  private constructor(private readonly dir: string) {}

  static async open(dir: string): Promise<TodoTextStore> {
    const s = new TodoTextStore(dir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    for (const f of await readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      const r = await readFile(join(dir, f), 'utf8')
        .then((t) => TodoText.safeParse(JSON.parse(t)))
        .catch(() => undefined);
      if (r?.success) s.texts.set(r.data.todoId, r.data);
    }
    return s;
  }

  private file(id: string) {
    return join(this.dir, fileNameFor(id));
  }

  get(id: string): TodoText | undefined {
    return this.texts.get(id);
  }

  /** Writes the To Dos' words, each atomically. Before their events, so a To Do never lacks them. */
  async put(...texts: TodoText[]): Promise<void> {
    for (const t of texts) {
      const parsed = TodoText.parse(t);
      await writeJsonAtomic(this.file(parsed.todoId), parsed);
      this.texts.set(parsed.todoId, parsed);
    }
  }

  /** Retention. True if there was a file. */
  async remove(id: string): Promise<boolean> {
    this.texts.delete(id);
    return rm(this.file(id)).then(
      () => true,
      () => false,
    );
  }
}
