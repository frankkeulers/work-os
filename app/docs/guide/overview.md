---
title: What Work OS does
group: Start here
order: 10
summary: A local inbox for Slack, Outlook mail and calendar, and Wispr Flow meetings that decides what needs you, closes what's settled, files what's worth keeping, and learns from your feedback.
updated: 2026-10-12
---

Work OS runs on your Mac and reads the Slack conversations you are in, and, once you connect them,
your [Outlook mail and calendar](outlook.md) and the meeting notes from [Wispr Flow](wispr-flow.md).
For each conversation or meeting it decides whether it needs you now, today or not at all (or is
waiting on someone else for you), and whether it holds something worth keeping in Confluence, your
Obsidian vault or your Tasks note. You get one short list to work through instead of a dozen
channels and an inbox, with today's meetings beside it, and filing becomes a review-and-approve step
rather than a writing job.

Nothing leaves your Mac except the calls Work OS has to make: Slack, Wispr Flow and Outlook (all
read-only; Outlook through the Microsoft 365 connector on claude.ai), Claude, and Confluence, which
it reads to pick a page and writes only when you approve an entry. Tokens live in the macOS
Keychain, never in files.

## How a thread flows

1. **Poll.** Every 10 minutes in work hours (60 outside them), Work OS asks Slack for new
   messages. Outlook mail and the calendar are read every 30 minutes, and Wispr Flow every 3 hours,
   in work hours. A wake from sleep polls straight away. You can also choose **Poll now**. Sources
   poll one at a time: in the sidebar, a spinner marks the one polling and the others say "queued".
2. **Quiet window.** A conversation that is still going is left alone until it has been quiet for
   10 minutes, so it is read once, not after every message. These show as "N still active" in the
   inbox header.
3. **Topics.** Slack cuts conversations into pieces: each reply thread, and a DM after 30 minutes
   of quiet. Work OS joins the pieces on the same subject into one topic, so you see one entry per
   subject. See [Topics](inbox.md#topics).
4. **Rules, then triage.** Your [triage rules](rules.md) go first: a rule can decide on its own
   (a VIP's DM is Now) or hand the thread to Claude with a floor. Claude (Haiku) reads the rest and
   decides the attention level, a one-line summary, the asks for you, and, following your
   [filing policy](prompts.md#the-filing-policy), whether it is worth filing, whether to draft it
   ahead, whether it is ready to approve, and whether to suggest a to-do.
5. **Your inbox.** Threads that need you land in **Needs you**; ones where someone else has the next
   move in **Waiting on others**; ones only worth keeping in **To file**, with the routine ones under
   **Ready to approve**. See [The inbox](inbox.md).
6. **Close it.** When your reply settles what was asked, the item closes by itself, with Undo.
   When others settle it, the row says **Looks finished** for you to confirm. See
   [When you reply](inbox.md#when-you-reply).
7. **File it.** From an item, draft a [Confluence entry](confluence.md) or a
   [vault note](vault.md), or add a [to-do](vault.md#to-dos). Drafts the policy picks start ahead,
   so they are usually ready when you look. You see the draft, edit it if you like, and approve.
   Code, not the model, makes the write, and checks the target again first.
8. **Learn.** Your corrections, confirmations and what you approve, discard and close are kept
   as labels. Evals score the prompts against them, and on request Opus proposes a better filing
   policy, triage prompt, settle check or Looks finished check, which applies only when you say
   so. See [Learning](learning.md).

## Dry-run

While dry-run is on, approved actions write nowhere real: vault notes and to-dos go to a sandbox
folder and Confluence writes are only logged. It is on by default and always on in the development
instance. See [Dev and prod](dev-and-prod.md) and [Settings › Write targets](/settings/writing).

## MVP and Full scope

The account menu at the foot of the sidebar has a **Scope** switch. **MVP**, the default, shows
what Work OS does today. **Full** also shows later phases as dashed placeholders, such as sources still
to come, and, until the calendar has had a trial week, invites as inbox items. It changes only what
this browser shows: nothing is read or written differently.

## Where to look when something is off

The pill at the right of the inbox's top bar says whether Work OS is reading everything: there is
none while all is well, amber when something is down or stale, red in safe mode. The banner below it
says when a dependency (Slack, Outlook, Wispr Flow, Claude, Confluence, the Keychain, the network)
has a problem, with what to do about it. The dot beside Usage & health in the sidebar shows the
same at a glance: green when all is well, amber with a problem, red in safe mode. Hover it for the
reason. [Usage & health](/usage) has the detail. [Troubleshooting](troubleshooting.md) covers the
common cases.

The bell at the right of every page's top bar lists everything that needs your follow-up:
drafts that are ready or failed, logins and connectors to fix, items to look at again, and finished
evals and proposed prompt changes. See [The bell](inbox.md#the-bell-what-needs-your-follow-up).
