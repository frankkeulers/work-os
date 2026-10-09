---
title: The inbox
group: Inbox
order: 30
summary: The three zones on a wide screen, Needs you and To file, what the chips mean, topics, and how to correct a decision.
updated: 2026-10-09
---

## Three zones on a wide screen

On a window 1600 px wide or more, such as the 16" MacBook Pro full screen, the inbox is a cockpit
of three columns that each scroll on their own, so it can stay open all day and be read from across
the desk. The sidebar folds to a narrow rail (`[` opens it; the choice is kept for this layout).
The Work OS mark at the top of the sidebar, and the browser tab's icon, have a status light: orange
while something is in Now, briefly teal after a filing is written.

- **Time**, on the left: the clock and the date, then your next meeting, then the day as a
  timeline. See [The time column](#the-time-column).
- **Needs you**, in the middle: **NOW** then **TODAY**, each under its own header. Each row is two
  lines: where it happened, what it needs and when it's due, then the summary in large type.
- **Later**, on the right, for once a day: **To file** with where each should go, **This week**
  soonest first, a **Snoozed** line, and at the foot **N low priority · check triage** and
  **N done today**. Snoozed, Low priority and Done open in place of the lists; `Esc` or the back
  arrow returns.

Clicking a row in any column opens it in the item panel, 640 px wide, over Later. `j` and `k` walk
Now, Today, To file, then This week; `g n` jumps to the first item in Needs you and `g l` to the
first in Later. In a narrower window the inbox is a single list with the agenda strip above it, as
described below; nothing is lost.

### The time column

- **The next meeting.** The first meeting today you're going to (accepted, tentative or your own,
  not shown as Free) that hasn't ended: **NEXT · IN 12 MIN**, amber in the last two minutes, or
  **NOW · UNTIL 14:30** while it's on. Under it, **Due before it** lists what in Needs you is due
  by the time it starts, so you can clear it in the gap. **+1 at the same time** means another
  meeting overlaps; point at it to see which. Click the card to open the meeting in Outlook. With
  no meetings left, it says so and shows tomorrow's first.
- **The timeline.** Your work hours, widened to fit the day's meetings and deadlines. Meetings sit
  on the left with their Outlook category colour; those that are over are greyed. A red line with
  the time marks now. All-day events are one line above.
- **Deadline pins**, to the right of the meetings: one for each Needs you item due today, at its
  time, with a few words of what's due. Orange within about four hours, blue later today. A missed
  deadline turns red, says **Overdue** and sits at the red line. Pins within 30 minutes of each
  other stack, such as **2 due 17:30**; point at a pin to see what it holds, click it to open the
  item.
- **Tomorrow** (or `t`) shows tomorrow's meetings, with pins for This week items due then.

The meeting card and the meetings need [Outlook Calendar](outlook.md); without it the timeline
shows the pins only.

## Needs you and To file

The inbox has two groups of equal weight. On a wide screen they sit in Needs you and in Later.

- **Needs you** holds what asks something of you. **Now** items come first, with a faint orange
  wash: they need you within the hour. Then items whose triage failed (so they are never missed),
  then **Today** items, by deadline. A Today item due after today (Thursday 09:00, "this week",
  "next week") waits under **This week** instead, and moves into Needs you on the day it falls due.
  If you correct it to Now, it stays in Needs you.
- **To file** holds threads that need nothing from you but hold something worth keeping, in
  Confluence, your vault or both.

Each row reads left to right: where it happened and how long ago, the one-line summary, then up to
three chips: what it needs (reply, decide, review…), a deadline (orange within about four hours,
blue later today) and, in To file, where it should go.

Triage reads deadlines from what people write, in London time: "by end of day" is 17:30 today,
"by Thursday" 17:30 on Thursday, "this week" 17:00 on Friday, and a stated time wins. "Before the
exec sync" is that meeting's start when the [Outlook calendar](outlook.md) is on and has it;
otherwise the chip says "before the exec sync" without a time.

