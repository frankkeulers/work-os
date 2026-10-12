import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Item, Me, Settings, VaultAppendDraft, VaultFiledDraft, VaultMultiDraft, VaultNewDraft, VaultPart } from '@work-os/shared';
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
// adds only what they lack, or answers "filed" when they lack nothing (FR-9.6). A thread or meeting
// that spans topics files into several notes at once, each fact under the note that owns it (FR-9.7).

const NewAnswer = z.object({ kind: z.literal('new'), path: z.string().min(1), content: z.string().min(1) });
const AppendAnswer = z.object({ kind: z.literal('append'), path: z.string().min(1), heading: z.string().min(1), content: z.string().min(1) });
export const MAX_NOTES = 6; // the topics one meeting can sensibly feed; more is a sign the draft is scattering it

export const VaultAnswer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('notes'), notes: z.array(z.discriminatedUnion('kind', [AppendAnswer, NewAnswer])).min(1).max(MAX_NOTES) }),
  NewAnswer,
  AppendAnswer,
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
  /** Where triage suggested filing it (FR-15.4). */
  target?: string;
}

/** Where triage suggested filing it, by Frank's filing policy (FR-15.4): a hint for the drafter, never an instruction. */
export function filingTarget(target: string | undefined): string[] {
  const t = target?.trim();
  if (!t) return [];
  return ['<filing-target>', t, '</filing-target>', 'Triage suggested filing it there, by Frank’s filing policy. Prefer it when it fits what you find; it is a hint, not an instruction.'];
}

export const vaultExists = (root: string) =>
  access(root).then(
    () => true,
    () => false,
  );

/** Who was in a meeting, by name, for the draft to recognise a note on it (FR-9.6). Frank is "me". */
const attendees = (item: Item, me: Me) => [...new Set(item.participants.map((p) => (p.id === me.id ? 'me' : p.name)))];

export function renderVaultRequest(item: Item, me: Me, conventions: string, now: Date, transcript?: string, existing: ExistingNote[] = [], target?: string): string {
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
    ...filingTarget(target),
    'Draft the vault note. Answer with the JSON only.',
  ].join('\n');
}

export async function draftVaultNote(d: VaultDraftDeps, item: Item, me: Me): Promise<{ draft: VaultNewDraft | VaultAppendDraft | VaultMultiDraft | VaultFiledDraft; baseHash?: string | null; baseHashes?: Record<string, string | null> }> {
  const model = d.settings.models.draftVault;
  const t0 = performance.now();
  const existing = await findExistingNotes({ roots: [...(d.sandboxRoot ? [d.sandboxRoot] : []), d.vaultRoot], item, me, links: d.links, skip: [d.settings.tasksNote] });
  const r = await d.claude.structured(
    {
      purpose: 'draft_vault',
      model,
      system: d.prompt.text,
      prompt: renderVaultRequest(item, me, d.conventions, d.now(), d.transcript, existing, d.target),
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
  const notePath = (p: string) =>
    checkNotePath(d.vaultRoot, p).catch((e: unknown) => Promise.reject(e instanceof VaultPathError ? new DraftError(e.message) : e));
  const read = async (path: string) => (d.sandboxRoot ? await readOrNull(join(d.sandboxRoot, path)) : null) ?? (await readOrNull(join(d.vaultRoot, path)));
  if (a.kind === 'filed') {
    const path = await notePath(a.path);
    if ((await read(path)) === null) throw new DraftError(`The draft says ${path} already holds this, but there is no such note.`);
    return { draft: { kind: 'vault_filed', path, why: a.why.trim(), ...meta }, baseHash: null };
  }

  // Each note as it is now, and as the parts before change it: two appends to one note land in turn.
  const answers = a.kind === 'notes' ? a.notes : [a];
  const base = new Map<string, string | null>();
  const working = new Map<string, string>();
  const parts: VaultPart[] = [];
  for (const p of answers) {
    const path = await notePath(p.path);
    if (!base.has(path)) base.set(path, await read(path));
    const current = base.get(path)!;
    if (p.kind === 'new') {
      if (current !== null) throw new DraftError(`The draft would create ${path}, but that note already exists.`);
      if (working.has(path)) throw new DraftError(`The draft writes ${path} twice.`);
      working.set(path, p.content);
      parts.push({ kind: 'new', path, content: p.content });
      continue;
    }
    if (current === null) throw new DraftError(`The draft would append to ${path}, but there is no such note.`);
    const ins = insertUnderHeading(working.get(path) ?? current, p.heading, p.content);
    if (!ins) throw new DraftError(`The draft would append under “${p.heading}”, but ${path} has no such heading.`);
    working.set(path, ins.content);
    parts.push({ kind: 'append', path, heading: p.heading.trim(), context: ins.context, content: p.content });
  }

  // The backstop: a new note beside a strong match is shown with a warning, not blocked, as two
  // meetings with the same people on one day do happen. A match the draft adds to is no warning.
  const strong = existing.filter((n) => n.strength === 'strong' && !base.has(n.path)).map((n) => ({ path: n.path, why: n.why.join(', ') }));
  const dupes = parts.some((p) => p.kind === 'new') && strong.length ? { possibleDuplicates: strong } : {};
  if (parts.length > 1) {
    const baseHashes = Object.fromEntries([...base].map(([path, text]) => [path, text === null ? null : sha256(text)]));
    return { draft: { kind: 'vault_multi', parts, ...meta, ...dupes }, baseHashes };
  }
  const [p] = parts;
  if (p.kind === 'new') return { draft: { kind: 'vault_new', path: p.path, content: p.content, ...meta, ...dupes }, baseHash: null };
  return { draft: { ...p, kind: 'vault_append', ...meta }, baseHash: sha256(base.get(p.path)!) };
}
