import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Item, NextStep, type DecisionText } from '@work-os/shared';
import { z } from 'zod';
import { writeJsonAtomic } from './atomic';

// items/<source>/<id>.json: an item's raw content and the decision's free text (PLAN.md §4.3).
// This is the only place message text and its paraphrases live, so retention can delete them
// together. Full items are cached in a small LRU; the short texts the inbox shows are kept for
// every item that has been read or written.

export const StoredItem = z.object({
  item: Item,
  text: z.object({ summary: z.string(), reason: z.string(), next: NextStep.optional() }).optional(),
  schemaVersion: z.literal(1),
});
export type StoredItem = z.infer<typeof StoredItem>;

export const LRU_SIZE = 64;

/** A file name for an id: everything outside [A-Za-z0-9._-] is escaped, so an id can't name a path. */
export const fileNameFor = (id: string) => `${id.replace(/[^A-Za-z0-9._-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)}.json`;

export class ItemFiles {
  private lru = new Map<string, StoredItem | null>(); // null: no file
  private texts = new Map<string, DecisionText>();

  constructor(private readonly dir: string) {}

  private path(source: string, id: string) {
    return join(this.dir, source, fileNameFor(id));
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
  }

  /** The short texts for the inbox, if this item has been read or written since the start. */
  text(id: string): DecisionText | undefined {
    return this.texts.get(id);
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
      });
    } else this.texts.set(id, {});
  }
}
