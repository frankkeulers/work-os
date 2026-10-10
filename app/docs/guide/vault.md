---
title: Filing to the vault
group: Filing
order: 60
summary: Notes for your Obsidian vault, drafted to follow its conventions.
updated: 2026-10-10
---

Choose **Draft vault note** on an item. Claude reads your vault, read-only, to find where the
thread belongs, then drafts either:

- **an append** under a heading of the note that already owns the topic (preferred), or
- **a new note**, with front matter, tags from your tag taxonomy and a summary.

The draft follows the vault conventions: where notes live, front matter, tags, and what to keep
(decisions and facts that stay true) or leave out (action items and transient status).

## Already in the vault

Before Claude drafts, Work OS looks for notes that may already hold the thread or meeting:

- a note that links to it, on any day;
- for a meeting, a note dated the same day that names someone who was there. This catches a
  meeting filed from another recording (Plaud, Teams, a pasted summary) under another title.

Claude opens each one. If one already holds the meeting or thread, the draft is an append of only
what that note lacks, with the new recording's link as a second source. If it lacks nothing, the
panel shows **Already filed**, with the note and why; **Mark as filed** writes nothing and counts
as filed.

If Claude still drafts a new note while a likely match exists, the panel warns **This may already
be in the vault**, with a link to the note. Choose **Re-draft** to add to it instead, or approve
the new note anyway: two meetings with the same person on one day do happen.

## The conventions file

The conventions are a file you can edit in [Settings › Prompts](/settings/prompts): **Vault
conventions**. It is distilled from your vault's Notes System note, its `llms.txt` and the
obsidian-vault-reader skill. When one of those changes, the file is marked **Source changed**;
see [Prompts and guidance](prompts.md#source-changed).

The vault path is set in [Settings › Write targets](/settings/writing).

## Approving and writing

Review the draft, edit it if you like, and approve. The draft shows as formatted text; switch to
**Markdown** in its corner to see the raw lines. An append shows the note's existing lines faded
above the new ones, so you can see where they land.

- **An append** goes at the end of the heading's section, and the note's `updated:` date is set
  to today. If the note changed since the draft, Work OS re-drafts instead of overwriting.
- **A new note** is never written over an existing file of the same name; Work OS re-drafts
  instead.

With dry-run on, notes are written to `sandbox/vault/` in the data folder, not to your vault.