The header counts what's waiting, large enough to read from across the desk: **3 now · 6 today ·
4 to file** (Today includes items whose triage failed). Click a count to scroll to those rows.
On the right, the health pill says whether Work OS is reading everything; see
[Troubleshooting](troubleshooting.md#health).

The **Sort** menu starts on **Priority**: Now first, then failed triage, then Today by deadline. It
can also order by newest or oldest, and **Group by channel** gathers items under their channel or
DM. Your choice is kept in this browser.

The list stays still while you read it. A row whose item gets a new reply keeps its place; a new
item, or one that moved lane, goes in at its sorted place. While the item panel is open, new rows
wait behind a pill over the group, such as **1 new Now item**: click it to show them, or they land
when you close the panel. If you have scrolled down, rows that land above you don't push the list
down; a pill says **1 new Now item above** and takes you there. Rows you bring back yourself, with
Undo or Reopen, appear at once.

A new arrival carries a blue **New** dot until you have looked at it: two seconds in view while
the window is in front, or opening it. The dot also goes after 30 minutes.

With [Outlook Calendar](outlook.md) on, in a window narrower than 1600 px, a strip above the
groups shows today's meetings, the one on now picked out, and **Tomorrow** shows the next day's. A meeting opens in Outlook. An
invite you haven't answered is also an item, which closes itself once you answer it in Outlook;
see [Invites](outlook.md#invites).

## This week, low priority, snoozed and done

On a wide screen these live in Later. In a narrower window, below the groups, **Low priority** opens everything that needs nothing and holds nothing worth
filing. It is worth a glance now and then, to catch a wrong decision. **This week**, **Snoozed** and
**Done** open their lists the same way. This week lists the soonest due first, with the date on
each; a snoozed item comes back at its time, marked "Back from snooze".

Threads still being written show as **N still active** in the header. They are triaged once they
have been quiet for the quiet window (10 minutes by default, in [Settings › Schedule](/settings/schedule)).

## When you reply

When you answer an item from Needs you or This week in Slack, Work OS asks Claude whether your
reply settles what was asked. It is a short check, separate from triage, and it runs straight
after the poll that brings your reply in. A reply counts in the thread, and also as a post of
your own elsewhere in the conversation that Work OS groups into the item's topic, such as a
channel message telling someone the fix is in.

- **Settled:** the item closes by itself and goes to Done. If the check got it wrong, reopen it
  from Done. Each reopen is kept as a label, as corrections are for triage, so a change to the
  settle prompt can be measured (`npm run eval -- --purpose settle`, once there are 30).
- **Partly settled:** in a topic, the asks your reply settled are ticked off, and the next open
  one becomes the next step.
- **Not settled**, such as "will look later" or a question back: the item stays where it is.
- A message from someone else brings a closed item back, as it does for anything in Done.

What you see when a reply closes an item:

- The row stays where it was, in Needs you or in This week, for five seconds, washed green and
  struck through, reading **✓ You replied just now**, then it goes.
- A toast says **Closed: you replied in Slack**, with **Undo** to bring the item straight back.
- Under Needs you, a line counts the day's closes: **2 closed by your replies today · latest 4 min
  ago: …**. **Review** opens the list **Closed by your replies**; on a narrower window the line sits
  under the groups.
- In Done, each item says how it closed: **Your reply in Slack**, **Answered in Outlook** (an
  invite), **Closed in Slack** (the thread was deleted) or **Done by you**.

When the check says your reply didn't settle it, the row and the panel's next step read **You
replied · still open:** and why, such as "You said you'd look later". If closing on reply is off for
that source, they read **You replied · Mark done?** instead. The panel says under its main button
whether a reply closes the item: **Closes by itself when you reply in the thread**.

If you reply through the panel's **Reply in Slack** (or **Open thread in Slack**), Work OS reads that
thread again 2 and 6 minutes later, so the item closes without waiting for the next poll. A reply
you make without the button is still picked up by the poll.

Pressing Done within 30 minutes of a check that said "not settled" is kept as a label too: the
check missed a close. [Usage & health](/usage) shows how often your replies close items (C1) and
how often you undo a close (C2), over the last 14 days.

Replies in Outlook are checked only once you turn that on in
[Settings › Triage rules](rules.md#when-you-reply); they are then picked up by the next mail poll,
with no early read. The same page turns closing off: the check still runs, and the row asks **Mark
done?** instead. The checks count towards the day's triage budget, and when Claude can't be reached
nothing closes: the check is tried up to three times.

## The item panel

Click a row to open it in a panel on the right. It shows the decision (attention and why), the
next step, the asks, the thread itself and the filing actions.

At the bottom, **Triage details** says who decided: the model, a rule (such as "rule vip-dm"), or
you, after a correction. Open it for the model, the prompt version, the batch, the revision and the
time. It stays open or closed as you left it, in this browser.

- **Done** (`e`) and **Done and next** (`E`) sit in the footer, with **Snooze** (`s`): an hour,
  tomorrow at 09:00, or a time you pick.
- **Open in Slack** goes to the thread, in the browser or the desktop app as set in Settings.
- `o` opens the item as a full page; `Esc` or a click outside closes the panel.

## File in a batch

**File in a batch**, in the To file header, files the day's items in one sitting. The panel opens
on the first item, on the filing triage suggests (Confluence first), with its draft started, and
reads **Filing 1 of 4**.

- **Approve** writes it (to the sandbox while dry-run is on) and moves on. An item that suggests
  both Confluence and the vault stays open for the second one first.
- An item filed this way goes to Done once all its suggested filings are written, so it leaves
  To file by itself. Filing one item on its own still leaves it open, as before.
- **Skip** (`→`) leaves the item in To file and moves on. **Discard** works as usual.
- The next item's draft runs while you review the current one, so it is usually ready when you
  get there. Only one runs ahead: stopping part-way wastes at most one draft. The batch's drafts
  don't raise a "draft ready" toast, and neither does a draft for the item open in the panel.
- At the end the panel shows what happened, such as **3 filed · 1 skipped**. `Esc` closes it.
  `Esc` part-way, or opening another item, stops the batch; the rest stay in To file.

## Topics

Slack splits one conversation into pieces: each reply thread is a piece, and a DM or group DM
starts a new piece after 30 minutes of quiet. Work OS asks Claude to join pieces on the same
subject into a **topic**, so a DM about the MVI launch over three days is one entry, not five.

- **Asks in this topic** lists everything asked of you across its pieces. Tick one off when done.
- **Pieces** lists what the topic gathers. If a piece does not belong, choose **Split out**: it
  gets its own entry once triaged.
- **Regroup**, on a conversation's group header (turn on **Sort › Group by channel**), asks Claude to look again at that
  conversation's entries and merge those on the same subject.

## Correcting triage

When a decision is wrong, open the item, choose **More actions › Correct triage** (or press `c`),
set the attention level and the Confluence and vault flags, and save. The item moves at once and
shows "Corrected by you". Every correction is kept as a label: the eval in
[Usage & health](/usage) measures triage against them, so corrections make the next prompt
change measurable.

When a decision is right, say so: **Triage was right** beside it (or `y`) keeps the decision as
a label too, and reads **Right · labelled**. Nothing moves. Corrections alone only hold the cases
triage got wrong, so the eval would score the hard cases only; a mix of both gives a fairer score.
It is offered for decisions by the model or a rule on the thread as it is now, not for your own
corrections or while new messages wait to be triaged. A later correction replaces it.

The eval needs labels to run. Aim for about 30 before reading much into it, a mix of corrections
and confirmations, from both Slack and Outlook if you use both.

## Keeping it open

The cockpit is made to stay open on your screen all day.

- **Full screen** gives it the whole 1728 px of the 16" MacBook Pro: in Safari, **View › Enter
  Full Screen** (`Ctrl`-`Cmd`-`F`).
- **Its own window.** In Safari, with the inbox open, choose **File › Add to Dock**. Work OS then
  opens from the Dock in a window of its own, without the address bar and tabs, and stays out of
  your browsing.
- **Keep the display awake** in work hours: in System Settings › Lock Screen, set when the display
  turns off while on power adapter to a longer time. The inbox keeps itself up to date while
  it's open.
