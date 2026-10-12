import { readFile } from 'node:fs/promises';
import { SourceId } from '@work-os/shared';
import { z } from 'zod';
import { JsonlAppender } from './jsonl';

// labels/schedule.jsonl: what a To Do's plan got wrong (E15, FR-16.5). Frank's answers on Done (how
// long it took) and, from FR-16.6 on, edits to its estimate, deadline and slot. Each line
// carries the To Do as the schedule prompt would see it and the plan it had, so the eval can re-run
// it after the item's raw content has gone to retention. Written before the event, so a crash
// between the two loses an event, never a label.

export const ScheduleLabelRecord = z.object({
  schemaVersion: z.literal(1),
  at: z.iso.datetime(),
  // done: Frank pressed Done (when, against its deadline); actual: how long it took; the rest are
  // edits to the plan.
  origin: z.enum(['done', 'actual', 'estimate_edit', 'deadline_edit', 'slot_moved']),
  todoId: z.string().min(1),
  itemId: z.string().min(1),
  source: SourceId,
  /** The To Do as the schedule prompt sees it. */
  input: z.record(z.string(), z.unknown()),
  /** What the plan was when Frank answered, when there was one. */
  was: z.record(z.string(), z.unknown()).optional(),
  /** `actual`: the minutes Frank chose; null when the answer was taken back. */
  actualMinutes: z.number().int().positive().nullable().optional(),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
});
export type ScheduleLabelRecord = z.infer<typeof ScheduleLabelRecord>;

/** Every readable line, oldest first. A torn last line from a crash is skipped. */
export async function readScheduleLabels(file: string): Promise<ScheduleLabelRecord[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  const out: ScheduleLabelRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = ScheduleLabelRecord.safeParse(JSON.parse(line));
      if (r.success) out.push(r.data);
    } catch {
      // skipped
    }
  }
  return out;
}

export class ScheduleLabelStore {
  private todos = new Set<string>();
  private appender = new JsonlAppender();

  private constructor(readonly file: string) {}

  static async open(file: string): Promise<ScheduleLabelStore> {
    const s = new ScheduleLabelStore(file);
    for (const r of await readScheduleLabels(file)) s.todos.add(r.todoId);
    return s;
  }

  /** Labelled To Dos (distinct). */
  get count() {
    return this.todos.size;
  }

  /** Resolves once the line is on disk. */
  async append(r: ScheduleLabelRecord) {
    await this.appender.append(this.file, [JSON.stringify(ScheduleLabelRecord.parse(r))]);
    this.todos.add(r.todoId);
  }

  all() {
    return readScheduleLabels(this.file);
  }

  close() {
    return this.appender.close();
  }
}
