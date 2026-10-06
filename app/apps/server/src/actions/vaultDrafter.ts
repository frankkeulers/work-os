import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Item, Me, Settings, VaultAppendDraft, VaultNewDraft } from '@work-os/shared';
import { z } from 'zod';
import type { ClaudeAdapter } from '../claude/adapter';
import type { Prompt } from '../claude/prompts';
import { DEADLINES } from '../net/http';
import { DraftError } from './errors';
import { threadForTriage } from '../pipeline/truncate';
import { checkNotePath, insertUnderHeading, readOrNull, sha256, VaultPathError } from './vaultFiles';

// "Draft vault note" (FR-9.1, FR-9.2): Sonnet reads the thread and, read-only, the vault, then
// proposes a new note or an append under a heading. Code checks the proposal against the vault as
// it is now and records the file's hash, which the executor compares before writing (FR-9.4).

export const VaultAnswer = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new'), path: z.string().min(1), content: z.string().min(1) }),
  z.object({ kind: z.literal('append'), path: z.string().min(1), heading: z.string().min(1), content: z.string().min(1) }),
]);

export const DRAFT_KEEP_LAST = 20; // more of the thread than triage sees: the note needs the detail

export interface VaultDraftDeps {
  claude: ClaudeAdapter;
  settings: Settings;
  vaultRoot: string;
  prompt: Prompt;
  conventions: string;
  now: () => Date;
  signal?: AbortSignal;
  onTurn?: (usedTool: boolean) => void;
}

export const vaultExists = (root: string) =>
  access(root).then(
    () => true,
    () => false,
  );

export function renderVaultRequest(item: Item, me: Me, conventions: string, now: Date): string {
  const thread = { ...threadForTriage(item, me, DRAFT_KEEP_LAST), permalink: item.permalink };
  return [
    `Today: ${now.toISOString().slice(0, 10)}`,
    '<vault-conventions>',
    conventions.trim() || '(No conventions file yet: use plain folders, a short frontmatter with date and tags, and [[links]].)',
    '</vault-conventions>',
    '<thread>',
    JSON.stringify(thread),
    '</thread>',
    'Draft the vault note. Answer with the JSON only.',
  ].join('\n');
}

export async function draftVaultNote(d: VaultDraftDeps, item: Item, me: Me): Promise<{ draft: VaultNewDraft | VaultAppendDraft; baseHash: string | null }> {
  const model = d.settings.models.draftVault;
  const t0 = performance.now();
  const r = await d.claude.structured(
    {
      purpose: 'draft_vault',
      model,
      system: d.prompt.text,
      prompt: renderVaultRequest(item, me, d.conventions, d.now()),
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
  const current = await readOrNull(join(d.vaultRoot, path));
  if (a.kind === 'new') {
    if (current !== null) throw new DraftError(`The draft would create ${path}, but that note already exists.`);
    return { draft: { kind: 'vault_new', path, content: a.content, ...meta }, baseHash: null };
  }
  if (current === null) throw new DraftError(`The draft would append to ${path}, but there is no such note.`);
  const ins = insertUnderHeading(current, a.heading, a.content);
  if (!ins) throw new DraftError(`The draft would append under “${a.heading}”, but ${path} has no such heading.`);
  return { draft: { kind: 'vault_append', path, heading: a.heading.trim(), context: ins.context, content: a.content, ...meta }, baseHash: sha256(current) };
}
