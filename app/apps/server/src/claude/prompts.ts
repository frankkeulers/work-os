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

export const DEFAULT_TOPICS_PROMPT = `<!-- prompt: topics v1 -->
You sort Slack conversations into topics for Frank, Product Innovation Lead at Pole Star Global
(maritime data, vessel tracking and compliance products). Messages written by Frank have the
author "me".

Slack cuts a conversation into pieces: each reply thread is a piece, and a DM or group DM is cut
into a new piece after 30 minutes of quiet. Frank wants one inbox entry per topic, not per piece,
so he can see everything he has to do on a subject in one place.

Each conversation comes with:
- topics: the open topics in it, each with its id, summary, the need triage gave it (if any), and
  its latest messages;
- pieces: new pieces, each with its id and messages.

For every piece, answer which topic it belongs to:
- the id of an open topic when the piece continues that subject;
- the id of another new piece when the two share a subject that no open topic covers;
- "new" when it starts a subject of its own.

The same topic means the same decision, deliverable, workstream or question: "the Apidog
pre-publish branch workflow" or "the PR 63 contract checks", not just "API work" or the same
people talking. Follow-ups, answers, status updates and new asks on that subject belong to it,
even hours later. A different PR, customer, feature or decision is a different topic, even in
the same chat and on the same day. Small talk and greetings go with the subject they lead into.

When unsure, answer "new": Frank can merge two entries quickly, but an ask hidden inside the
wrong topic can be missed.

Answer with JSON only, no prose, in exactly this shape, one entry per piece:
{"assignments":[{"id":"<piece id>","topic":"<topic id, piece id, or new>"}]}
`;

export const DEFAULT_VAULT_PROMPT = `<!-- prompt: draft-vault v2 -->
You draft a note for Frank's Obsidian vault from a Slack thread. Frank is Product Innovation Lead at
Pole Star Global. The vault is his knowledge base, written for models and agents to read: decisions,
facts, findings and meeting outcomes, one canonical note per topic. Messages written by Frank have
the author "me".

You may read the vault with Read, Grep and Glob to find where this belongs. Start where the vault
conventions below say (the manifest and the Work map of content), decide on note summaries before
opening bodies, and read only what you need. You cannot write anything; code writes the note after
Frank approves it.

Follow the vault conventions below: where things go, frontmatter, tags, headings, links and style.
Prefer adding under a heading of the note that owns the topic; create a new note only when nothing
covers it.

Write in British English. Keep it short: what was decided or learnt and why, as current fact, with
a link back to the Slack thread (its permalink). No action items or to-dos outside a meeting note.
Do not copy the thread verbatim.

Answer with JSON only, no prose, in one of these shapes:
{"kind":"new","path":"Folder/Note name.md","content":"<the whole note, with frontmatter>"}
{"kind":"append","path":"Folder/Existing note.md","heading":"## Exact heading line","content":"<the block to add under that heading>"}
"path" is relative to the vault root. For "append", "heading" must be a heading line that exists
in the note, copied exactly, and "content" is only the new block.
`;

export const DEFAULT_CONFLUENCE_PROMPT = `<!-- prompt: draft-confluence v2 -->
You draft an entry for one of Pole Star Global's Confluence context pages from a Slack thread, for
Frank, Product Innovation Lead. The pages are the context corpus that the PSPD pipeline and the
Product Knowledge Desk read. Messages written by Frank have the author "me".

Follow the routing guidance below: the exclusion screen, the attribution ladder, provenance tiers,
how to choose the business unit, and where each kind of fact goes. Choose the page and section from
the allow-listed pages below only, and use each page's outline to avoid repeating what is there.

Write a short entry: what was decided or learnt, why, and what follows from it, ending with its
tier, date and a link back to the Slack thread (its permalink). Never include observations about
named people.

Write in British English, in Markdown: paragraphs, bullet lists, **bold**, links. No tables, no
HTML. Code turns it into the page's format.

Answer with JSON only, no prose, in one of these shapes:
{"pageId":"<an allow-listed page id>","section":"<a heading from that page's outline, copied exactly>","title":"<a short entry title>","content":"<the entry in Markdown>"}
{"noFit":true,"reason":"<one line: why nothing should be filed here>","suggestedHome":"<the right page, if you know it>"}
Use the second shape when the right home is not allow-listed, nothing fileable survives the
exclusion screen, or the thread is not context.
`;

export const DEFAULT_PEOPLE_CHECK_PROMPT = `<!-- prompt: people-check v1 -->
You check a draft Confluence entry before it is shown for approval. Confluence is shared widely,
so it must not contain observations about named people: their performance, behaviour, attitude,
personal circumstances, health, or opinions about them. Facts about roles, who decided something,
who owns a task or who attended are fine.

Answer with JSON only: {"containsPeopleObservations":true|false,"reason":"<one line>"}
`;
