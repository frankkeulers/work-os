---
title: Prompts and guidance
group: Settings
order: 70
summary: The text files every Claude call reads, and how to change them safely.
updated: 2026-10-12
---

Every Claude call reads its instructions from a text file in the data folder, fresh each time. You
can read and edit them all in [Settings › Prompts](/settings/prompts).

| File | Used by |
|---|---|
| Triage | triage and the eval |
| Filing policy | triage, sent after the triage prompt: what to file, draft ahead, offer as ready to approve, and suggest as a to-do |
| Topics | joining pieces into topics, and Regroup |
| Settle check | closing an item when your reply settles it |
| Draft vault note | vault drafts |
| Pick Confluence page | the first step of a Confluence draft |
| Draft Confluence entry | the second step of a Confluence draft |
| People check | the check before a Confluence draft is shown |
| Vault conventions | vault drafts (guidance) |
| Confluence routing | Confluence drafts (guidance) |

## Editing

Choose **Edit**, change the text and **Save**. Prompts save only when you say so, not as you type,
because the next call reads the file straight away: a half-finished edit would reach a real call.

- Each file has a version, such as `triage v3#d4b00d12`: its own number from the first line, and a
  fingerprint of the text. Drafts and decisions record the version they used.
- **Edited** marks a file that differs from the built-in default.
- If the file changed on disk since you opened it, Save says so instead of overwriting; reload and
  make your change again.
- **Reset to default** puts the built-in text back, after asking.

When Work OS ships a new default, files you have not edited are upgraded automatically; edited
ones are left alone.

## The filing policy

The triage prompt holds the fundamentals: what Confluence and the vault are for, the people rule
and the shape of the answer. The **Filing policy** holds your rules for filing, in four sections:

- **To file** (`F1`, `F2`, …): what is worth filing at all, and where.
- **Pre-draft** (`P1`, …): what is worth drafting ahead, which spends a draft before you've looked.
- **Ready to approve** (`R1`, …): what you can approve after a glance, with where it goes.
- **To-dos** (`T1`, …): when a step should be suggested as a to-do.

Each rule has an ID, and each decision records the rule it applied, so keep a rule's ID when you
reword it and give a new rule a new one. Triage sends the policy with every call, so an edit takes
effect from the next triage.

## Source changed

The two guidance files are distilled from sources that keep moving: the psg-context-builder and
obsidian-vault-reader skills, and your vault's Notes System note and `llms.txt`. Each records which
version of its sources it was written from. When a source changes, the file is marked **Source
changed**.

Read what changed in the source, update the guidance if it matters, then choose **Mark reviewed**
to record that the guidance is current.
