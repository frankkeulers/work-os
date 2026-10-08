---
title: Triage rules
group: Inbox
order: 40
summary: Rules that decide before Claude does, or set a floor for its decision.
updated: 2026-10-08
---

Rules run before Claude, in order. **The first rule that matches decides**; the rest are skipped.
Edit them in [Settings › Triage rules](/settings/rules): drag to reorder, switch one off without
deleting it.

## Conditions

A rule matches when all its conditions do.

| Condition | Matches when |
|---|---|
| Sender in | the message is from someone in a list: your VIPs (set in [Settings › People](/settings/people)), or names you type |
| Channel in | the thread is in one of the listed channels (or a named list from [Settings › Slack](/settings/slack): included, excluded, customer channels) |
| Mentions me | you are @-mentioned |
| Is a DM | it is a direct message or group DM |
| Keyword | the text matches a regular expression, e.g. `/blocked\|go\/no-go/i` |

## Sources

Rules are checked for Slack items today. Outlook, Teams and the other sources join as they're
connected, and the same rules apply to them, so a VIP or keyword rule works everywhere.

- **Conditions** that only make sense in chat, such as Channel in, Mentions me and Is a DM, only
  match Slack and Teams items. A rule that uses one is labelled "Slack and Teams only".
- **Applies to** in the rule editor (Full scope, until a second source is live) limits a rule to
  the sources you pick. If none of them can check one of the rule's conditions, the rule can't be
  saved until you change one or the other.

Your VIPs are set once, in [Settings › People](/settings/people), and matched by name on every
source.

## Outcomes

| Outcome | What happens |
|---|---|
| Now | Straight to Now. Claude is not called. |
| Today | Straight to Today. Claude is not called. |
| Drop | Ignored, and not stored. |
| Ask the model | Claude decides; with a minimum, it can raise the level but never go below it. |
| To file | Claude still reads it (for the summary and where to file it), but it needs nothing from you, so it lands in To file. |

## The defaults

- A DM from a VIP → Now.
- An @-mention of you → the model decides, at least Today.
- Excluded channels → drop.
- Text like "blocked", "go/no-go" or "urgent" → the model decides, at least Today.
- Customer channels → the model decides, at least Today (off until you list your customer
  channels).

## Tips

- Put narrow rules above broad ones: the first match wins.
- Use **To file** for channels that are mostly reference material, such as release notes.
- Use **Drop** sparingly. A dropped thread is never stored, so it cannot be found later.
- A rule with a regular expression that does not compile is held back and shown in red until it
  is fixed.
