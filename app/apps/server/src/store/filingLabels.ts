import { readFile } from 'node:fs/promises';
import { FilingSuggestion, SourceId } from '@work-os/shared';
import { z } from 'zod';
import { JsonlAppender } from './jsonl';
import { LabelThread } from './labels';

// labels/filing.jsonl: what the filing policy got right and wrong (E14, FR-15.7). One line per
// signal, appended. Explicit lines are Frank's word: a correction that changes a filing, "Triage
// was right", the Filing… menu. Implicit lines are read from what he did: approving a draft as it
// stood or after editing it, discarding one, Done on an item in To file with nothing filed,
// adding or dismissing a suggested to-do. A line labels only the fields it knows about; for each
// item and field the latest explicit value wins, else the latest implicit one. Each line carries
// the thread as the model sees it, as triage labels do, so the filing eval can re-run triage after
// the item's raw content has gone to retention.

/** What one filing should have been. `ready` true implies `predraft`, which implies `toFile`. */
export const FilingFlags = z.object({ toFile: z.boolean(), predraft: z.boolean(), ready: z.boolean() }).partial();
export type FilingFlags = z.infer<typeof FilingFlags>;

export const FilingLabel = z.object({ confluence: FilingFlags.optional(), vault: FilingFlags.optional(), todo: z.boolean().optional() });
export type FilingLabel = z.infer<typeof FilingLabel>;

export const FILING_SIGNALS = {
  explicit: ['corrected', 'confirmed', 'not_for_filing', 'no_predraft', 'should_be_ready', 'not_ready'],
  implicit: ['approved', 'approved_edited', 'discarded', 'done_unfiled', 'todo_added', 'todo_dismissed'],
} as const;
export type FilingSignal = (typeof FILING_SIGNALS)['explicit' | 'implicit'][number];

export const FilingLabelRecord = z.object({
  at: z.iso.datetime(),
  origin: z.enum(['explicit', 'implicit']),
  signal: z.enum([...FILING_SIGNALS.explicit, ...FILING_SIGNALS.implicit]),
  itemId: z.string().min(1),
  itemRevision: z.number().int().positive(),
  source: SourceId,
  label: FilingLabel,
  /** The decision's filing fields as they stood, for reading the label back. */
  was: z
    .object({
      confluence: FilingSuggestion,
      vault: FilingSuggestion,
      todo: z.object({ rule: z.string().optional() }).optional(),
      by: z.enum(['rule', 'model', 'user']),
      promptVersion: z.string().optional(),
      policyVersion: z.string().optional(),
    })
    .optional(),
  thread: LabelThread,
});
export type FilingLabelRecord = z.infer<typeof FilingLabelRecord>;

/** Every readable line, oldest first. A torn last line from a crash is skipped. */
export async function readFilingLabels(file: string): Promise<FilingLabelRecord[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  const out: FilingLabelRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = FilingLabelRecord.safeParse(JSON.parse(line));
      if (r.success) out.push(r.data);
    } catch {
      // skipped
    }
  }
  return out;
}

/** A field's value, and whether Frank said so or it was read from what he did. */
export interface LabelValue {
  value: boolean;
  origin: 'explicit' | 'implicit';
  signal: FilingSignal;
}

export type FilingField = 'toFile' | 'predraft' | 'ready';

/** An item's merged label: the latest line's thread and decision, each field's winning value. */
export interface MergedFilingLabel {
  itemId: string;
  source: SourceId;
  itemRevision: number;
  thread: Thread;
  was?: FilingLabelRecord['was'];
  confluence: Partial<Record<FilingField, LabelValue>>;
  vault: Partial<Record<FilingField, LabelValue>>;
  todo?: LabelValue;
}

type Thread = z.infer<typeof LabelThread>;

const wins = (prev: LabelValue | undefined, next: LabelValue) => !prev || next.origin === 'explicit' || prev.origin === 'implicit';

/** The label per item, in the order the items were first labelled: explicit beats implicit, later beats earlier. */
export function mergeFilingLabels(records: readonly FilingLabelRecord[]): MergedFilingLabel[] {
  const by = new Map<string, MergedFilingLabel>();
  for (const r of records) {
    const m = by.get(r.itemId) ?? { itemId: r.itemId, source: r.source, itemRevision: r.itemRevision, thread: r.thread, confluence: {}, vault: {} };
    Object.assign(m, { itemRevision: r.itemRevision, thread: r.thread, ...(r.was && { was: r.was }) });
    for (const target of ['confluence', 'vault'] as const) {
      for (const [field, value] of Object.entries(r.label[target] ?? {}) as [FilingField, boolean][]) {
        const next: LabelValue = { value, origin: r.origin, signal: r.signal };
        if (wins(m[target][field], next)) m[target][field] = next;
      }
    }
    if (r.label.todo !== undefined) {
      const next: LabelValue = { value: r.label.todo, origin: r.origin, signal: r.signal };
      if (wins(m.todo, next)) m.todo = next;
    }
    by.set(r.itemId, m);
  }
  return [...by.values()];
}

/** Fills in what a field implies: ready means pre-drafted and filed; not filed means neither. */
export function impliedFlags(f: FilingFlags): FilingFlags {
  const out = { ...f };
  if (out.ready) out.predraft = true;
  if (out.predraft) out.toFile = true;
  if (out.toFile === false) out.predraft = false;
  if (out.predraft === false) out.ready = false;
  return out;
}

export class FilingLabelStore {
  private items = new Set<string>();
  private explicit = 0;
  private implicit = 0;
  private appender = new JsonlAppender();

  private constructor(readonly file: string) {}

  static async open(file: string): Promise<FilingLabelStore> {
    const s = new FilingLabelStore(file);
    for (const r of await readFilingLabels(file)) s.count(r);
    return s;
  }

  /** Labelled items, and how many lines Frank gave and how many were read from what he did. */
  get counts() {
    return { labels: this.items.size, explicit: this.explicit, implicit: this.implicit };
  }

  /** Resolves once the line is on disk. */
  async append(r: FilingLabelRecord) {
    await this.appender.append(this.file, [JSON.stringify(FilingLabelRecord.parse(r))]);
    this.count(r);
  }

  all() {
    return readFilingLabels(this.file);
  }

  close() {
    return this.appender.close();
  }

  private count(r: FilingLabelRecord) {
    this.items.add(r.itemId);
    if (r.origin === 'explicit') this.explicit++;
    else this.implicit++;
  }
}
