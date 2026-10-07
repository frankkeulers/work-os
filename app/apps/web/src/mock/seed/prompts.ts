import type { PromptFileId } from '@work-os/shared';

// The six prompt and guidance files, as the mock serves them in Settings › Prompts (FR-1.7).
// Shortened stand-ins for the server's built-in defaults: the shape matters here, not the wording.

export interface SeedPromptFile {
  id: PromptFileId;
  label: string;
  description: string;
  usedBy: string;
  path: string;
  defaultText: string;
}

export const SEED_PROMPT_FILES: SeedPromptFile[] = [
  {
    id: 'triage',
    label: 'Triage',
    description: 'Decides attention, filing suggestions and the summary for each thread.',
    usedBy: 'Triage and the eval',
    path: 'config/prompts/triage.md',
    defaultText: `<!-- prompt: triage v2 -->
You triage Slack threads for Frank, Product Innovation Lead at Pole Star Global.

For each thread, decide three things.

1. attention: does Frank need to act? "now", "today" or "none".
2. confluence: does the thread hold product context worth adding to the Confluence PRD pages?
3. vault: is it worth a note in Frank's own vault?

Answer with JSON only, no prose.`,
  },
  {
    id: 'draft-vault',
    label: 'Draft vault note',
    description: 'Drafts a new note or an append for the Obsidian vault, reading the vault read-only.',
    usedBy: 'Draft vault note',
    path: 'config/prompts/draft-vault.md',
    defaultText: `<!-- prompt: draft-vault v2 -->
You draft a note for Frank's Obsidian vault from a Slack thread.

You may read the vault with Read, Grep and Glob to find where this belongs. Follow the vault
conventions below. Prefer adding under a heading of the note that owns the topic.

Answer with JSON only, no prose.`,
  },
  {
    id: 'draft-confluence',
    label: 'Draft Confluence entry',
    description: 'Drafts an entry for an allow-listed Confluence page, or declines when nothing fits.',
    usedBy: 'Draft Confluence entry',
    path: 'config/prompts/draft-confluence.md',
    defaultText: `<!-- prompt: draft-confluence v2 -->
You draft an entry for one of Pole Star Global's Confluence context pages from a Slack thread.

Follow the routing guidance below. Choose the page and section from the allow-listed pages only.

Answer with JSON only, no prose.`,
  },
  {
    id: 'people-check',
    label: 'People check',
    description: 'Checks a Confluence draft for observations about named people before it is shown.',
    usedBy: 'Draft Confluence entry',
    path: 'config/prompts/people-check.md',
    defaultText: `<!-- prompt: people-check v1 -->
You check a draft Confluence entry before it is shown for approval. It must not contain
observations about named people.

Answer with JSON only: {"containsPeopleObservations":true|false,"reason":"<one line>"}`,
  },
  {
    id: 'vault-conventions',
    label: 'Vault conventions',
    description: 'Where notes go in the vault, frontmatter, tags and style. From the vault’s Notes System note.',
    usedBy: 'Draft vault note',
    path: 'config/vault-conventions.md',
    defaultText: `<!-- prompt: vault-conventions v1 -->
# Frank's vault: how to file a note

## Finding the right note
1. "llms.txt" at the root is the manifest. "Home.md" leads to "Work/Work.md".
2. Use each note's frontmatter "summary" and "tags" to decide what to open.

## What to capture
Decisions and their reasons, facts that stay true beyond this week. No action items.`,
  },
  {
    id: 'confluence-routing',
    label: 'Confluence routing',
    description: 'Exclusion screen, attribution and where each kind of fact goes. From psg-context-builder.',
    usedBy: 'Draft Confluence entry',
    path: 'config/psg-context-builder.md',
    defaultText: `<!-- prompt: confluence-routing v1 -->
# Filing into the PSG context corpus

## The exclusion screen (silent, no exceptions)
There is no destination for information about people.

## Where a fact goes
- Pricing, charging unit, discounting → "<BU> - Pricing".
- A settled decision → "<BU> - Decisions & Open Questions".`,
  },
];
