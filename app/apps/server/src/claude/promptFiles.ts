import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PromptFileId, PromptFileView, PromptSourceView } from '@work-os/shared';
import { writeFileAtomic } from '../store/atomic';
import { DEFAULT_CONFLUENCE_ROUTING, DEFAULT_VAULT_CONVENTIONS } from './guidance';
import { DEFAULT_CONFLUENCE_PROMPT, DEFAULT_PEOPLE_CHECK_PROMPT, DEFAULT_PICK_CONFLUENCE_PROMPT, DEFAULT_TOPICS_PROMPT, DEFAULT_TRIAGE_PROMPT, DEFAULT_VAULT_PROMPT, promptVersion, type Prompt } from './prompts';

// Every text file Claude calls read from config/ (FR-1.1, FR-1.7): the six prompts and the two
// filing guidance files. Each is written on first run, read on every call (empty or missing → the
// built-in default) and editable in Settings. A file that still holds an earlier built-in default,
// byte for byte once trimmed, is replaced by the current one at start; an edited file is left alone.

export interface PromptFile {
  id: PromptFileId;
  /** Relative to the data directory's config/ folder. */
  file: string;
  label: string;
  description: string;
  usedBy: string;
  defaultText: string;
  /** sha1 of earlier built-in defaults (trimmed), replaced by defaultText at start. */
  previousDefaults: string[];
}

export const PROMPT_FILES: readonly PromptFile[] = [
  {
    id: 'triage',
    file: 'prompts/triage.md',
    label: 'Triage',
    description: 'Decides attention, filing suggestions, the summary and the open asks for each topic.',
    usedBy: 'Triage and the eval',
    defaultText: DEFAULT_TRIAGE_PROMPT,
    previousDefaults: ['a41e4946bcba81f2eb1f14d307bf3625e34eb550', 'd4b00d127a3dd9605964c0b44ac43c7967894f3f', '149c84e01c7eadef74a9eda6cfbf1994536706bc', '92c1953b699525b35e2b3e63ac1a4558852ea085', '74c0880ee869f2ab4326c4f48cffc45a2b46a514'], // triage v2, v3, v4, v5, v6
  },
  {
    id: 'topics',
    file: 'prompts/topics.md',
    label: 'Topics',
    description: 'Puts each new thread or stretch of chat in the open topic it continues, or starts a new one.',
    usedBy: 'Topic routing and Regroup',
    defaultText: DEFAULT_TOPICS_PROMPT,
    previousDefaults: [],
  },
  {
    id: 'draft-vault',
    file: 'prompts/draft-vault.md',
    label: 'Draft vault note',
    description: 'Drafts a new note or an append for the Obsidian vault, reading the vault read-only.',
    usedBy: 'Draft vault note',
    defaultText: DEFAULT_VAULT_PROMPT,
    previousDefaults: ['e7eb3efd72a888f525ea0b05e750f9b3f2b1060c', 'dfa8657114bbe2a91c2bbdecf3c5cceb34d6200a'], // draft-vault v1, v2
  },
  {
    id: 'pick-confluence',
    file: 'prompts/pick-confluence.md',
    label: 'Pick Confluence page',
    description: 'Picks up to three candidate pages from the live Confluence catalogue, or declines when nothing fits.',
    usedBy: 'Draft Confluence entry',
    defaultText: DEFAULT_PICK_CONFLUENCE_PROMPT,
    previousDefaults: ['a59eb4aa2de26d243f521deabe060055485ec849'], // pick-confluence v1
  },
  {
    id: 'draft-confluence',
    file: 'prompts/draft-confluence.md',
    label: 'Draft Confluence entry',
    description: 'Drafts an entry for one of the picked Confluence pages, or declines when none fits.',
    usedBy: 'Draft Confluence entry',
    defaultText: DEFAULT_CONFLUENCE_PROMPT,
    previousDefaults: ['72bb329124bba27ca3c929afa7ee50baa7916c20', '4b97acd122e6f9a3cee48ea30d36baa1854a88b3', '3ca183c57f1c9a9b7d4947e27635de168a942cc5'], // draft-confluence v1, v2, v3
  },
  {
    id: 'people-check',
    file: 'prompts/people-check.md',
    label: 'People check',
    description: 'Checks a Confluence draft for observations about named people before it is shown.',
    usedBy: 'Draft Confluence entry',
    defaultText: DEFAULT_PEOPLE_CHECK_PROMPT,
    previousDefaults: [],
  },
  {
    id: 'vault-conventions',
    file: 'vault-conventions.md',
    label: 'Vault conventions',
    description: 'Where notes go in the vault, frontmatter, tags and style. From the vault’s Notes System note.',
    usedBy: 'Draft vault note',
    defaultText: DEFAULT_VAULT_CONVENTIONS,
    previousDefaults: ['898d14c3e478bd5da0c0143ca15980cc985e38f9'], // vault-conventions v1
  },
  {
    id: 'confluence-routing',
    file: 'psg-context-builder.md',
    label: 'Confluence routing',
    description: 'Exclusion screen, attribution and where each kind of fact goes. From psg-context-builder.',
    usedBy: 'Draft Confluence entry',
    defaultText: DEFAULT_CONFLUENCE_ROUTING,
    previousDefaults: ['bfd61af35ae154733721f70fa0b6bdd2080d9bcb', 'd2c97596843982fb215760ec923365300849c31f'], // confluence-routing v1, v2
  },
];

