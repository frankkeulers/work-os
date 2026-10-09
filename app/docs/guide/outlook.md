---
title: Outlook mail and calendar
group: Inbox
order: 44
summary: Your Inbox, Sent Items and calendar through the Microsoft 365 connector on claude.ai, one item per conversation, with today's meetings above the inbox.
updated: 2026-10-09
---

Work OS reads your Outlook mail through the **Microsoft 365 connector** you already use on
claude.ai, read-only. Each conversation shows in the inbox as one item, triaged like a Slack
thread, with **Reply in Outlook** to answer it. Your replies in Sent Items are read too, so triage
knows what you have already answered. Turn on the calendar as well, and today's meetings show
above the inbox.

## Connect

1. Make sure the Microsoft 365 connector is added and signed in on claude.ai
   (Settings → Connectors). Work OS uses it; it doesn't sign in to Microsoft itself.
2. Open [Settings › Outlook](/settings/outlook) and choose **Connect**.
3. Work OS finds the connector, asks it which account it reads, and shows that account. Outlook
   is turned on and read straight away.

If Connect can't find the connector, choose **Enter the connector ID instead** and paste its ID.
`npm run spike:outlook -- status` prints it.

**Disconnect** turns Outlook mail and calendar off. Email already in the inbox stays, and the
connector stays on claude.ai, so **Connect** turns Outlook mail back on at once.

## What's read

- **Inbox and Sent Items.** New email in the Inbox, and your replies from Sent Items. One item per
  conversation, titled with the subject (without its Re: and Fw:).
- **Only what each email adds.** Quoted history, signatures, legal disclaimers and the
  external-sender banner are cut. Links keep their address. Attachments show by name only, as
  "📎 name"; their content is never read.
- **To and Cc** show under each email in the item panel, and triage reads them: an email you are
  only copied on usually needs nothing from you.
- **Skipped:** read receipts, bounces, meeting responses and automatic replies.
- **Your own sent email** is never a task for you. A conversation you started shows under
  Everything else, decided "You sent this and nobody has answered yet". When someone replies, it
  is triaged again.
- Work OS only reads. It never sends, moves, flags or marks anything as read in Outlook.

The first time you connect, Work OS reads the last two days of mail.

## When it polls

Every 30 minutes in your [work hours](/settings/schedule), and every 2 hours outside them. Change
either in [Settings › Outlook](/settings/outlook). **Poll now** in the inbox reads Outlook too.

Each poll is a short Claude Haiku run that relays the connector's calls: about $0.001 to look for
new email, and about $0.003 for each ten emails read. It shows on [Usage](/usage) with the rest of
your Claude use. Like every Claude call, it waits for the 45 seconds after the Mac wakes.

[Usage & health](/usage#health) shows Outlook under Source health: its state, when it last read
and when it reads next.

## Calendar

The calendar is off until you turn on **Read calendar** in
[Settings › Outlook](/settings/outlook). It reads through the same connector, so connect Outlook
first.

- **The agenda.** Today's meetings show in a strip above the inbox, the one on now picked out;
  **Tomorrow** shows the next day's. Cancelled meetings and ones you declined are left out. Choose
  a meeting to open it in Outlook. When the meetings don't all fit, the strip fades at the edge and
  an arrow there scrolls to the rest.
- **Not answered** marks a meeting someone else invited you to that you haven't accepted or
  declined yet. Choose it to open the invite's item.
- **What's kept.** Work OS keeps your calendar from yesterday to two weeks ahead: titles, times,
  who organised it and who is invited, its categories, and your answer. Never a meeting's description, its Teams
  link or its passcode.
- Work OS only reads. It never answers, moves or changes a meeting.

The calendar polls on its own schedule, every 30 minutes in work hours and every 2 hours outside
them; change either under **Calendar** in [Settings › Outlook](/settings/outlook). Each poll is a
short Claude Haiku run, about $0.002, plus about $0.002 for each ten invites it reads; it shows on
[Usage](/usage). If the last read is old, the strip says when it was.

### Now and next

Five minutes before a meeting you're going to, the sidebar shows it under **Next**, with the time,
the title and a countdown, on every page; on the agenda, its meeting says **in 4 min**. In the last
two minutes the countdown turns amber. Once it starts, the sidebar shows it under **Now**, with
when it ends, until it does. Choose a meeting there to open it in Outlook, where the Join button is.

- It's for meetings you've accepted, accepted tentatively or organised. Not ones you declined or
  haven't answered, all-day events, or ones shown as Free.
- **Meetings that overlap** each have their own line: those on now first, then those about to
  start, each with its own countdown on the agenda. With more than three, the last line says how
  many more, and opens your calendar in Outlook.
- **Dismiss** a meeting with the × on its line (point at the line to see it). It stays out of the
  sidebar until it ends, in this browser; the agenda still shows it, and **Undo** brings it back.
  If the meeting is moved, it shows again at its new time.
- Change how early a meeting shows (1 to 30 minutes) under **Upcoming meetings** in
  [Settings › Notifications](/settings/notifications).
- Nothing pops up and nothing makes a sound. Outlook's own reminders are unchanged.

### Categories

The Outlook categories on your meetings come with the calendar. A meeting with one has that
category's colour down its left edge on the agenda, and a light shade of it behind. An invite or a
Wispr Flow meeting joined to it has a dot in each category's colour beside its title in the inbox,
and lists its categories under the summary.

Work OS can read a category's name but not the colour you gave it in Outlook: the connector doesn't
offer your category list. Pick the same colours under **Category colours** in
[Settings › Outlook](/settings/outlook), from Outlook's 25. Until you do, each category has a colour
of its own, the same every time. A new category shows there once a meeting in the next two weeks has
it.

### Invites

- **An invite you haven't answered is an item**, labelled **Invite**, and is triaged like any
  other: one starting within about two hours goes to Needs you as Now; one in the next two working
  days, from a customer or a VIP, or asking only a few people, as Today; an invite sent to a crowd
  goes to Low priority. Its next step is to accept or decline; **Respond in Outlook** opens the
  meeting. There's nothing to draft or file.
- **One item per meeting**: a weekly series, or the same meeting sent again, is one item, not one
  per week. The invite's agenda is kept; its Teams joining details are not.
- **It closes itself.** Once you accept, decline or answer tentatively in Outlook, the next poll
  marks the item done. So does the meeting being cancelled, deleted, or starting. If the organiser
  moves it, the item says when to and is triaged again.
- **Invite emails stay out of mail.** While the calendar is on, the invitation, update and
  cancellation emails for a meeting on your calendar aren't read as mail, so a meeting doesn't
  arrive twice. With the calendar off, they come in as email, as before.
- Until the calendar has had a trial week, invites show in Full scope only.

## Rules

[Triage rules](/settings/rules) apply to email too. **Sender in** and **Keyword** work on
Outlook; **Channel in**, **Mentions you** and **Is a DM** are Slack's alone. The default
`blockers` rule (*urgent*, *blocked*, *go/no-go*) now matches email as well; to keep it to Slack,
edit the rule and set **Applies to** to Slack only.

## Reconnecting

If the connector is signed out on claude.ai, the inbox banner says **Microsoft 365 rejected the
login**. Sign the connector in again on claude.ai (Settings → Connectors), then choose **Check
again** in the banner. Slack keeps polling meanwhile.

If you removed the connector and added it again, its ID changed: choose **Reconnect** in
[Settings › Outlook](/settings/outlook) to find the new one.

If Microsoft changes the connector so that Work OS can't read it safely, Work OS stops reading
Outlook and the banner says so. That needs a new version of Work OS, not a reconnect.
