import { readFile } from 'node:fs/promises';
import { SettleDecision, SourceId, type ItemState } from '@work-os/shared';
import { z } from 'zod';
import type { ItemFiles } from './items';
import { JsonlAppender } from './jsonl';

// labels/settle.jsonl: what the settle check got wrong (cockpit CK-2.6). Undoing a close on reply
// says it shouldn't have closed; pressing Done soon after a check that said "not settled" says it
// should have. Each line carries the check as the model got it, so the settle eval can re-run it
// after the item's raw content has gone to retention.

/** How soon after a "not settled" check a Done counts as a missed close. */
export const MISSED_CLOSE_MS = 30 * 60_000;

export const SettleLabelRecord = z.object({
  at: z.iso.datetime(),
  origin: z.enum(['undo', 'manual_done']),
  itemId: z.string().min(1),
  itemRevision: z.number().int().positive(),
  source: SourceId,
  /** What the check should have found: every ask settled, so the item closes. */
  settled: z.boolean(),
  /** The check as sent: the thread, the open asks and Frank's reply. */
  check: z.record(z.string(), z.unknown()),
  /** What the model answered. */
  was: SettleDecision,
  model: z.string(),
  promptVersion: z.string(),
});
export type SettleLabelRecord = z.infer<typeof SettleLabelRecord>;

/** Every readable line, oldest first. A torn last line from a crash is skipped. */
export async function readSettleLabels(file: string): Promise<SettleLabelRecord[]> {
  const text = await readFile(file, 'utf8').catch(() => '');
  const out: SettleLabelRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = SettleLabelRecord.safeParse(JSON.parse(line));
      if (r.success) out.push(r.data);
    } catch {
      // skipped
    }
  }
  return out;
}

/** The latest label per item. */
export function latestSettleLabels(records: SettleLabelRecord[]): SettleLabelRecord[] {
  const by = new Map<string, SettleLabelRecord>();
  for (const r of records) by.set(r.itemId, r);
  return [...by.values()];
}

/** Whether Frank's Done or reopen, about to be logged, says the check was wrong, and how. */
export function settleLabelOrigin(it: ItemState, kind: 'done' | 'reopened', now: Date): SettleLabelRecord['origin'] | undefined {
  if (kind === 'reopened') return it.status === 'done' && it.doneBy === 'reply' ? 'undo' : undefined;
  const c = it.replyCheck;
  return it.status === 'open' && c && !c.allSettled && now.getTime() - Date.parse(c.at) <= MISSED_CLOSE_MS ? 'manual_done' : undefined;
}

export class SettleLabelStore {
  private items = new Set<string>();
  private appender = new JsonlAppender();

  private constructor(readonly file: string) {}

  static async open(file: string): Promise<SettleLabelStore> {
    const s = new SettleLabelStore(file);
    for (const r of await readSettleLabels(file)) s.items.add(r.itemId);
    return s;
  }

  /** Labelled checks (distinct items). */
  get count() {
    return this.items.size;
  }

  /** Resolves once the line is on disk. */
  async append(r: SettleLabelRecord) {
    await this.appender.append(this.file, [JSON.stringify(SettleLabelRecord.parse(r))]);
    this.items.add(r.itemId);
  }

  /**
   * Labels the items Frank is about to mark done or reopen, from their state before the event, if
   * the check got them wrong. Needs the check's snapshot in the item's file; without it, nothing.
   */
  async label(d: { items: ItemFiles; now: () => Date }, before: readonly ItemState[], kind: 'done' | 'reopened'): Promise<number> {
    let n = 0;
    for (const it of before) {
      const origin = settleLabelOrigin(it, kind, d.now());
      if (!origin) continue;
      const snap = (await d.items.read(it.source, it.id))?.settle;
      if (!snap) continue;
      await this.append({
        at: d.now().toISOString(),
        origin,
        itemId: it.id,
        itemRevision: snap.decision.itemRevision,
        source: it.source,
        settled: origin === 'manual_done',
        check: snap.input,
        was: snap.decision,
        model: snap.model,
        promptVersion: snap.promptVersion,
      });
      n++;
    }
    return n;
  }

  all() {
    return readSettleLabels(this.file);
  }

  close() {
    return this.appender.close();
  }
}
