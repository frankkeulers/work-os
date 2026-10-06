import { access, open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fsyncDir } from './atomic';

// Append-only JSONL with group commit (PLAN.md §4.3, NF-11). Lines queued while a write is in
// flight go out together in the next batch: one write and one sync, then every waiter resolves.
// A whole poll costs one sync, and a command returns only once its line is on disk.
//
// On macOS, libuv implements fdatasync with F_FULLFSYNC (falling back to F_BARRIERFSYNC), so a
// sync reaches the drive, not just its cache. Open question 7 in PLAN.md records the measurement.

type Pending = { file: string; data: string; resolve: () => void; reject: (e: unknown) => void };

export interface AppenderHooks {
  onSync?: (file: string, bytes: number, lines: number) => void;
}

export class JsonlAppender {
  private queue: Pending[] = [];
  private loop?: Promise<void>;
  private fh?: FileHandle;
  private fhFile?: string;
  private size = 0; // bytes in fhFile, so a failed batch can be cut back off

  constructor(private readonly hooks: AppenderHooks = {}) {}

  /** Resolves once the lines are synced to `file`. Lines for one file land in call order. */
  append(file: string, lines: string[]): Promise<void> {
    if (!lines.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.queue.push({ file, data: lines.map((l) => `${l}\n`).join(''), resolve, reject });
      // Start on a microtask, so appends made in the same tick share the first batch.
      this.loop ??= Promise.resolve().then(() => this.drain());
    });
  }

  /** Waits for everything queued so far. */
  async flushed() {
    while (this.loop) await this.loop;
  }

  async close() {
    await this.flushed();
    await this.closeHandle();
  }

  private async drain() {
    try {
      while (this.queue.length) {
        const batch = this.queue.splice(0);
        let i = 0;
        try {
          while (i < batch.length) {
            const file = batch[i].file;
            let j = i;
            let data = '';
            while (j < batch.length && batch[j].file === file) data += batch[j++].data;
            await this.write(file, data, j - i);
            for (let k = i; k < j; k++) batch[k].resolve();
            i = j;
          }
        } catch (e) {
          // Nothing after a failed batch may land, or the log would have a hole.
          for (const p of [...batch.slice(i), ...this.queue.splice(0)]) p.reject(e);
        }
      }
    } finally {
      this.loop = undefined;
    }
  }

  private async write(file: string, data: string, lines: number) {
    const fh = await this.handle(file);
    const buf = Buffer.from(data);
    try {
      let off = 0;
      while (off < buf.length) off += (await fh.write(buf, off, buf.length - off)).bytesWritten;
      await fh.datasync();
      this.size += buf.length;
      this.hooks.onSync?.(file, buf.length, lines);
    } catch (e) {
      // Cut a partial write back off, so the file never keeps a torn line.
      await fh.truncate(this.size).catch(() => undefined);
      await this.closeHandle();
      throw e;
    }
  }

  private async handle(file: string): Promise<FileHandle> {
    if (this.fh && this.fhFile === file) return this.fh;
    await this.closeHandle();
    const created = await access(file).then(
      () => false,
      () => true,
    );
    const fh = await open(file, 'a', 0o600);
    this.size = (await fh.stat()).size;
    if (created) await fsyncDir(dirname(file)); // the new file's name must survive a crash too
    this.fh = fh;
    this.fhFile = file;
    return fh;
  }

  private async closeHandle() {
    const fh = this.fh;
    this.fh = undefined;
    this.fhFile = undefined;
    await fh?.close().catch(() => undefined);
  }
}
