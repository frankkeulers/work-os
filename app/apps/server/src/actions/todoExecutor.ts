import { join } from 'node:path';
import { taskKey, todoWriteLines, type TodoDraft } from '@work-os/shared';
import type { StoredDraft } from '../store/drafts';
import type { VaultTargets } from './vaultExecutor';
import { checkNotePath, readOrNull, sha256, touchUpdated, VaultPathError } from './vaultFiles';

// The to-do executor (UX-5): code appends an approved to-do's lines to the end of the Tasks note,
// creating it if there is none. As with vault notes, the path is checked against the vault, and in
// dry-run the sandbox copy stands in for the note. An append can't clash with what Frank changed
// in the note since (ticking a task, say), so there is no conflict: the lines go at the end of the
// note as it is now. A task already in the note, ticked or not, is not added again, so an attempt
// cut short by a crash or sleep is finished, never repeated.
// E15 (FR-16.1): each line is written with its id (🆔), from the action and the task, so Work OS
// finds the line again; a task counts as there whatever its id (taskKey).

export type TodoPlan =
  | { kind: 'write'; file: string; real: string; content: string; expectedHash: string; baseHash: string | null; isNew: boolean; message: string }
  | { kind: 'already'; file: string; message: string }
  | { kind: 'refused'; message: string };

/** A new Tasks note: a heading, then the lines. */
const NEW_NOTE = (lines: string[]) => `# Tasks\n\n${lines.join('\n')}\n`;

/** The note with `lines` added at its end, on lines of their own. */
export function appendLines(note: string, lines: string[]): string {
  return `${note.replace(/\s+$/, '')}\n${lines.join('\n')}\n`;
}

/** What is in the note now, and what an attempt would write. Reads only. */
export async function planTodoWrite(t: VaultTargets, stored: StoredDraft, d: TodoDraft): Promise<TodoPlan> {
  let path: string;
  try {
    path = await checkNotePath(t.vaultRoot, d.path);
  } catch (e) {
    if (e instanceof VaultPathError) return { kind: 'refused', message: `${e.message} The executor refused the write. Check the Tasks note in Settings › Write targets.` };
    throw e;
  }
  const lines = todoWriteLines(d.content, stored.actionId);
  if (!lines.length) return { kind: 'refused', message: 'The to-do has no lines, so nothing was written.' };
  const real = join(t.vaultRoot, path);
  const file = t.dryRun ? join(t.sandboxRoot, path) : real;
  const current = t.dryRun ? ((await readOrNull(file)) ?? (await readOrNull(real))) : await readOrNull(real);
  const n = lines.length === 1 ? 'the to-do' : `${lines.length} to-dos`;
  const where = t.dryRun ? `${file} (dry-run sandbox)` : path;
  if (current !== null) {
    const there = new Set(current.split(/\r?\n/).map(taskKey));
    const missing = lines.filter((l) => !there.has(taskKey(l)));
    if (stored.expectedHash === sha256(current) || !missing.length) return { kind: 'already', file, message: `${n === 'the to-do' ? 'The to-do is' : 'The to-dos are'} in ${where}. Logged action.executed.` };
    const content = touchUpdated(appendLines(current, missing), t.today);
    return { kind: 'write', file, real, content, expectedHash: sha256(content), baseHash: sha256(current), isNew: false, message: `${t.dryRun ? 'Dry-run: ' : ''}Added ${missing.length === lines.length ? n : `${missing.length} of ${lines.length} to-dos (the rest were there)`} to ${where}. Logged action.executed.` };
  }
  const content = NEW_NOTE(lines);
  return { kind: 'write', file, real, content, expectedHash: sha256(content), baseHash: null, isNew: true, message: `${t.dryRun ? 'Dry-run: ' : ''}Created ${where} with ${n}. Logged action.executed.` };
}

/** The note still as planned, just before the write: Obsidian may have saved it meanwhile. */
export async function unchangedSince(plan: { file: string; real: string; baseHash: string | null }, dryRun: boolean): Promise<boolean> {
  const now = dryRun ? ((await readOrNull(plan.file)) ?? (await readOrNull(plan.real))) : await readOrNull(plan.real);
  return (now === null ? null : sha256(now)) === plan.baseHash;
}
