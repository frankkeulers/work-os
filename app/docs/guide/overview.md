---
title: What Work OS does
group: Start here
order: 10
summary: A local inbox that reads Slack, decides what needs you, and files what is worth keeping.
updated: 2026-10-07
---

Work OS runs on your Mac and reads the Slack conversations you are in. For each one it decides
whether it needs you now, today or not at all, and whether it holds something worth keeping in
Confluence or your Obsidian vault. You get one short list to work through instead of a dozen
channels, and filing becomes a review-and-approve step rather than a writing job.

Nothing leaves your Mac except the calls Work OS has to make: Slack (read-only), Claude, and
Confluence when you approve an entry. Tokens live in the macOS Keychain, never in files.

## How a thread flows

1. **Poll.** Every 10 minutes in work hours (60 outside them), Work OS asks Slack for new
   messages. A wake from sleep polls straight away. You can also choose **Poll now**.
2. **Quiet window.** A conversation that is still going is left alone until it has been quiet for
   10 minutes, so it is read once, not after every message. These show as "N still active" in the
   inbox header.
3. **Topics.** Slack cuts conversations into pieces: each reply thread, and a DM after 30 minutes
   of quiet. Work OS joins the pieces on the same subject into one topic, so you see one entry per
   subject. See [Topics](inbox.md#topics).
4. **Rules, then triage.** Your [triage rules](rules.md) go first: a rule can decide on its own
   (a VIP's DM is Now) or hand the thread to Claude with a floor. Claude (Haiku) reads the rest and
   decides the attention level, a one-line summary, the asks for you, and whether it is worth
   filing.
5. **Your inbox.** Threads that need you land in **Needs you**; ones only worth keeping land in
   **To file**. See [The inbox](inbox.md).
6. **File it.** From an item, draft a [Confluence entry](confluence.md) or a
   [vault note](vault.md). You see the draft, edit it if you like, and approve. Code, not the
   model, makes the write, and checks the target again first.

## Dry-run

While dry-run is on, approved actions write nowhere real: vault notes go to a sandbox folder and
Confluence writes are only logged. It is on by default and always on in the development instance.
See [Dev and prod](dev-and-prod.md) and [Settings › Write targets](/settings/writing).

## Where to look when something is off

The banner at the top of the inbox says when a dependency (Slack, Claude, Confluence, the
Keychain, the network) has a problem, with what to do about it. [Usage & health](/usage) has the
detail. [Troubleshooting](troubleshooting.md) covers the common cases.
