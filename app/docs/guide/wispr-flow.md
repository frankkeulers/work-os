---
title: Wispr Flow meetings
group: Inbox
order: 45
summary: Meeting notes from Wispr Flow's Notetaker in the inbox, triaged on their summary, and filed from there.
updated: 2026-10-09
---

Wispr Flow's Notetaker records your meetings on the Mac and writes a summary, a transcript and
action items. Work OS reads finished meetings through Wispr Flow's own connector, read-only. Each
one shows in the inbox like a Slack thread: triaged, with the action items that fall to you picked
out, and ready to file as a vault note or a Confluence entry.

## Connect

1. Open [Settings › Wispr Flow](/settings/wispr) and choose **Connect**.
2. Wispr Flow's sign-in opens in a new tab. Sign in with the same Google, Apple or Microsoft
   account you use in the Wispr Flow app, and allow access.
3. The tab says you are connected and can be closed. Back in Settings, your account name shows,
   and Work OS reads your recent meetings straight away.

**Cloud Sync must be on** in the Wispr Flow app. Without it, your meetings stay on the Mac and the
connector can't see them.

The sign-in is kept in the macOS Keychain, never in a file. **Disconnect** forgets it and stops
reading; meetings already in the inbox stay.

## What's read

- **Finished meetings only.** A meeting still being processed is picked up on a later poll.
- **The inbox keeps** the meeting's summary, your own notes and its action items. Triage reads
  these. A meeting is "for your information" unless something in it falls to you.
- **A summary Wispr Flow rewrites** replaces the old one in the inbox on the next poll. The meeting
  isn’t triaged again for it, though it is when you first add notes to it.
- **The transcript is never stored.** When you draft a vault note or a Confluence entry from a
  meeting, Work OS reads the transcript from Wispr Flow for that draft only. If it can't, the draft
  is written from the summary and notes instead.
- **Confluence entries never identify people**, from a transcript or anywhere else. The draft
  leaves them out and keeps the decisions and facts.
- Work OS only reads. It never changes anything in Wispr Flow.

The first time you connect, Work OS reads the last seven days of meetings.

## With your calendar

With [Outlook Calendar](outlook.md) on, each meeting is matched to the calendar event it was:
the one the recording ran in, picked by time first, then by title and who was there. When two
events overlap and neither is clearly it, the meeting is left unmatched rather than guessed.

- The item panel says **On your calendar** with the event's title (it opens in Outlook), who
  organised it and how many were invited.
- Triage reads the event too, so it knows who was asked to the meeting, not only who spoke.
- On the inbox's agenda, the meeting shows **Notes**, which opens this item.

A meeting recorded before the calendar had read its event is matched after the next calendar
poll; that doesn't triage it again.

## When it polls

Every 3 hours in your [work hours](/settings/schedule), and not outside them unless you turn that
on in [Settings › Wispr Flow](/settings/wispr). **Poll now** in the inbox reads Wispr Flow too.
Wispr Flow needs the network: while you are offline, its meetings wait and arrive on the next poll
once you are back.

[Usage & health](/usage#health) shows Wispr Flow under Source health, beside Slack: its state,
when it last read and when it reads next.

## Reconnecting

Work OS renews the sign-in on its own. If it lapses (you signed out of Wispr
Flow, or removed Work OS's access), the inbox banner says **Wispr Flow rejected the login**. Open
[Settings › Wispr Flow](/settings/wispr) and choose **Reconnect**. Slack keeps polling meanwhile.

If Wispr Flow changes its connector so that Work OS can't read it safely, Work OS stops reading
and the banner says so. That needs a new version of Work OS, not a reconnect.
