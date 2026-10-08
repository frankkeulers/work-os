---
title: Outlook mail and calendar
group: Inbox
order: 44
summary: Your Inbox, Sent Items and calendar through the Microsoft 365 connector on claude.ai, one item per conversation, with today's meetings above the inbox.
updated: 2026-10-08
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
  a meeting to open it in Outlook.
- **Not answered** marks a meeting someone else invited you to that you haven't accepted or
  declined yet.
- **What's kept.** Work OS keeps your calendar from yesterday to two weeks ahead: titles, times,
  who organised it and who is invited, and your answer. Never a meeting's description, its Teams
  link or its passcode.
- Work OS only reads. It never answers, moves or changes a meeting.

The calendar polls on its own schedule, every 30 minutes in work hours and every 2 hours outside
them; change either under **Calendar** in [Settings › Outlook](/settings/outlook). Each poll is a
short Claude Haiku run, about $0.002, plus about $0.002 for each ten invites it reads; it shows on
[Usage](/usage). If the last read is old, the strip says when it was.

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
