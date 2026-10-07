import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { GuideFilesView } from '@work-os/shared';
import { HttpError } from './errors';

// The user guide, read from its folder on every request (FR-1.8), so an edited page shows without
// a deploy. Only `<slug>.md` files directly in the folder are read; the client never names a path.
// The web build carries its own copy of the guide, which it shows when this is unavailable.

export const GUIDE_FILE = /^[a-z0-9-]+\.md$/;
export const MAX_GUIDE_FILES = 100;
export const MAX_GUIDE_BYTES = 256 * 1024;

const code = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code;

export async function readGuide(dir: string | undefined): Promise<GuideFilesView> {
  if (!dir) throw new HttpError('unavailable', 'This server has no guide folder; the app shows its built-in copy.');
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    // A launchd agent may need permission to read a folder under ~/Documents.
    const why = code(err) === 'ENOENT' ? 'is missing' : code(err) === 'EPERM' || code(err) === 'EACCES' ? 'can’t be read (macOS may need to allow it)' : 'can’t be read';
    throw new HttpError('unavailable', `The guide folder ${dir} ${why}; the app shows its built-in copy.`);
  }
  const files: GuideFilesView['files'] = [];
  for (const name of names.filter((n) => GUIDE_FILE.test(n)).sort().slice(0, MAX_GUIDE_FILES)) {
    const path = join(dir, name);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile() || info.size > MAX_GUIDE_BYTES) continue;
    const source = await readFile(path, 'utf8').catch(() => undefined);
    if (source !== undefined) files.push({ slug: name.slice(0, -3), source });
  }
  return { dir, files };
}
