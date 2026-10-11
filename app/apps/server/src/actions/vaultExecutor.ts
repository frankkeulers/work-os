import { link, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { VaultAppendDraft, VaultMultiDraft, VaultNewDraft } from '@work-os/shared';
import { fsyncDir, tmpName, writeFileAtomic, writeSynced } from '../store/atomic';
import type { StoredDraft } from '../store/drafts';
import { checkNotePath, insertUnderHeading, readOrNull, sha256, touchUpdated, VaultPathError } from './vaultFiles';

// The vault executor (FR-9.4, FR-14.5, NF-5): code, never a model, writes an approved draft. Before
// every attempt it reconciles against the file as it is now:
//   - the expected hash: an earlier attempt already wrote it, so it is done;
//   - the base hash (or no file, for a new note): write;
//   - anything else: someone changed it, so re-draft rather than overwrite.
// A draft that found its content already filed (FR-9.6) writes nothing: it only checks the note is
// still there.
// In dry-run the write goes to <data>/sandbox/vault/<path>; the sandbox copy, if there is one,
// stands in for the vault file, so a second approval sees the first.
// A draft that files into several notes (FR-9.7) reconciles each note the same way, by its own
// hashes. Nothing is written unless every note checks out; after a crash part-way, the notes
// already written match their expected hash and only the rest are written.

export interface VaultTargets {
  vaultRoot: string;
  sandboxRoot: string;
  dryRun: boolean;
  /** Today in London (YYYY-MM-DD): an append sets the note's "updated:" to it. */
  today: string;
}

export type VaultPlan =
  | { kind: 'write'; file: string; content: string; expectedHash: string; isNew: boolean; message: string }
  | { kind: 'writes'; writes: FileWrite[]; files: string[]; expectedHashes: Record<string, string>; message: string }
  | { kind: 'already'; file: string; files?: string[]; message: string }
  | { kind: 'filed'; file: string; message: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'refused'; message: string };

const doneMessage = (t: VaultTargets, d: VaultNewDraft | VaultAppendDraft, file: string) =>
  `${t.dryRun ? 'Dry-run: ' : ''}${d.kind === 'vault_append' ? `Appended under ${d.heading} in` : 'Created'} ${file}. Logged action.executed.`;

/** One file of a draft that files into several notes. */
export type FileWrite = { file: string; content: string; isNew: boolean };

const multiMessage = (t: VaultTargets, d: VaultMultiDraft) =>
  `${t.dryRun ? `Dry-run: Filed into ${t.sandboxRoot}: ` : 'Filed: '}${d.parts.map((p) => (p.kind === 'append' ? `appended under ${p.heading} in ${p.path}` : `created ${p.path}`)).join('; ')}. Logged action.executed.`;

/** The files of a draft that files into several notes (FR-9.7), each reconciled on its own. Reads only. */
async function planMulti(t: VaultTargets, stored: StoredDraft, d: VaultMultiDraft): Promise<VaultPlan> {
  const paths: string[] = [];
  for (const p of d.parts) {
    try {
      const path = await checkNotePath(t.vaultRoot, p.path);
      if (!paths.includes(path)) paths.push(path);
    } catch (e) {
      if (e instanceof VaultPathError) return { kind: 'refused', message: `${e.message} The executor refused the write.` };
      throw e;
    }
  }
  const writes: FileWrite[] = [];
  const files: string[] = [];
  const expectedHashes: Record<string, string> = {};
  for (const path of paths) {
    const real = join(t.vaultRoot, path);
    const file = t.dryRun ? join(t.sandboxRoot, path) : real;
    files.push(file);
    const current = t.dryRun ? ((await readOrNull(file)) ?? (await readOrNull(real))) : await readOrNull(real);
    const currentHash = current === null ? null : sha256(current);
    const expected = stored.expectedHashes?.[path];
    if (currentHash && expected && currentHash === expected) {
      expectedHashes[path] = expected; // written by an earlier attempt
      continue;
    }
    const own = d.parts.filter((p) => p.path === path);
    const base = stored.baseHashes?.[path];
    let content: string | undefined;
    if (base === undefined) return { kind: 'conflict', message: `The draft has no record of ${path} as it was. Re-drafting instead of writing.` };
    if (base === null) {
      if (current !== null) return { kind: 'conflict', message: `A note now exists at ${path}. Re-drafting instead of overwriting it.` };
      content = own.find((p) => p.kind === 'new')?.content;
      if (content === undefined) return { kind: 'conflict', message: `${path} no longer exists. Re-drafting instead of writing.` };
    } else {
      if (current === null) return { kind: 'conflict', message: `${path} no longer exists. Re-drafting instead of writing.` };
      if (currentHash !== base) return { kind: 'conflict', message: `${path} changed after drafting (file hash differs). Re-drafting instead of writing.` };
      let text: string = current;
      for (const p of own) {
        const ins = p.kind === 'append' ? insertUnderHeading(text, p.heading, p.content) : undefined;
        if (!ins) return { kind: 'conflict', message: `${path} no longer has the heading ${p.kind === 'append' ? p.heading : ''}. Re-drafting instead of writing.` };
        text = ins.content;
      }
      content = touchUpdated(text, t.today);
    }
    expectedHashes[path] = sha256(content);
    writes.push({ file, content, isNew: base === null });
  }
  const message = multiMessage(t, d);
  if (!writes.length) return { kind: 'already', file: files[0], files, message };
  return { kind: 'writes', writes, files, expectedHashes, message };
}

/** What is there now, and what an attempt would write. Reads only. */
export async function planVaultWrite(t: VaultTargets, stored: StoredDraft): Promise<VaultPlan> {
  const d = stored.draft;
  if (!d || d.kind === 'confluence' || d.kind === 'confluence_filed' || d.kind === 'todo') return { kind: 'refused', message: 'This draft is not a vault note.' };
  if (d.kind === 'vault_multi') return planMulti(t, stored, d);
  let path: string;
  try {
    path = await checkNotePath(t.vaultRoot, d.path);
  } catch (e) {
    if (e instanceof VaultPathError) return { kind: 'refused', message: `${e.message} The executor refused the write.` };
    throw e;
  }
  const real = join(t.vaultRoot, path);
  const file = t.dryRun ? join(t.sandboxRoot, path) : real;
  const current = t.dryRun ? ((await readOrNull(file)) ?? (await readOrNull(real))) : await readOrNull(real);
  if (d.kind === 'vault_filed') {
    if (current === null) return { kind: 'conflict', message: `${path} no longer exists. Re-drafting instead of marking it filed.` };
    return { kind: 'filed', file: real, message: `Already in the vault: ${path}. Nothing was written. Logged action.executed.` };
  }
  const currentHash = current === null ? null : sha256(current);
  if (currentHash && stored.expectedHash && currentHash === stored.expectedHash) return { kind: 'already', file, message: doneMessage(t, d, file) };

  if (d.kind === 'vault_new') {
    if (current !== null) return { kind: 'conflict', message: `A note now exists at ${path}. Re-drafting instead of overwriting it.` };
    return { kind: 'write', file, content: d.content, expectedHash: sha256(d.content), isNew: true, message: doneMessage(t, d, file) };
  }
  if (current === null) return { kind: 'conflict', message: `${path} no longer exists. Re-drafting instead of writing.` };
  if (currentHash !== stored.baseHash) return { kind: 'conflict', message: `${path} changed after drafting (file hash differs). Re-drafting instead of writing.` };
  const ins = insertUnderHeading(current, d.heading, d.content);
  if (!ins) return { kind: 'conflict', message: `${path} no longer has the heading ${d.heading}. Re-drafting instead of writing.` };
  const content = touchUpdated(ins.content, t.today);
  return { kind: 'write', file, content, expectedHash: sha256(content), isNew: false, message: doneMessage(t, d, file) };
}

/** A new note must not exist when it lands. */
export class NoteExistsError extends Error {
  constructor(file: string) {
    super(`A note appeared at ${file} while writing.`);
    this.name = 'NoteExistsError';
  }
}

/**
 * Writes the planned file. An append replaces the file atomically; a new note is linked into
 * place, which fails if a note appeared meanwhile, so nothing is ever overwritten.
 */
export async function writeVaultFile(plan: FileWrite) {
  const dir = dirname(plan.file);
  await mkdir(dir, { recursive: true });
  if (!plan.isNew) return writeFileAtomic(plan.file, plan.content, 0o644);
  const tmp = tmpName(plan.file);
  try {
    await writeSynced(tmp, plan.content, 0o644);
    await link(tmp, plan.file).catch((e: NodeJS.ErrnoException) => Promise.reject(e.code === 'EEXIST' ? new NoteExistsError(plan.file) : e));
  } finally {
    await rm(tmp, { force: true });
  }
  await fsyncDir(dir);
}
