---
title: Learning
group: Settings
order: 72
summary: How your feedback improves the filing policy: labels, the filing eval, proposed changes you apply, and the switches.
updated: 2026-10-12
---

Work OS learns what you file from what you tell it and what you do. It never changes how it works
by itself: it proposes a change, shows you what it would do better, and waits for you to apply it.
[Settings › Learning](/settings/learning) holds it all.

## The loop

1. **Your filing policy** says what goes to To file, what is drafted ahead, what is ready to
   approve, and which to-dos to suggest. See [the filing policy](/guide/prompts#the-filing-policy).
2. **Labels** record where it was right or wrong. Your word counts most: **Filing…** on an item,
   a correction that turns a filing on or off, and **Triage was right**. Your actions count too:
   approving a draft as it was or after an edit, discarding one, **Done** on an item in To file
   with nothing filed, adding or dismissing a suggested to-do. See
   [Feedback on filing](/guide/inbox#feedback-on-filing).
3. **The filing eval** scores the policy against the labels.
4. **Propose a better policy** asks Opus for a revision, and you decide.

## The filing eval

**Run filing eval** runs triage with the current policy over every labelled item, without your
rules, and scores each field: To file, pre-draft, ready to approve and to-do suggestions.
Precision says how often the policy was right when it said yes; recall, how many of the yeses it
found. A field's score counts once it has 30 labels; before that it shows **counts from 30**.

| Field | Precision target |
|---|---|
| To file | 85% |
| Pre-draft | 80% |
| Ready to approve | 95% |
| To-do suggestions | 95% |

When it finishes, the bell says so for a day, with the fields that meet their target and those
below it. **View scores** brings you back here.

Ready and to-dos have the strictest targets: a wrong one costs you more than a missed one. From
the command line, with Work OS stopped: `npm run eval -- --purpose filing`.

## Proposed changes

**Propose a better policy** needs 10 labelled items. It sets about a third of them aside, shows
Opus where the policy got the rest wrong, and asks for a revised policy and a list of changes. Code
then checks the answer and turns it down if it:

- copies eight or more words in a row from a labelled thread, so message text never moves into
  a long-lived file;
- drops a rule's ID without listing the removal;
- is over twice as long as the current policy.

A proposal that passes is scored, with the current policy, on the items set aside, which it never
saw. The bell tells you when it is ready; **Review** opens Settings › Prompts at the proposal. In [Settings › Prompts](/settings/prompts) it shows above
the Filing policy: the changes, the scores before and after, and the text's changes. **Apply**
saves it as the policy file, as an edit would, so the next triage uses it; it refuses if you edited
the policy since the proposal was made. **Dismiss** keeps the policy as it is. A proposal that
scores no better is still shown, marked as such.

Runs start only when you ask. The section says when 10 or more labels have arrived since the
last one. Each run makes three filing-eval passes and one Opus call; they appear in
[Usage](/usage) as Eval run and Policy proposal, and count towards the cost budget. How Opus
revises the policy is itself a prompt, **Policy tuner**, in Settings › Prompts.

## Switches

- **Draft ahead:** by the policy (the default), all filings as before the policy, or none until
  you press `f` or `v`.
- **Ready to approve:** off, the ready filings wait in To file with the rest.
- **Suggest to-dos:** off, the item panel offers no suggested to-do.
