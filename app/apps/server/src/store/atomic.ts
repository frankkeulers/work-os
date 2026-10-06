import { randomBytes } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

// Atomic file writes (PLAN.md §4.3): write a tmp file, fsync it, rename it over the target, then
// fsync the directory so the rename itself survives power loss.

export const tmpName = (file: string) => join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);

export async function fsyncDir(dir: string) {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Writes a complete file to a tmp path and fsyncs it. The caller renames or links it into place. */
export async function writeSynced(file: string, data: string | Uint8Array, mode = 0o600) {
  const fh = await open(file, 'wx', mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export async function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600) {
  const tmp = tmpName(file);
  try {
    await writeSynced(tmp, data, mode);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  await fsyncDir(dirname(file));
}

export const writeJsonAtomic = (file: string, value: unknown) => writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
