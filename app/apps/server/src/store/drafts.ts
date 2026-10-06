import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Draft } from '@work-os/shared';
import { z } from 'zod';
import { writeJsonAtomic } from './atomic';

// drafts/<actionId>.json: a draft, what the target looked like when it was drafted, and what the
// outbox has done with it (FR-9.x, FR-14.5). The event log says what happened; this file holds
// the content and the hashes the executor reconciles against. Drafts paraphrase message content,
// so retention removes them with the item (M4).

export const StoredDraft = z.object({
  schemaVersion: z.literal(1),
  actionId: z.string().min(1),
  itemId: z.string().min(1),
  draft: Draft.optional(),
  /** The target file's hash when drafted; null when there was no file (a new note). */
  baseHash: z.string().nullable().optional(),
  /** What the target will hash to once written. Saved before each write attempt (FR-14.5). */
  expectedHash: z.string().optional(),
  /** The outcome shown in the item panel. */
  result: z.string().optional(),
});
export type StoredDraft = z.infer<typeof StoredDraft>;

export class DraftStore {
  private locks = new Map<string, Promise<unknown>>();

  constructor(private readonly dir: string) {}

  private file(actionId: string) {
    return join(this.dir, `${actionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
  }

  async read(actionId: string): Promise<StoredDraft | undefined> {
    try {
      const r = StoredDraft.safeParse(JSON.parse(await readFile(this.file(actionId), 'utf8')));
      return r.success ? r.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Deletes the draft file (retention), after any change in progress. True if there was one. */
  async remove(actionId: string): Promise<boolean> {
    await this.locks.get(actionId);
    return rm(this.file(actionId)).then(
      () => true,
      () => false,
    );
  }

  /** Reads, applies `fn` and writes atomically, one change at a time per draft. */
  update(actionId: string, itemId: string, fn: (d: StoredDraft) => StoredDraft): Promise<StoredDraft> {
    const prev = this.locks.get(actionId) ?? Promise.resolve();
    const next = prev.then(async () => {
      const cur = (await this.read(actionId)) ?? { schemaVersion: 1 as const, actionId, itemId };
      const out = StoredDraft.parse(fn(cur));
      await writeJsonAtomic(this.file(actionId), out);
      return out;
    });
    const settled = next.catch(() => undefined);
    this.locks.set(actionId, settled);
    void settled.then(() => {
      if (this.locks.get(actionId) === settled) this.locks.delete(actionId);
    });
    return next;
  }
}
