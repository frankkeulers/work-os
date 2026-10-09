import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Item, Need, NextStep, SettleDecision, type DecisionText } from '@work-os/shared';
import { z } from 'zod';
import { writeJsonAtomic } from './atomic';

// items/<source>/<id>.json: an item's raw content and the decision's free text (PLAN.md §4.3).
// This is the only place message text and its paraphrases live, so retention can delete them
// together. Full items are cached in a small LRU; the short texts the inbox shows, and a
// meeting's calendar event and categories (R2.8), are kept for every item read or written.

/**
 * The last settle check on Frank's reply (cockpit CK-2.3, CK-2.6): what the model saw and what it
 * answered, kept for the row's "still open" line and for a label if Frank undoes a close.
 */
export const SettleSnapshot = z.object({
  at: z.string(),
  batchId: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  /** The check as sent: the thread, the open asks and Frank's reply. */
  input: z.record(z.string(), z.unknown()),
  decision: SettleDecision,
  /** Why the first ask still open is open; absent when every ask settled. */
  why: z.string().optional(),
});
export type SettleSnapshot = z.infer<typeof SettleSnapshot>;

/**
 * Looks finished (cockpit CK-2.10): what the topic asked of Frank before a re-triage found it needs
 * nothing from him (the decision's text no longer says), messages after `since` to judge it by,
 * and the check's snapshot once it ran, for the row and for a label when Frank answers it.
 */
export const FinishState = z.object({
  asks: z.array(z.object({ index: z.number().int().nonnegative(), need: Need, step: z.string().min(1) })).min(1),
  since: z.string(),
  check: SettleSnapshot.optional(),
});
export type FinishState = z.infer<typeof FinishState>;

export const StoredItem = z.object({
  item: Item,
  text: z.object({ summary: z.string(), reason: z.string(), next: NextStep.optional() }).optional(),
  settle: SettleSnapshot.optional(),
  finish: FinishState.optional(),
  schemaVersion: z.literal(1),
});
export type StoredItem = z.infer<typeof StoredItem>;

export const LRU_SIZE = 64;

export interface ItemCalendar {
  eventId: string;
  categories?: string[];
}

/** A file name for an id: everything outside [A-Za-z0-9._-] is escaped, so an id can't name a path. */
export const fileNameFor = (id: string) => `${id.replace(/[^A-Za-z0-9._-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}.json`;

export class ItemFiles {
  private lru = new Map<string, StoredItem | null>(); // null: no file
  private texts = new Map<string, DecisionText>();
  private calendars = new Map<string, ItemCalendar>();

  constructor(private readonly dir: string) {}

  private path(source: string, id: string) {
    return join(this.dir, source, fileNameFor(id));
  }

  private locks = new Map<string, Promise<unknown>>();

  /**
   * Reads, changes and writes one item's file, one change at a time per item, so a poll merging new
   * messages and triage saving its text can't overwrite each other. `fn` returns the new contents,
   * or undefined to leave the file as it is.
   */
  update<T extends StoredItem | undefined>(source: string, id: string, fn: (stored: StoredItem | undefined) => T | Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(async () => {
      const next = await fn(await this.read(source, id));
      if (next) await this.write(next);
      return next;
    });
    const settled = run.catch(() => undefined);
    this.locks.set(id, settled);
    void settled.then(() => {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    });
    return run;
  }

  async write(stored: StoredItem) {
    const s = StoredItem.parse(stored);
    await mkdir(join(this.dir, s.item.source), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(this.path(s.item.source, s.item.id), s);
    this.remember(s.item.id, s);
  }

  /** The stored item, or undefined if its file is gone (retention) or unreadable. */
  async read(source: string, id: string): Promise<StoredItem | undefined> {
    if (this.lru.has(id)) {
      const hit = this.lru.get(id)!;
      this.lru.delete(id);
      this.lru.set(id, hit);
      return hit ?? undefined;
    }
    let stored: StoredItem | null = null;
    try {
      const parsed = StoredItem.safeParse(JSON.parse(await readFile(this.path(source, id), 'utf8')));
      if (parsed.success) stored = parsed.data;
    } catch {
      // Missing or unreadable: the item shows as expired until a poll re-fetches it.
    }
    this.remember(id, stored);
    return stored ?? undefined;
  }

  async remove(source: string, id: string) {
    await rm(this.path(source, id), { force: true });
    this.lru.delete(id);
    this.texts.delete(id);
    this.calendars.delete(id);
  }

  /** Whether the item still has its file, without reading it. */
  hasFile(source: string, id: string): Promise<boolean> {
    return stat(this.path(source, id)).then(
      () => true,
      () => false,
    );
  }

  /**
   * Retention (FR-12.1): removes the item's file if the file itself says it was last active before
   * `before`. Runs under the item's lock and reads the file, not the projection, so a poll merging a
   * new message into an old thread at the same moment keeps it.
   */
  async expire(source: string, id: string, before: string): Promise<boolean> {
    let removed = false;
    await this.update(source, id, async (stored) => {
      if (stored && stored.item.lastActivityAt < before) {
        await this.remove(source, id);
        removed = true;
      }
      return undefined;
    });
    return removed;
  }

  /** The short texts for the inbox, if this item has been read or written since the start. */
  text(id: string): DecisionText | undefined {
    return this.texts.get(id);
  }

  /** A meeting's or invite's calendar event and the categories the item kept, for the inbox (R2.8). */
  calendarOf(id: string): ItemCalendar | undefined {
    return this.calendars.get(id);
  }

  /** Reads the texts for these items in the background of a start, a few files at a time. */
  async preload(items: { id: string; source: string }[], concurrency = 16) {
    const queue = items.filter((i) => !this.texts.has(i.id));
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) await this.read(next.source, next.id);
      }),
    );
  }

  private remember(id: string, stored: StoredItem | null) {
    this.lru.delete(id);
    this.lru.set(id, stored);
    if (this.lru.size > LRU_SIZE) this.lru.delete(this.lru.keys().next().value!);
    if (stored) {
      this.texts.set(id, {
        summary: stored.text?.summary,
        reason: stored.text?.reason,
        next: stored.text?.next,
        firstMessage: stored.item.messages[0]?.text,
        ...(stored.settle?.why && { settleWhy: stored.settle.why }),
        ...(stored.finish?.check?.decision.asks[0]?.why && { finishWhy: stored.finish.check.decision.asks[0].why }),
      });
      const cal = stored.item.meeting?.calendar;
      if (cal) this.calendars.set(id, { eventId: cal.eventId, ...(cal.categories && { categories: cal.categories }) });
      else this.calendars.delete(id);
    } else {
      this.texts.set(id, {});
      this.calendars.delete(id);
    }
  }
}