export const promptFile = (id: string): PromptFile | undefined => PROMPT_FILES.find((f) => f.id === id);

export const promptFilePath = (dataDir: string, f: PromptFile) => join(dataDir, 'config', f.file);

export const sha1 = (text: string) => createHash('sha1').update(text.trim()).digest('hex');

/** The file's text, or the built-in default if it is missing or empty. */
export async function readPromptFile(dataDir: string, f: PromptFile): Promise<Prompt> {
  const text = (await readFile(promptFilePath(dataDir, f), 'utf8').catch(() => '')).trim() || f.defaultText.trim();
  return { text, version: promptVersion(text) };
}

export function loadPromptFile(dataDir: string, id: PromptFileId): Promise<Prompt> {
  const f = promptFile(id);
  if (!f) throw new Error(`Unknown prompt file ${id}`);
  return readPromptFile(dataDir, f);
}

// ---------------------------------------------------------------- sources (FR-1.7)

/** Where the sources live: the home folder (for ~/.claude/skills) and the vault. */
export interface SourceEnv {
  home: string;
  vault: string;
}

const exists = (p: string) =>
  access(p).then(
    () => p,
    () => null,
  );

/** An installed skill: ~/.claude/skills/<name>, or a synced copy under ~/.claude/skills/synced/<id>/<name>. */
async function skillFile(home: string, name: string): Promise<string | null> {
  const direct = await exists(join(home, '.claude/skills', name, 'SKILL.md'));
  if (direct) return direct;
  const synced = join(home, '.claude/skills/synced');
  for (const id of (await readdir(synced).catch(() => [])).sort()) {
    const found = await exists(join(synced, id, name, 'SKILL.md'));
    if (found) return found;
  }
  return null;
}

const SOURCES: Record<string, { label: string; find: (e: SourceEnv) => Promise<string | null> }> = {
  'psg-context-builder': { label: 'psg-context-builder skill', find: (e) => skillFile(e.home, 'psg-context-builder') },
  'obsidian-vault-reader': { label: 'obsidian-vault-reader skill', find: (e) => skillFile(e.home, 'obsidian-vault-reader') },
  'vault-notes-system': { label: 'Notes System note in the vault', find: (e) => exists(join(e.vault, 'Notes System — Project Instructions.md')) },
  'vault-llms': { label: 'llms.txt in the vault', find: (e) => exists(join(e.vault, 'llms.txt')) },
};

const SOURCE_RE = /^<!--\s*source:\s*(\S+)\s+sha1:([0-9a-f]{6,40})\s*-->$/gm;
const short = (text: string) => sha1(text).slice(0, 12);

/** The sources a file's header names, each compared with the file as it is now. */
export async function sourceStates(text: string, env: SourceEnv): Promise<PromptSourceView[]> {
  const out: PromptSourceView[] = [];
  for (const [, id, recorded] of text.matchAll(SOURCE_RE)) {
    const src = SOURCES[id];
    const path = src ? await src.find(env) : null;
    const now = path ? await readFile(path, 'utf8').then(short, () => null) : null;
    out.push({ id, label: src?.label ?? id, path: path ?? undefined, state: now === null ? 'missing' : now.startsWith(recorded) || recorded.startsWith(now) ? 'current' : 'changed' });
  }
  return out;
}

/** The text with each source line's hash set to the source as it is now ("Mark reviewed"). */
export async function withCurrentSourceHashes(text: string, env: SourceEnv): Promise<string> {
  const now: Record<string, string> = {};
  for (const [, id] of text.matchAll(SOURCE_RE)) {
    const path = SOURCES[id] ? await SOURCES[id].find(env) : null;
    const t = path ? await readFile(path, 'utf8').catch(() => null) : null;
    if (t !== null) now[id] = short(t);
  }
  return text.replace(SOURCE_RE, (line: string, id: string) => (now[id] ? `<!-- source: ${id} sha1:${now[id]} -->` : line));
}

/** What Settings shows for a file (FR-1.7): the text calls use now, its version, whether it is edited, and its sources. */
export async function promptFileView(dataDir: string, f: PromptFile, env?: SourceEnv): Promise<PromptFileView> {
  const p = await readPromptFile(dataDir, f);
  return {
    id: f.id,
    label: f.label,
    description: f.description,
    usedBy: f.usedBy,
    path: `config/${f.file}`,
    text: p.text,
    version: p.version,
    defaultVersion: promptVersion(f.defaultText.trim()),
    edited: sha1(p.text) !== sha1(f.defaultText),
    sources: env ? await sourceStates(p.text, env) : [],
  };
}

/** Writes the file (owner-only, atomic). The next Claude call reads it; nothing needs a restart. */
export async function writePromptFile(dataDir: string, f: PromptFile, text: string): Promise<void> {
  await writeFileAtomic(promptFilePath(dataDir, f), `${text.trim()}\n`);
}
