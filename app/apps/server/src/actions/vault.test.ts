import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readVerdict } from '../claude/readGuard';
import type { StoredDraft } from '../store/drafts';
import { planVaultWrite, writeVaultFile, type VaultPlan } from './vaultExecutor';
import { checkNotePath, insertUnderHeading, sha256, touchUpdated } from './vaultFiles';

// The vault side of FR-9.x against a synthetic vault in a temp folder: where a note may go, how an
// append lands, and the executor's reconciliation (FR-9.4, FR-14.5). Never the real vault.

let dir: string;
let vault: string;
let sandbox: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workos-vault-'));
  vault = join(dir, 'vault');
  sandbox = join(dir, 'sandbox/vault');
  await mkdir(join(vault, 'Projects'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const NOTE = '---\ntags: [mvi]\n---\n# MVI V2\n\n## Decisions\n\n- Ship bulk export first.\n\n## Open questions\n\n- Pricing?\n';
const meta = { model: 'sonnet-5.5', promptVersion: 'draft-vault v1#00000000', durationMs: 1, tokens: 1, edited: false };
const appendDraft = (baseHash: string | null): StoredDraft => ({
  schemaVersion: 1,
  actionId: 'act-1',
  itemId: 'slack:C1:1.0',
  draft: { kind: 'vault_append', path: 'Projects/MVI V2.md', heading: '## Decisions', context: [], content: '- Licence wording agreed with legal.', ...meta },
  baseHash,
});
const newDraft = (): StoredDraft => ({ schemaVersion: 1, actionId: 'act-2', itemId: 'slack:C1:1.0', draft: { kind: 'vault_new', path: 'Inbox/Launch.md', content: '# Launch\n', ...meta }, baseHash: null });
const write = (p: VaultPlan) => {
  if (p.kind !== 'write') throw new Error(`expected a write, got ${p.kind}`);
  return writeVaultFile(p).then(() => p);
};

describe('insertUnderHeading', () => {
  it('adds the block at the end of the section, before the next heading', () => {
    const r = insertUnderHeading(NOTE, '## Decisions', '- Licence wording agreed.')!;
    expect(r.content).toBe('---\ntags: [mvi]\n---\n# MVI V2\n\n## Decisions\n\n- Ship bulk export first.\n\n- Licence wording agreed.\n\n## Open questions\n\n- Pricing?\n');
    expect(r.context).toEqual(['# MVI V2', '## Decisions', '- Ship bulk export first.']);
  });

  it('appends to the last section and keeps the final newline; a missing heading is undefined', () => {
    expect(insertUnderHeading(NOTE, '## Open questions', '- Who signs off?')!.content.endsWith('- Pricing?\n\n- Who signs off?\n')).toBe(true);
    expect(insertUnderHeading(NOTE, '## Actions', 'x')).toBeUndefined();
  });
});

describe('touchUpdated', () => {
  it('sets an existing updated: line in the frontmatter, and leaves everything else alone', () => {
    const note = '---\ntype: note\ncreated: 2026-06-01\nupdated: 2026-09-30\n---\n# X\n\nupdated: 2020-01-01 in the body\n';
    expect(touchUpdated(note, '2026-10-07')).toBe('---\ntype: note\ncreated: 2026-06-01\nupdated: 2026-10-07\n---\n# X\n\nupdated: 2020-01-01 in the body\n');
    expect(touchUpdated(NOTE, '2026-10-07')).toBe(NOTE); // no updated: line, so none is added
    expect(touchUpdated('# No frontmatter\nupdated: 2020-01-01\n', '2026-10-07')).toBe('# No frontmatter\nupdated: 2020-01-01\n');
  });
});

describe('note paths', () => {
  it('accepts a Markdown path inside the vault and refuses the rest', async () => {
    expect(await checkNotePath(vault, './Projects/MVI V2.md')).toBe('Projects/MVI V2.md');
    for (const bad of ['/etc/x.md', '../x.md', 'Projects/../../x.md', 'Projects/x.txt', '.obsidian/x.md', 'Projects/.trash/x.md']) {
      await expect(checkNotePath(vault, bad), bad).rejects.toThrow();
    }
  });

  it('refuses a symlink that leads out of the vault', async () => {
    await mkdir(join(dir, 'outside'));
    await symlink(join(dir, 'outside'), join(vault, 'Link'));
    await expect(checkNotePath(vault, 'Link/x.md')).rejects.toThrow(/outside the vault/);
    expect(await readVerdict(vault, 'Read', { file_path: join(vault, 'Link/x.md') })).toMatchObject({ ok: false });
  });
});

describe('read guard', () => {
  it('allows reading inside the vault only', async () => {
    expect(await readVerdict(vault, 'Read', { file_path: join(vault, 'Projects/a.md') })).toEqual({ ok: true });
    expect(await readVerdict(vault, 'Glob', { pattern: '**/*.md' })).toEqual({ ok: true });
    expect(await readVerdict(vault, 'Grep', { pattern: 'x', path: 'Projects', glob: '*.md' })).toEqual({ ok: true });
    expect(await readVerdict(vault, 'Read', { file_path: join(dir, 'secret.md') })).toMatchObject({ ok: false });
    expect(await readVerdict(vault, 'Glob', { pattern: '../**' })).toMatchObject({ ok: false });
    expect(await readVerdict(vault, 'Grep', { pattern: 'x', glob: '/etc/*' })).toMatchObject({ ok: false });
    expect(await readVerdict(vault, 'Write', { file_path: join(vault, 'a.md') })).toMatchObject({ ok: false });
  });
});

describe('vault executor (FR-9.4, FR-14.5)', () => {
  const real = { vaultRoot: () => vault, sandboxRoot: () => sandbox };
  const targets = (dryRun: boolean) => ({ vaultRoot: real.vaultRoot(), sandboxRoot: real.sandboxRoot(), dryRun, today: '2026-10-07' });

  it('appends when the note is as drafted, then sees its own write as already done', async () => {
    await writeFile(join(vault, 'Projects/MVI V2.md'), NOTE);
    const stored = appendDraft(sha256(NOTE));
    const plan = await write(await planVaultWrite(targets(false), stored));
    expect(await readFile(join(vault, 'Projects/MVI V2.md'), 'utf8')).toContain('- Licence wording agreed with legal.');
    expect(await planVaultWrite(targets(false), { ...stored, expectedHash: plan.expectedHash })).toMatchObject({ kind: 'already' });
  });

  it('bumps the note’s updated: date when it appends', async () => {
    const dated = NOTE.replace('tags: [mvi]\n', 'tags: [mvi]\nupdated: 2026-09-01\n');
    await writeFile(join(vault, 'Projects/MVI V2.md'), dated);
    await write(await planVaultWrite(targets(false), appendDraft(sha256(dated))));
    const text = await readFile(join(vault, 'Projects/MVI V2.md'), 'utf8');
    expect(text).toMatch(/^---\ntags: \[mvi\]\nupdated: 2026-10-07\n---/);
    expect(text).toContain('- Licence wording agreed with legal.');
  });

  it('re-drafts instead of writing when the note changed after drafting', async () => {
    await writeFile(join(vault, 'Projects/MVI V2.md'), `${NOTE}\nEdited in Obsidian.\n`);
    expect(await planVaultWrite(targets(false), appendDraft(sha256(NOTE)))).toMatchObject({ kind: 'conflict', message: expect.stringMatching(/changed after drafting/) });
  });

  it('creates a new note, and never overwrites one that appeared', async () => {
    const plan = await write(await planVaultWrite(targets(false), newDraft()));
    expect(await readFile(join(vault, 'Inbox/Launch.md'), 'utf8')).toBe('# Launch\n');
    expect(await planVaultWrite(targets(false), newDraft())).toMatchObject({ kind: 'conflict' });
    await expect(writeVaultFile(plan)).rejects.toThrow(/appeared/);
  });

  it('writes to the sandbox in dry-run and leaves the vault alone', async () => {
    await writeFile(join(vault, 'Projects/MVI V2.md'), NOTE);
    const plan = await write(await planVaultWrite(targets(true), appendDraft(sha256(NOTE))));
    expect(plan.file).toBe(join(sandbox, 'Projects/MVI V2.md'));
    expect(plan.message).toMatch(/^Dry-run: Appended under ## Decisions in /);
    expect(await readFile(join(vault, 'Projects/MVI V2.md'), 'utf8')).toBe(NOTE);
    expect(await readFile(plan.file, 'utf8')).toContain('- Licence wording agreed with legal.');
    // The sandbox copy now stands in for the vault: a second draft from the old base conflicts.
    expect(await planVaultWrite(targets(true), { ...appendDraft(sha256(NOTE)), actionId: 'act-3' })).toMatchObject({ kind: 'conflict' });
  });

  it('refuses a draft whose path is outside the vault', async () => {
    const stored = { ...newDraft(), draft: { ...newDraft().draft!, path: '../escape.md' } } as StoredDraft;
    expect(await planVaultWrite(targets(false), stored)).toMatchObject({ kind: 'refused' });
  });

  it('writes nothing for a draft that found its content already filed, and re-drafts if that note is gone (FR-9.6)', async () => {
    const filed: StoredDraft = { schemaVersion: 1, actionId: 'act-4', itemId: 'wispr:m1', draft: { kind: 'vault_filed', path: 'Projects/MVI V2.md', why: 'Already holds the meeting.', ...meta }, baseHash: null };
    await writeFile(join(vault, 'Projects/MVI V2.md'), NOTE);
    for (const dry of [false, true]) {
      expect(await planVaultWrite(targets(dry), filed)).toEqual({ kind: 'filed', file: join(vault, 'Projects/MVI V2.md'), message: 'Already in the vault: Projects/MVI V2.md. Nothing was written. Logged action.executed.' });
    }
    expect(await readFile(join(vault, 'Projects/MVI V2.md'), 'utf8')).toBe(NOTE);
    await rm(join(vault, 'Projects/MVI V2.md'));
    expect(await planVaultWrite(targets(false), filed)).toMatchObject({ kind: 'conflict', message: expect.stringMatching(/no longer exists/) });
  });
});
