import { readFile } from 'node:fs/promises';
import { FollowupAnswered, FollowupKind, SourceId } from '@work-os/shared';
import { z } from 'zod';
import { JsonlAppender } from './jsonl';

// labels/followup.jsonl: what the follow-ups on Done got right and missed (E15, FR-16.12–16.13).
// `answered`: Frank used a suggestion (accepted), changed it first (edited, with his final words)
// or dismissed it. `missed`: he did something a suggestion would have offered, with none offered or
// used: closed the item within 30 minutes, added a to-do on it within 30 minutes, or replied on it
// himself within two hours. Each line carries the input the prompt saw, so the eval can re-run it
// after the item's content has gone to retention. Written before the event.

export const FollowupLabelRecord = z.object({
  schemaVersion: z.literal(1),
  at: z.iso.datetime(),
  origin: z.enum(['answered', 'missed']),
  todoId: z.string().min(1),
  itemId: z.string().min(1),
  source: SourceId,
  /** The To Do as the followup prompt saw it. */
  input: z.record(z.string(), z.unknown()),
  /** The kind Frank answered, or the kind that was missed. */
  kind: FollowupKind,
  /** answered: the suggestion, its place, and Frank's answer. */
  index: z.number().int().min(0).optional(),
  suggestion: z.record(z.string(), z.unknown()).optional(),
  answer: FollowupAnswered.optional(),
  /** edited: what Frank used instead (the reply or the step). */
  text: z.string().optional(),
  /** Every kind suggested, in order. */
  suggested: z.array(FollowupKind).optional(),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
});
export type FollowupLabelRecord = z.infer<typeof FollowupLabelRecord>;

/** Every readable line, oldest first. A torn last line from a crash is skipped. */
export async function readFollowupLabels(file: string): Promise<FollowupLabelRecord[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  const out: FollowupLabelRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = FollowupLabelRecord.safeParse(JSON.parse(line));
      if (r.success) out.push(r.data);
    } catch {
      // skipped
    }
  }
  return out;
}

export class FollowupLabelStore {
  /** `todoId:kind` already labelled missed: once each. */
  private missed = new Set<string>();
  private todos = new Set<string>();
  private appender = new JsonlAppender();

  private constructor(readonly file: string) {}

  static async open(file: string): Promise<FollowupLabelStore> {
    const s = new FollowupLabelStore(file);
    for (const r of await readFollowupLabels(file)) {
      s.todos.add(r.todoId);
      if (r.origin === 'missed') s.missed.add(`${r.todoId}:${r.kind}`);
    }
    return s;
  }

  /** Labelled To Dos (distinct). */
  get count() {
    return this.todos.size;
  }

  hasMissed(todoId: string, kind: FollowupKind) {
    return this.missed.has(`${todoId}:${kind}`);
  }

  /** Resolves once the line is on disk. */
  async append(r: FollowupLabelRecord) {
    if (r.origin === 'missed') this.missed.add(`${r.todoId}:${r.kind}`);
    await this.appender.append(this.file, [JSON.stringify(FollowupLabelRecord.parse(r))]);
    this.todos.add(r.todoId);
  }

  all() {
    return readFollowupLabels(this.file);
  }

  close() {
    return this.appender.close();
  }
}
