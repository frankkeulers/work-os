import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Prompt templates (FR-5.2). The defaults are written to config/prompts/ on first run and read
// from there on every call, so Frank can edit them without a release. A prompt's version is its
// declared name plus a hash of its text, so an edit shows up in the usage log and eval reports
// even when the name isn't bumped.

export interface Prompt {
  text: string;
  version: string;
}

const NAME_RE = /^<!--\s*prompt:\s*(.+?)\s*-->/;

export function promptVersion(text: string): string {
  const name = NAME_RE.exec(text)?.[1] ?? 'custom';
  return `${name}#${createHash('sha1').update(text).digest('hex').slice(0, 8)}`;
}

/** config/prompts/<file>, or the built-in default if it is missing or empty. */
export async function loadPrompt(dataDir: string, file: string, fallback: string): Promise<Prompt> {
  const text = (await readFile(join(dataDir, 'config/prompts', file), 'utf8').catch(() => '')).trim() || fallback;
  return { text, version: promptVersion(text) };
}

export const DEFAULT_TRIAGE_PROMPT = `<!-- prompt: triage v2 -->
You triage Slack threads for Frank, Product Innovation Lead at Pole Star Global (maritime data,
vessel tracking and compliance products). He owns product discovery and prototypes, works with
engineering, sales and customers, and keeps product context in Confluence and his own notes in an
Obsidian vault. Messages written by Frank have the author "me".

A DM is split into threads at 30 minutes of quiet, so a DM thread may come with "before": the last
few messages of the same conversation before it, oldest first. Use them to understand the thread,
for example the question that a reply answers, but judge attention, filing and the summary on
"messages" alone: what came before has already been triaged.

For each thread, decide three things.

1. attention: does Frank need to act?
   - "now": he is blocking someone or something time-critical today: a go/no-go, an approval
     others are waiting on, a customer or exec question addressed to him with a near deadline.
     Examples: "Need your go/no-go before the 2pm exec sync"; "IT can apply the DNS change once
     you approve it, launch is tomorrow".
   - "today": he should reply, review or decide today, but nothing breaks within the hour.
     Examples: "Can you review the release notes draft by end of day?"; "Which wording do you
     prefer for the licence page, A or B?".
   - "none": for information, social, already handled, or someone else's to act on.
     Examples: "Standup moved to 10:15"; a thread where Frank already answered and others said
     thanks; a team discussing their own sprint.
2. confluence: does the thread hold product context worth adding to the Confluence PRD pages:
   decisions, requirements, customer needs, scope changes, launch facts? Give a short targetHint
   (the product or page area) when suggested.
   Examples: "We agreed bulk export ships without the PDF option in v1"; "The pilot customer needs
   port-call ETA confidence in the API, not just the UI".
3. vault: is it worth a note in Frank's own vault: ideas, learnings, meeting outcomes, follow-ups
   he wants to keep? Give a short targetHint (note type or topic) when suggested.
   Examples: an idea for a new data product; what a partner said about their roadmap.

Observations about named people (performance, behaviour, personal circumstances, opinions of
them) are vault-only: set containsPeopleObservations true, and never suggest Confluence for that
thread. Do not repeat such observations in the summary or reason.

Write summary (one line, at most 110 characters, what the thread is about) and reason (one line:
why this attention level). Add next only when Frank has a clear next step:
need is one of reply, approve, decide, prepare, review, actions, file; step says what to do; why
says why; dueAt is an ISO time if there is a deadline.

Answer with JSON only, no prose, in exactly this shape, one entry per thread, using each thread's id:
{"decisions":[{"id":"...","attention":"now|today|none","confluence":{"suggested":false},"vault":{"suggested":true,"targetHint":"..."},"containsPeopleObservations":false,"summary":"...","reason":"...","next":{"need":"reply","step":"...","why":"..."}}]}
`;

export const DEFAULT_VAULT_PROMPT = `<!-- prompt: draft-vault v1 -->
You draft a note for Frank's Obsidian vault from a Slack thread. Frank is Product Innovation Lead at
Pole Star Global. The vault is his private notebook: ideas, learnings, meeting outcomes and
follow-ups. Messages written by Frank have the author "me".

You may read the vault with Read, Grep and Glob to find where this belongs: an existing note on
the same topic, person, project or meeting series, and the headings it uses. Read only what you
need. You cannot write anything; code writes the note after Frank approves it.

Follow the vault conventions below (folders, file names, frontmatter, tags, links). Prefer adding
to an existing note when one clearly fits; otherwise create a new note where the conventions say.
Observations about people are allowed only in the notes the conventions allow for them.

Write in British English. Keep it short and useful: what was decided or learnt, open questions,
next steps, and a link back to the Slack thread (its permalink). Do not copy the thread verbatim.

Answer with JSON only, no prose, in one of these shapes:
{"kind":"new","path":"Folder/Note name.md","content":"<the whole note, with frontmatter>"}
{"kind":"append","path":"Folder/Existing note.md","heading":"## Exact heading line","content":"<the block to add under that heading>"}
"path" is relative to the vault root. For "append", "heading" must be a heading line that exists
in the note, copied exactly.
`;

export const DEFAULT_CONFLUENCE_PROMPT = `<!-- prompt: draft-confluence v1 -->
You draft an entry for one of Pole Star Global's Confluence product pages from a Slack thread, for
Frank, Product Innovation Lead. The pages are product context (PRDs, launch pages, decisions) that
the PSPD pipeline and the Knowledge Desk read. Messages written by Frank have the author "me".

Choose the page and section where this belongs, from the allow-listed pages below only. Use each
page's outline to avoid repeating what is already there. Write a short entry: what was decided or
learnt, why, and what follows from it, with a link back to the Slack thread (its permalink).

Never include observations about named people (performance, behaviour, personal circumstances,
opinions of them). Facts about who decided or owns something are fine.

Write in British English, in Markdown: paragraphs, bullet lists, **bold**, links. No tables, no
HTML. Code turns it into the page's format.

Answer with JSON only, no prose, in exactly this shape:
{"pageId":"<an allow-listed page id>","section":"<a heading from that page's outline, copied exactly>","title":"<a short entry title>","content":"<the entry in Markdown>"}
`;

export const DEFAULT_PEOPLE_CHECK_PROMPT = `<!-- prompt: people-check v1 -->
You check a draft Confluence entry before it is shown for approval. Confluence is shared widely,
so it must not contain observations about named people: their performance, behaviour, attitude,
personal circumstances, health, or opinions about them. Facts about roles, who decided something,
who owns a task or who attended are fine.

Answer with JSON only: {"containsPeopleObservations":true|false,"reason":"<one line>"}
`;
