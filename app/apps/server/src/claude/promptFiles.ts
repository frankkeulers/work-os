import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PromptFileId } from '@work-os/shared';
import { DEFAULT_CONFLUENCE_ROUTING, DEFAULT_VAULT_CONVENTIONS } from './guidance';
import { DEFAULT_CONFLUENCE_PROMPT, DEFAULT_PEOPLE_CHECK_PROMPT, DEFAULT_TRIAGE_PROMPT, DEFAULT_VAULT_PROMPT, promptVersion, type Prompt } from './prompts';

// Every text file Claude calls read from config/ (FR-1.1, FR-1.7): the four prompts and the two
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
    description: 'Decides attention, filing suggestions and the summary for each thread.',
    usedBy: 'Triage and the eval',
    defaultText: DEFAULT_TRIAGE_PROMPT,
    previousDefaults: [],
  },
  {
    id: 'draft-vault',
    file: 'prompts/draft-vault.md',
    label: 'Draft vault note',
    description: 'Drafts a new note or an append for the Obsidian vault, reading the vault read-only.',
    usedBy: 'Draft vault note',
    defaultText: DEFAULT_VAULT_PROMPT,
    previousDefaults: ['e7eb3efd72a888f525ea0b05e750f9b3f2b1060c'], // draft-vault v1
  },
  {
    id: 'draft-confluence',
    file: 'prompts/draft-confluence.md',
    label: 'Draft Confluence entry',
    description: 'Drafts an entry for an allow-listed Confluence page, or declines when nothing fits.',
    usedBy: 'Draft Confluence entry',
    defaultText: DEFAULT_CONFLUENCE_PROMPT,
    previousDefaults: ['72bb329124bba27ca3c929afa7ee50baa7916c20'], // draft-confluence v1
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
    previousDefaults: [],
  },
  {
    id: 'confluence-routing',
    file: 'psg-context-builder.md',
    label: 'Confluence routing',
    description: 'Exclusion screen, attribution and where each kind of fact goes. From psg-context-builder.',
    usedBy: 'Draft Confluence entry',
    defaultText: DEFAULT_CONFLUENCE_ROUTING,
    previousDefaults: [],
  },
];

export const promptFile = (id: string): PromptFile | undefined => PROMPT_FILES.find((f) => f.id === id);

export const promptFilePath = (dataDir: string, f: PromptFile) => join(dataDir, 'config', f.file);

export const sha1 = (text: string) => createHash('sha1').update(text.trim()).digest('hex');

/** The file's text, or the built-in default if it is missing or empty. */
export async function readPromptFile(dataDir: string, f: PromptFile): Promise<Prompt> {
  const text = (await readFile(promptFilePath(dataDir, f), 'utf8').catch(() => '')).trim() || f.defaultText;
  return { text, version: promptVersion(text) };
}

export function loadPromptFile(dataDir: string, id: PromptFileId): Promise<Prompt> {
  const f = promptFile(id);
  if (!f) throw new Error(`Unknown prompt file ${id}`);
  return readPromptFile(dataDir, f);
}
