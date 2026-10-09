import { readFile } from 'node:fs/promises';
import { Attention, ItemKind, SourceId } from '@work-os/shared';
import { z } from 'zod';
import { JsonlAppender } from './jsonl';

// labels/triage.jsonl: the labelled set (FR-6.1, FR-6.2). One line per label, appended; the latest
// line for an item is its label. Each line carries the thread as the model sees it, so the eval
// can re-run triage after the item's raw content has gone to retention. Lines come from
// corrections in the UI, from "Triage was right" (the decision as it stood, so the set holds
// what triage gets right too), and, later, from the Phase 0 labelled set (P0-4).

const Label = z.object({ attention: Attention, confluence: z.boolean(), vault: z.boolean() });

export const LabelThread = z.object({
  id: z.string().min(1),
  kind: ItemKind,
  title: z.string(),
  messages: z.array(z.object({ author: z.string(), at: z.string(), text: z.string(), to: z.array(z.string()).optional(), cc: z.array(z.string()).optional() })),
  omitted: z.number().int().nonnegative(),
});

export const LabelRecord = z.object({
  at: z.iso.datetime(),
  origin: z.enum(['correction', 'confirmed', 'import']),
  itemId: z.string().min(1),
  itemRevision: z.number().int().positive(),
  source: SourceId,
  label: Label,
  /** The triage it replaced, for reading corrections back. */
  was: Label.extend({ by: z.enum(['rule', 'model', 'user']) }).optional(),
  thread: LabelThread,
});
export type LabelRecord = z.infer<typeof LabelRecord>;

/** Every readable line, oldest first. A torn last line from a crash is skipped. */
export async function readLabels(file: string): Promise<LabelRecord[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  const out: LabelRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = LabelRecord.safeParse(JSON.parse(line));
      if (r.success) out.push(r.data);
    } catch {
      // skipped
    }
  }
  return out;
}

/** The latest label per item, in the order the items were first labelled. */
export function latestLabels(records: LabelRecord[]): LabelRecord[] {
  const by = new Map<string, LabelRecord>();
  for (const r of records) by.set(r.itemId, r);
  return [...by.values()];
}

export class LabelStore {
  private items = new Set<string>();
  private corrections = 0;
  private confirmations = 0;
  private appender = new JsonlAppender();

  private constructor(readonly file: string) {}

  static async open(file: string): Promise<LabelStore> {
    const s = new LabelStore(file);
    for (const r of await readLabels(file)) s.count(r);
    return s;
  }

  /** Labelled threads (distinct items), and how many lines came from corrections and from "Triage was right". */
  get counts() {
    return { labels: this.items.size, corrections: this.corrections, confirmations: this.confirmations };
  }

  /** Resolves once the line is on disk. */
  async append(r: LabelRecord) {
    await this.appender.append(this.file, [JSON.stringify(LabelRecord.parse(r))]);
    this.count(r);
  }

  all() {
    return readLabels(this.file);
  }

  close() {
    return this.appender.close();
  }

  private count(r: LabelRecord) {
    this.items.add(r.itemId);
    if (r.origin === 'correction') this.corrections++;
    if (r.origin === 'confirmed') this.confirmations++;
  }
}
