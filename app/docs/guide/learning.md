---
title: Learning
group: Settings
order: 72
summary: How your feedback improves the filing policy, triage, the settle check and Looks finished: labels, evals, and proposed changes you apply.
updated: 2026-10-12
---

Work OS learns from what you tell it and what you do. Each thing it learns about is steered by a
prompt you can read and edit, and your feedback becomes **labels** that say where that prompt was
right or wrong. When enough labels have built up, Work OS can **propose a change** to the prompt,
show you how the change would have done on labels it never saw, and wait for you to apply it.

Three things never happen:

- **Nothing changes on its own.** A proposal is only a suggestion until you press **Apply**, and
  you can dismiss it.
- **Nothing is written without you.** Learning changes what is drafted and where it shows, never
  what is filed. Every vault note, Confluence entry and to-do still waits for your approval.
- **Message text doesn't move into the prompts.** Code turns down a proposal that copies a run of
  eight or more words from a labelled thread.

Everything on this page lives in [Settings › Learning](/settings/learning).

## The four loops

| Loop | What its prompt decides | Its labels come from | Its eval |
|---|---|---|---|
| **Filing policy** | what goes to To file, what is drafted ahead, what is ready to approve, which to-dos to suggest | **Filing…** on an item, corrections, **Triage was right**, approving and discarding drafts, Done with nothing filed, suggested to-dos | **Run filing eval**, here |
| **Triage attention** | whether a topic is Now, Today, Follow or nothing for you | **Correct triage** (`c`) and **Triage was right** (`y`) | **Run eval** in [Usage](/usage) |
| **Settle on reply** | whether your reply settles what was asked, so the item closes by itself | **Undo**, or reopening from Done, on an item that closed on your reply; Done on an item your reply settled that the check left open | `npm run eval`, with `--purpose settle` ([how](#the-other-evals)) |
| **Looks finished** | whether others' messages settled what was asked of you | **Done** or **Not finished** on a Looks finished item | `npm run eval`, with `--purpose finish` ([how](#the-other-evals)) |

Each loop works the same way:

1. **Use Work OS as usual.** Labels collect as you correct, confirm, approve, discard and close.
   Nothing extra is needed beyond the feedback below when something is plainly wrong.
2. **Check the scores.** An eval runs the prompt over the labelled items and says how often it was
   right. See [Reading the scores](#reading-the-scores).
3. **Propose a better prompt** once there are 10 labelled items. See
   [Proposing a change](#proposing-a-change).
4. **Review and apply** the proposal in [Settings › Prompts](/settings/prompts), or dismiss it.

## Giving feedback

### On filing

Open an item that triage suggested filing and click **Filing…** beside the decision. The menu
offers what fits the item:

| Choice | What happens to the item | What the policy learns |
|---|---|---|
| **Not for filing** | It leaves To file, as a correction does | It didn't belong in To file |
| **Don't draft items like this ahead** (per filing) | No draft starts until you press `f` or `v`; it leaves Ready to approve | Not worth drafting ahead |
| **Should be ready to approve** (per filing) | It joins **Ready to approve** at once and is drafted ahead | It should have been ready |
| **Shouldn't be ready to approve** (per filing) | It goes back with the other filings; a draft already made stays | It wasn't ready |
| **Should be filed to the vault / to Confluence** | The filing is added, as a correction does | It belonged in To file |

Your word on an item holds until new messages bring a new triage, and the
[switches](#switches) still apply: with Ready to approve off, nothing shows as ready.

Your actions count too, as weaker labels, without anything to press:

- approving a draft **as it was** says it was worth drafting ahead and could have been ready;
- approving it **after an edit** says drafting ahead was right but it wasn't ready;
- **discarding** a draft (not re-drafting it) says it wasn't worth drafting ahead;
- **Done** on an item in To file with nothing filed says it didn't belong there;
- **adding** a suggested to-do with `a`, or dismissing it with ×, says whether the suggestion was
  right.

Where you've said something yourself, it wins over what your actions suggest. See also
[Feedback on filing](inbox.md#feedback-on-filing).

### On triage

- **Correct triage** (`c`) when an item is in the wrong lane. The item moves, and the correction is
  a label.
- **Triage was right** (`y`) when it got an item right. Nothing moves. Confirmations matter: with
  corrections alone the labels hold only the hard cases, and the scores look worse than triage is.

See [Correcting triage](inbox.md#correcting-triage).

### On closing by itself

- **Settle on reply:** when an item closed on your reply and shouldn't have, press **Undo** on the
  toast, or reopen it from Done.
  When your reply did settle it but the check left it open, press Done as you would anyway. Both
  are labels. See [When you reply](inbox.md#when-you-reply).
- **Looks finished:** answer the suggestion. **Done** says it was right; **Not finished** says it
  wasn't. See [When others settle it](inbox.md#when-others-settle-it).

## Settings › Learning

The page has a group for each loop, then the switches.

- **Labels:** how many items are labelled, and how many lines came from your word and how many from
  your actions. An item labelled twice counts once; its latest label stands.
- **The eval:** the filing eval runs from here and shows its last scores. Triage attention links to
  its latest report in Usage. Settle on reply and Looks finished say how to run theirs from the
  command line.
- **Proposals:** what became of the latest proposal, a nudge once 10 or more labels have arrived
  since then, and the **Propose a better …** button. The button stays off until the loop has 10
  labelled items, and says how many there are.

## Reading the scores

Each eval runs the prompt over the labelled items again and compares its answers with your labels.

- **Precision:** of the times it said yes, how often it was right. Low precision means noise: things
  filed, drafted, marked ready or closed that shouldn't have been.
- **Recall:** of the labelled yeses, how many it found. Low recall means misses.
- **Labels:** how many labelled answers the row is based on. A score from a handful of labels says
  little.

Green means a row meets its target; red means it is below.

| Loop | Row | Target |
|---|---|---|
| Filing policy | To file | precision 85% |
| | Pre-draft | precision 80% |
| | Ready to approve | precision 95% |
| | To-do suggestions | precision 95% |
| Triage attention | Now | precision 80%, recall 90% |
| | Today | precision 80% |
| Settle on reply | Closes on your reply | precision 98% |
| Looks finished | Looks finished | precision 98% |

Ready to approve, to-dos and closing have the strictest targets: a wrong one costs you more than a
missed one. A filing field's score counts once it has 30 labels; before that the table shows
**counts from 30**.

### The filing eval

1. In Settings › Learning, under **Filing policy**, click **Run filing eval**.
2. It runs in the background. When it finishes, the scores show here, and the bell says so for a
   day, with the fields that meet their target and those below. **View scores** brings you back.

It runs triage with the current policy over every item with a filing label, without your rules, so
it measures the policy alone. From the command line, with Work OS stopped:
`npm run eval -- --purpose filing`. That also splits the scores by your word and your actions.

### The other evals

- **Triage:** **Run eval** in [Usage](/usage), or `npm run eval` with Work OS stopped.
- **Settle and Looks finished:** `npm run eval -- --purpose settle` or `--purpose finish`, with Work
  OS stopped, once there are 30 labels. They report false closes (closed, but you still owed
  something) and missed closes (left open after it was settled).

## Proposing a change

### Start a run

1. In Settings › Learning, click **Propose a better policy** (or **triage prompt**, **settle
   check**, **Looks finished check**) in that loop's group.
2. It works in the background for a few minutes. The bell says when the proposal is ready.

A run:

1. sets about a third of the labelled items aside, always the same ones for the same item;
2. scores the current prompt on the rest and collects what it got wrong;
3. shows those misses to Opus, which writes a revised prompt and a list of changes;
4. runs code's checks on the answer (below);
5. scores the current and the proposed prompt on the items set aside, which Opus never saw.

Each run makes three eval passes and one Opus call. They show in [Usage](/usage) as **Eval run**
and **Policy proposal** and count towards the day's cost budget. A run doesn't start once the
budget is reached.

### What code checks

Code turns a proposal down, and keeps only the reason, if it:

- copies eight or more words in a row from a labelled thread;
- drops a rule's ID (such as `[R1]`) without listing the removal;
- is more than twice as long as the current prompt;
- doesn't start with the file's own first line, such as `<!-- prompt: triage v10 -->`;
- breaks the answer format: more of the set-aside items get no usable answer than with the current
  prompt.

A proposal turned down keeps no text, as it may hold a thread's words. Settings › Learning says
why it was turned down. Run again later, after more labels.

### Review it

Click **Review** in the bell, or **Review it** in Settings › Learning. Settings › Prompts opens at
the file, with the **Proposed change** above it:

- **Learned from N items, scored on M held back:** how much it saw, and how much it was tested on.
- **Scores better** or **Scores no better:** the mean of each row's balance of precision and recall,
  current against proposed, on the items held back. A proposal that scores no better is still
  shown, as its changes may still be worth having.
- **The changes:** each one with the rule it touches and the misses it fixes.
- **Held-out scores, current → proposed:** each row's precision, and recall where it has a recall
  target, before and after, with the targets.
- **Show the changes in the text:** the lines added and removed.

What to look for:

- Does each change describe a kind of situation, not one thread?
- Does a strict row (Ready to approve, to-dos, closing) get looser? That is worth more caution than
  a gain in recall.
- With few items held back, a change of one item moves a score a lot. Read the changes as much as
  the numbers.

### Apply or dismiss

- **Apply** saves the proposed text as the file, as an edit would. The next call uses it. The event
  log records which proposal it came from. If you edited the file since the proposal was made,
  Apply refuses; run a new proposal from the file as it is now.
- **Dismiss** leaves the file as it is.

To go back after applying, edit the file in Settings › Prompts, or **Reset to default**.

How Opus writes proposals is itself a prompt, **Policy tuner**, in Settings › Prompts, with a
section for each loop. Edit it to change what it may touch: for example, the triage section limits
it to what the prompt says about attention.

## Switches

The switches act on filing only, and apply whatever the policy or your feedback says.

- **Draft ahead:** by the policy (the default), every filing as before the policy, or none until
  you press `f` or `v`.
- **Ready to approve:** off, the ready filings wait in To file with the rest.
- **Suggest to-dos:** off, the item panel offers no suggested to-do.

## A routine that works

- **As you go:** use **Filing…**, `c` and `y` when something is plainly wrong or right. A few a day
  is plenty.
- **Weekly:** run the filing eval and glance at the triage report. When a loop says it has 10 or
  more new labels, propose a change, review it, and apply it if it reads well.
- **After applying:** the next week's scores show whether it helped. The proposal you applied is
  listed in Settings › Learning with the version it became.

## When something is off

- **The Propose button is off:** the loop has fewer than 10 labelled items, or a run is going.
- **"Today's cost budget is reached":** propose again tomorrow, or raise the budget in
  [Settings › Budgets](/settings/budgets).
- **"Claude can't be called right now":** see [Claude](troubleshooting.md#claude).
- **Turned down by code:** the reason says which check failed. More labels usually help; a run
  that keeps copying threads may need the Policy tuner's wording tightened.
- **Apply refused:** the file changed since the proposal. Propose again.
