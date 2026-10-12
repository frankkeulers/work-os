---
title: Filing to the vault
group: Filing
order: 60
summary: Notes for your Obsidian vault, drafted to follow its conventions, and to-dos for your Tasks note.
updated: 2026-10-12
---

Choose **Draft vault note** on an item. Claude reads your vault, read-only, to find where the
thread belongs, then drafts:

- **appends** under the headings of the notes that already own each topic (preferred). A thread
  or meeting that covers several topics goes into several notes in one draft: a product note, the
  Decision Log, a customer signals note;
- **a new note**, with front matter, tags from your tag taxonomy and a summary, only for what no
  existing note covers.

You often won't need to choose it. When your [filing policy](prompts.md#the-filing-policy) says a
vault note is worth drafting ahead, the draft starts as the item arrives in To file, and where the
policy says it should go reaches Claude as a hint. A routine one, such as a meeting's note, shows
under [Ready to approve](inbox.md#ready-to-approve) for one key press each.

## Meetings

A meeting is filed by topic, like a thread. Each decision, fact or finding goes under the note
that owns it, ending with the meeting's Wispr Flow link. A meeting note in `Work/Meetings/` holds
only what fits nowhere else; when everything has a home, there is no meeting note.

Action items stay out of the vault, except in a meeting note that is created anyway. Work OS
doesn't create a meeting note just to hold them. Add them to your Tasks note instead: see
[To-dos](#to-dos).

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

A draft that files into several notes says **Files into N notes**, then lists each note with where
it lands and its own **Edit**. One approval writes them all. Work OS checks every note before it
writes any: if one changed since the draft, none is written and it re-drafts.

- **An append** goes at the end of the heading's section, and the note's `updated:` date is set
  to today. If the note changed since the draft, Work OS re-drafts instead of overwriting.
- **A new note** is never written over an existing file of the same name; Work OS re-drafts
  instead.

With dry-run on, notes are written to `sandbox/vault/` in the data folder, not to your vault.

## To-dos

Choose **Add to-do** under File it, or press `a`, to add your open steps on an item to your Tasks
note as Obsidian Tasks lines:

```
- [ ] Confirm the data-licensing wording in the doc 📅 2026-10-05 [#mvi-launch](https://…)
```

Each step gets its due date, when it has one, and a link back to the source. The steps are a
topic's open asks, a meeting's action items, or the next step. Work OS builds the to-do itself,
with no model call, so it is ready at once and doesn't count against the drafts budget.

Review the lines, edit them if you like (a line without a checkbox becomes a task), and choose
**Approve and add to Tasks**. The lines go at the end of the note, and the note is created if it
isn't there. A task that is already in the note, ticked or not, isn't added again.

Each line is written with an id, the Tasks plugin's `🆔` field, after its date:

```
- [ ] Confirm the data-licensing wording in the doc 📅 2026-10-05 🆔 3fa9c1 [#mvi-launch](https://…)
```

The id lets Work OS find the line again, even after you move it or edit its words. Each line
becomes a To Do on the inbox (see [To do](inbox.md#to-do)), and ticking it in Obsidian marks
that To Do done.

When your filing policy suggests a to-do, the panel shows **Add to-do:** with the step and its
date: `a` adds that one for review, × dismisses it. Both teach the policy; see
[Feedback on filing](inbox.md#feedback-on-filing).

On a meeting, **Action items for you** lists what was assigned to you, all ticked. Untick the
ones you won't track, then choose **Add to Tasks**: the to-do opens for review. Tick them off in
Obsidian.

The note is set in [Settings › Write targets › Tasks note](/settings/writing), as a path in the
vault (`Work/Tasks.md` unless you change it). With dry-run on, to-dos go to the sandbox copy of the
note.
