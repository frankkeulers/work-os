---
title: Filing to the vault
group: Filing
order: 60
summary: Notes for your Obsidian vault, drafted to follow its conventions.
updated: 2026-10-08
---

Choose **Draft vault note** on an item. Claude reads your vault, read-only, to find where the
thread belongs, then drafts either:

- **an append** under a heading of the note that already owns the topic (preferred), or
- **a new note**, with front matter, tags from your tag taxonomy and a summary.

The draft follows the vault conventions: where notes live, front matter, tags, and what to keep
(decisions and facts that stay true) or leave out (action items and transient status).

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
