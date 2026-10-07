---
title: Filing to Confluence
group: Filing
order: 50
summary: How a thread becomes an entry on the right page of the PSG context corpus.
updated: 2026-10-07
---

The Confluence PRD pages are Pole Star Global's context corpus: the PSPD pipeline and the Product
Knowledge Desk read them. Work OS drafts an entry for the right page and section; you review it and
approve; code writes it.

## Scope

Work OS can only read and write the pages in scope. You set the scope with rules, not a list of
page IDs, so a page added to the tree is included without changing anything. Set them in
[Settings › Write targets](/settings/writing).

- **Root pages:** each page and everything below it. The defaults are the seven business-unit
  roots (DP, S&O, MR&C, GGS, INS, DEF, ORG) and the shared roots: UX Principles, Competitor
  Profiles, Glossary & Taxonomy, and Company Strategic & Commercial Context.
- **Labels:** pages anywhere in the space with one of these labels. The defaults are the six
  `psg-shared-*` labels, which bring in Data Assets & Licensing and the registries.
- **Excluded pages:** never offered or written, with everything below them. They win over the
  rules above. The defaults are your sweep staging page, the Meridia router page and Archive.
- **Single pages:** extra pages on their own, without their children.

**Preview catalogue** reads the scope from Confluence now and lists every page in it, grouped by
root, with index pages marked. Use it after changing the rules, or to check the token works.

## Drafting

Choose **Draft Confluence entry** on an item. It takes a few seconds and runs in steps you can
watch:

1. **Reading the Confluence catalogue.** Work OS searches Confluence for every page in scope.
2. **Picking the page.** Claude reads the thread, the routing guidance and the catalogue, and picks
   up to three likely pages, preferring a specific page over an index.
3. **Drafting the entry.** Claude reads only those pages' outlines and writes a short entry under
   an existing section: the fact, why, what follows, its provenance tier, the date and a link back
   to Slack.
4. **People check.** A second, cheap check (Haiku) blocks the draft if it describes named people:
   their performance, behaviour or circumstances. Nothing about people goes to Confluence.

Items flagged as containing observations about people cannot be drafted to Confluence at all; the
panel offers a vault note instead.

The routing guidance (which business unit, which kind of fact goes where) is a file you can edit:
see [Prompts and guidance](prompts.md).

## No fit

Sometimes the right answer is not to file. Claude says so when the right page is not in scope,
when nothing survives the people screen, or when the thread is not context at all (an idea for
PSPD, an action item, logistics). The panel then shows **Nothing to file** with the reason and,
when Claude knows it, a suggested home. You can draft a vault note instead, re-draft, or dismiss.

If the suggested home should be in scope, add it in [Settings › Write targets](/settings/writing)
and re-draft.

## Approving and writing

Review the entry, edit it in place if you like, and choose **Approve**. Before every write, code:

1. checks the page is still in scope, asking Confluence afresh;
2. re-reads the page and checks its version is the one the draft was made from;
3. adds the entry at the end of the chosen section, under its own heading, as the next version,
   with the version message "Work OS" and the action's id.

If someone edited the page since the draft, Work OS re-drafts against the new version instead of
overwriting. A dropped connection or a lost answer is retried, and the version message makes sure
an entry is never written twice.

With dry-run on, nothing is written: the would-be page is saved under `sandbox/confluence/` in the
data folder, and the result says "Dry-run: write logged only".

## Refused writes

A draft whose page has since left the scope (excluded, or no longer under a root) is refused at
write time with **Write refused**, and nothing is written. The panel warns before you approve when
it already knows the page is excluded. Re-draft to pick a page in scope.
