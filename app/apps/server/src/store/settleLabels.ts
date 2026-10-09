import { readFile } from 'node:fs/promises';
import { SettleDecision, SourceId, awaitsReply, type ItemState } from '@work-os/shared';
import { z } from 'zod';
import type { ItemFiles } from './items';
import { JsonlAppender } from './jsonl';

// labels/settle.jsonl: what the settle check got wrong (cockpit CK-2.6). Undoing a close on reply
// says it shouldn't have closed; pressing Done soon after a check that said "not settled" says it
// should have. So does pressing Done on an item Frank wrote on since its triage that no check saw
// (it was off for the source, failed, or never ran): the check is built at Done, as it would have
// gone to the model. Each line carries the check, so the settle eval can re-run it after the
// item's raw content has gone to retention.

/** How soon after a "not settled" check a Done counts as a missed close. */
export const MISSED_CLOSE_MS = 30 * 60_000;

export const SettleLabelRecord = z.object({
  at: z.iso.datetime(),
  // finish_*: labels/finish.jsonl, Frank's answer to a "Looks finished" suggestion (cockpit CK-2.10).
  origin: z.enum(['undo', 'manual_done', 'manual_done_unchecked', 'finish_accepted', 'finish_rejected']),
  itemId: z.string().min(1),
  itemRevision: z.number().int().positive(),
  source: SourceId,
  /** What the check should have found: every ask settled, so the item closes. */
  settled: z.boolean(),
  /** The check as sent: the thread, the open asks and Frank's reply. */
  check: z.record(z.string(), z.unknown()),
  /** What the model answered. None for `manual_done_unchecked`: no check ran. */
  was: SettleDecision.optional(),
  model: z.string().optional(),
  promptVersion: z.string().optional(),
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
  if (it.status === 'open' && c && !c.allSettled && now.getTime() - Date.parse(c.at) <= MISSED_CLOSE_MS) return 'manual_done';
  // Still waiting on Frank, he wrote since its triage (a revision, or a piece of his joined), and
  // no check saw it: a close the check never got to make.
  const d = it.decision;
  const wroteSince = !!d && (it.revision > d.itemRevision || it.topicVersion > (d.topicVersion ?? 0));
  return awaitsReply(it) && wroteSince && (!c || c.revision < it.revision) ? 'manual_done_unchecked' : undefined;
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
   * the check got them wrong. Needs the check's snapshot in the item's file, or for a check that
   * never ran, `settleCheck` to build it; without either, nothing.
   */
  async label(d: { items: ItemFiles; now: () => Date; settleCheck?: (it: ItemState) => Promise<object | undefined> }, before: readonly ItemState[], kind: 'done' | 'reopened'): Promise<number> {
    let n = 0;
    for (const it of before) {
      const origin = settleLabelOrigin(it, kind, d.now());
      if (!origin) continue;
      if (origin === 'manual_done_unchecked') {
        const check = await d.settleCheck?.(it);
        if (!check) continue;
        await this.append({ at: d.now().toISOString(), origin, itemId: it.id, itemRevision: it.revision, source: it.source, settled: true, check: { ...check } });
        n++;
        continue;
      }
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

  /**
   * Frank answered a "Looks finished" suggestion (cockpit CK-2.10): Done says the check was right,
   * "Not finished" that it wasn't. Labelled from the check's snapshot in the item's file.
   */
  async labelFinish(d: { items: ItemFiles; now: () => Date }, it: ItemState, settled: boolean): Promise<boolean> {
    if (!it.looksFinished) return false;
    const snap = (await d.items.read(it.source, it.id))?.finish?.check;
    if (!snap) return false;
    await this.append({
      at: d.now().toISOString(),
      origin: settled ? 'finish_accepted' : 'finish_rejected',
      itemId: it.id,
      itemRevision: snap.decision.itemRevision,
      source: it.source,
      settled,
      check: snap.input,
      was: snap.decision,
      model: snap.model,
      promptVersion: snap.promptVersion,
    });
    return true;
  }

  all() {
    return readSettleLabels(this.file);
  }

  close() {
    return this.appender.close();
  }
}
