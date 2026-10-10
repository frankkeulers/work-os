import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Item, Me, Settings, VaultAppendDraft, VaultFiledDraft, VaultNewDraft } from '@work-os/shared';
import { z } from 'zod';
import type { ClaudeAdapter } from '../claude/adapter';
import type { Prompt } from '../claude/prompts';
import { DEADLINES } from '../net/http';
import { DraftError } from './errors';
import { threadForTriage } from '../pipeline/truncate';
import { findExistingNotes, type ExistingNote } from './vaultCandidates';
import { checkNotePath, insertUnderHeading, readOrNull, sha256, VaultPathError } from './vaultFiles';

// "Draft vault note" (FR-9.1, FR-9.2): Sonnet reads the thread and, read-only, the vault, then
// proposes a new note or an append under a heading. Code checks the proposal against the vault as
// it is now and records the file's hash, which the executor compares before writing (FR-9.4).
// Before the call, code lists the notes that may already hold this thread or meeting; the draft
// adds only what they lack, or answers "filed" when they lack nothing (FR-9.6).

export const VaultAnswer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new'), path: z.string().min(1), content: z.string().min(1) }),
  z.object({ kind: z.literal('append'), path: z.string().min(1), heading: z.string().min(1), content: z.string().min(1) }),
  z.object({ kind: z.literal('filed'), path: z.string().min(1), why: z.string().min(1) }),
]);

export const DRAFT_KEEP_LAST = 20; // more of the thread than triage sees: the note needs the detail

/** What a meeting's draft is told when its transcript couldn't be read (R2.7). */
export const TRANSCRIPT_MISSING = 'Not available: draft from the summary and notes.';

/** The thread as a draft sees it: more of it than triage, its permalink, and a meeting's transcript. */
export function draftThread(item: Item, me: Me, transcript?: string) {
  const thread = { ...threadForTriage(item, me, DRAFT_KEEP_LAST), permalink: item.permalink };
  return item.kind === 'meeting' ? { ...thread, transcript: transcript ?? TRANSCRIPT_MISSING } : thread;
}

export interface VaultDraftDeps {
  claude: ClaudeAdapter;
  settings: Settings;
  vaultRoot: string;
  prompt: Prompt;
  conventions: string;
  now: () => Date;
  signal?: AbortSignal;
  onTurn?: (usedTool: boolean) => void;
  /** A meeting's transcript, read live for this draft (R2.3). */
  transcript?: string;
  /** The links of the topic's pieces (itemLinks), which mark a note that already holds it (FR-9.6). */
  links: string[];
  /** In dry-run, <data>/sandbox/vault: its copies stand in for the vault notes, as in the executor. */
  sandboxRoot?: string;
}

export const vaultExists = (root: string) =>
  access(root).then(
    () => true,
    () => false,
  );

/** Who was in a meeting, by name, for the draft to recognise a note on it (FR-9.6). Frank is "me". */
const attendees = (item: Item, me: Me) => [...new Set(item.participants.map((p) => (p.id === me.id ? 'me' : p.name)))];

export function renderVaultRequest(item: Item, me: Me, conventions: string, now: Date, transcript?: string, existing: ExistingNote[] = []): string {
  const thread = { ...draftThread(item, me, transcript), ...(item.kind === 'meeting' && { attendees: attendees(item, me) }) };
  return [
    `Today: ${now.toISOString().slice(0, 10)}`,
    '<vault-conventions>',
    conventions.trim() || '(No conventions file yet: use plain folders, a short frontmatter with date and tags, and [[links]].)',
    '</vault-conventions>',
    '<thread>',
    JSON.stringify(thread),
    '</thread>',
    '<existing-notes>',
    existing.length ? existing.map((n) => JSON.stringify(n)).join('\n') : 'None found by source link, or for a meeting by date and attendees.',
    '</existing-notes>',
    'Draft the vault note. Answer with the JSON only.',
  ].join('\n');
}

export async function draftVaultNote(d: VaultDraftDeps, item: Item, me: Me): Promise<{ draft: VaultNewDraft | VaultAppendDraft | VaultFiledDraft; baseHash: string | null }> {
  const model = d.settings.models.draftVault;
  const t0 = performance.now();
  const existing = await findExistingNotes({ roots: [...(d.sandboxRoot ? [d.sandboxRoot] : []), d.vaultRoot], item, me, links: d.links });
  const r = await d.claude.structured(
    {
      purpose: 'draft_vault',
      model,
      system: d.prompt.text,
      prompt: renderVaultRequest(item, me, d.conventions, d.now(), d.transcript, existing),
      promptVersion: d.prompt.version,
      timeoutMs: DEADLINES.draft,
      signal: d.signal,
      itemIds: [item.id],
      maxTurns: 12,
      readOnly: { root: d.vaultRoot },
      onTurn: d.onTurn,
    },
    VaultAnswer,
  );
  const meta = {
    model,
    promptVersion: d.prompt.version,
    durationMs: Math.round(performance.now() - t0),
    tokens: r.usage.reduce((n, u) => n + u.inputTokens + u.outputTokens + u.cacheTokens, 0),
    edited: false,
  };
  const a = r.value;
  let path: string;
  try {
    path = await checkNotePath(d.vaultRoot, a.path);
  } catch (e) {
    if (e instanceof VaultPathError) throw new DraftError(e.message);
    throw e;
  }
  const current = (d.sandboxRoot ? await readOrNull(join(d.sandboxRoot, path)) : null) ?? (await readOrNull(join(d.vaultRoot, path)));
  if (a.kind === 'filed') {
    if (current === null) throw new DraftError(`The draft says ${path} already holds this, but there is no such note.`);
    return { draft: { kind: 'vault_filed', path, why: a.why.trim(), ...meta }, baseHash: null };
  }
  if (a.kind === 'new') {
    if (current !== null) throw new DraftError(`The draft would create ${path}, but that note already exists.`);
    // The backstop: a new note beside a strong match is shown with a warning, not blocked, as two
    // meetings with the same people on one day do happen.
    const strong = existing.filter((n) => n.strength === 'strong').map((n) => ({ path: n.path, why: n.why.join(', ') }));
    return { draft: { kind: 'vault_new', path, content: a.content, ...meta, ...(strong.length && { possibleDuplicates: strong }) }, baseHash: null };
  }
  if (current === null) throw new DraftError(`The draft would append to ${path}, but there is no such note.`);
  const ins = insertUnderHeading(current, a.heading, a.content);
  if (!ins) throw new DraftError(`The draft would append under “${a.heading}”, but ${path} has no such heading.`);
  return { draft: { kind: 'vault_append', path, heading: a.heading.trim(), context: ins.context, content: a.content, ...meta }, baseHash: sha256(current) };
}
