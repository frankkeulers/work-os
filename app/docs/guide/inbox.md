---
title: The inbox
group: Inbox
order: 30
summary: Needs you and To file, what the chips mean, topics, and how to correct a decision.
updated: 2026-10-08
---

## Needs you and To file

The inbox has two groups of equal weight.

- **Needs you** holds what asks something of you. **Now** items come first, with a faint orange
  wash: they need you within the hour. Then items whose triage failed (so they are never missed),
  then **Today** items, by deadline.
- **To file** holds threads that need nothing from you but hold something worth keeping, in
  Confluence, your vault or both.

Each row reads left to right: where it happened and how long ago, the one-line summary, then up to
three chips: what it needs (reply, decide, review…), a deadline (orange within about four hours,
blue later today) and, in To file, where it should go.

The **Sort** menu orders by newest, oldest or priority, and can group items by channel or DM.

With [Outlook Calendar](outlook.md) on, a strip above the groups shows today's meetings, the
one on now picked out, and **Tomorrow** shows the next day's. A meeting opens in Outlook. An
invite you haven't answered is also an item, which closes itself once you answer it in Outlook;
see [Invites](outlook.md#invites).

## Low priority, snoozed and done

Below the groups, **Low priority** opens everything that needs nothing and holds nothing worth
filing. It is worth a glance now and then, to catch a wrong decision. **Snoozed** and **Done** open
their lists the same way; a snoozed item comes back at its time, marked "Back from snooze".

Threads still being written show as **N still active** in the header. They are triaged once they
have been quiet for the quiet window (10 minutes by default, in [Settings › Schedule](/settings/schedule)).

## The item panel

Click a row to open it in a panel on the right. It shows the decision (attention, why, the model
and prompt version), the next step, the asks, the thread itself and the filing actions.

- **Done** (`e`) and **Done and next** (`E`) sit in the footer, with **Snooze** (`s`): an hour,
  tomorrow at 09:00, or a time you pick.
- **Open in Slack** goes to the thread, in the browser or the desktop app as set in Settings.
- `o` opens the item as a full page; `Esc` or a click outside closes the panel.

## Topics

Slack splits one conversation into pieces: each reply thread is a piece, and a DM or group DM
starts a new piece after 30 minutes of quiet. Work OS asks Claude to join pieces on the same
subject into a **topic**, so a DM about the MVI launch over three days is one entry, not five.

- **Asks in this topic** lists everything asked of you across its pieces. Tick one off when done.
- **Pieces** lists what the topic gathers. If a piece does not belong, choose **Split out**: it
  gets its own entry once triaged.
- **Regroup**, on a conversation's group header, asks Claude to look again at that
  conversation's entries and merge those on the same subject.

## Correcting triage

When a decision is wrong, open the item, choose **More actions › Correct triage** (or press `c`),
set the attention level and the Confluence and vault flags, and save. The item moves at once and
shows "Corrected by you". Every correction is kept as a label: the eval in
[Usage & health](/usage) measures triage against them, so corrections make the next prompt
change measurable.
