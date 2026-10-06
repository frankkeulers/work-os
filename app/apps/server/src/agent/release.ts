import { lstat, mkdir, readdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';

// Releases under ~/Library/Application Support/WorkOS (PLAN.md robustness §1): each deploy is a
// new folder, and `current` is swapped to it in one rename, so launchd never sees half a release.

export const KEEP_RELEASES = 3;

export function releaseName(version: string, at: Date, commit: string): string {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${version}-${stamp}-${commit}`;
}

export async function currentRelease(root: string): Promise<string | undefined> {
  try {
    return (await readlink(join(root, 'current'))).replace(/^releases\//, '');
  } catch {
    return undefined;
  }
}

/** Points `current` at releases/<name>, atomically: a new link, then a rename over the old one. */
export async function swapCurrent(root: string, name: string) {
  const tmp = join(root, `.current-${process.pid}`);
  await rm(tmp, { force: true });
  await symlink(join('releases', name), tmp);
  await rename(tmp, join(root, 'current'));
}

/** The releases to delete: all but the newest few, never the current one. Names sort by time. */
export function toPrune(names: string[], current: string | undefined, keep = KEEP_RELEASES): string[] {
  const sorted = names.filter((n) => !n.startsWith('.')).sort((a, b) => stampOf(b).localeCompare(stampOf(a)));
  return sorted.slice(keep).filter((n) => n !== current);
}

const stampOf = (name: string) => /-(\d{8}T\d{6}Z)-/.exec(name)?.[1] ?? '';

export async function pruneReleases(root: string, keep = KEEP_RELEASES): Promise<string[]> {
  const dir = join(root, 'releases');
  const names = await readdir(dir).catch(() => [] as string[]);
  const doomed = toPrune(names, await currentRelease(root), keep);
  for (const n of doomed) {
    const p = join(dir, n);
    if ((await lstat(p)).isDirectory()) await rm(p, { recursive: true, force: true });
  }
  return doomed;
}

export async function ensureRoot(root: string) {
  await mkdir(join(root, 'releases'), { recursive: true, mode: 0o700 });
}
