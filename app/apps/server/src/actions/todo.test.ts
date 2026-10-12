import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLineId, type TodoDraft } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StoredDraft } from '../store/drafts';
import { planTodoWrite, unchangedSince } from './todoExecutor';
import { writeVaultFile, type VaultTargets } from './vaultExecutor';
import { sha256 } from './vaultFiles';

// The to-do executor (UX-5) against a synthetic vault in a temp folder. Never the real vault.

let dir: string;
let t: VaultTargets;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workos-todo-'));
  t = { vaultRoot: join(dir, 'vault'), sandboxRoot: join(dir, 'sandbox/vault'), dryRun: false, today: '2026-10-06' };
  await mkdir(join(t.vaultRoot, 'Work'), { recursive: true });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const draft = (content: string, path = 'Work/Tasks.md'): TodoDraft => ({ kind: 'todo', path, content, model: 'code', promptVersion: 'todo v1', durationMs: 0, tokens: 0, edited: false });
const stored = (d: TodoDraft, over: Partial<StoredDraft> = {}): StoredDraft => ({ schemaVersion: 1, actionId: 'act-1', itemId: 'slack:C1:1', draft: d, ...over });
const NOTE = join('vault', 'Work/Tasks.md');

describe('planTodoWrite (UX-5)', () => {
  it('creates the note, then appends below what is there, and finishes an attempt cut short without repeating it', async () => {
    const d = draft('- [ ] One\n- [ ] Two');
    const first = await planTodoWrite(t, stored(d), d);
    // Each line with its id (E15, FR-16.1).
    expect(first).toMatchObject({ kind: 'write', isNew: true, content: `# Tasks\n\n${withLineId('- [ ] One', 'act-1')}\n${withLineId('- [ ] Two', 'act-1')}\n`, baseHash: null });
    if (first.kind !== 'write') return;
    await writeVaultFile(first);
    // Written, then a crash before it was logged: the next attempt finds it there.
    expect(await planTodoWrite(t, stored(d, { expectedHash: first.expectedHash }), d)).toMatchObject({ kind: 'already' });
    // Frank ticked one in Obsidian since (the Tasks plugin adds the date): still the same tasks, so nothing is added.
    await writeFile(join(dir, NOTE), '# Tasks\n\n- [ ] One\n- [x] Two ✅ 2026-10-06\n');
    expect(await planTodoWrite(t, stored(d, { expectedHash: first.expectedHash }), d)).toMatchObject({ kind: 'already' });

    const more = draft('- [ ] Three');
    const p = await planTodoWrite(t, stored(more), more);
    expect(p).toMatchObject({ kind: 'write', isNew: false, message: 'Added the to-do to Work/Tasks.md. Logged action.executed.' });
  });

  it('writes to the sandbox in dry-run, starting from the vault’s note, which stays as it was', async () => {
    await writeFile(join(dir, NOTE), '# Tasks\n\n- [ ] Old\n');
    const dry = { ...t, dryRun: true };
    const d = draft('- [ ] New');
    const p = await planTodoWrite(dry, stored(d), d);
    const added = `# Tasks\n\n- [ ] Old\n${withLineId('- [ ] New', 'act-1')}\n`;
    expect(p).toMatchObject({ kind: 'write', file: join(t.sandboxRoot, 'Work/Tasks.md'), content: added });
    if (p.kind !== 'write') return;
    expect(await unchangedSince(p, true)).toBe(true);
    await writeVaultFile(p);
    expect(await readFile(join(dir, NOTE), 'utf8')).toBe('# Tasks\n\n- [ ] Old\n');
    expect(await readFile(p.file, 'utf8')).toBe(added);
  });

  it('refuses a path outside the vault or in a hidden folder, and a to-do with no lines', async () => {
    for (const path of ['../Tasks.md', '.obsidian/Tasks.md', 'Work/Tasks.txt']) expect(await planTodoWrite(t, stored(draft('- [ ] x', path)), draft('- [ ] x', path))).toMatchObject({ kind: 'refused' });
    expect(await planTodoWrite(t, stored(draft(' \n ')), draft(' \n '))).toMatchObject({ kind: 'refused', message: 'The to-do has no lines, so nothing was written.' });
  });

  it('notices the note changed between planning and writing', async () => {
    await writeFile(join(dir, NOTE), '# Tasks\n');
    const d = draft('- [ ] New');
    const p = await planTodoWrite(t, stored(d), d);
    if (p.kind !== 'write') throw new Error('expected a write');
    expect(p.baseHash).toBe(sha256('# Tasks\n'));
    await writeFile(join(dir, NOTE), '# Tasks\n- [ ] Added in Obsidian\n');
    expect(await unchangedSince(p, false)).toBe(false);
  });
});
