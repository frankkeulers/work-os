---
title: Troubleshooting
group: Help
order: 80
summary: What the health pill and banner mean, storing tokens, and what to do when something stops.
updated: 2026-10-09
---

## Health

Work OS keeps running when something it depends on has a problem, and says so. The banner at the
top of the inbox names the problem and the fix, with **Check again** to try at once.
[Usage & health](/usage#health) shows each dependency.

| State | Means |
|---|---|
| Offline | No network. Work that needs it waits and resumes on its own. |
| Not working | Errors from the service; Work OS backs off and tries again. |
| Rate-limiting | The service asked to wait; Work OS waits as long as it was told. |
| Rejected the login | The token or login is not accepted. Fix it, then Check again. |
| Paused | Stopped on purpose, or waiting for something else to be fixed. |

You are told by notification about a problem at most once every four hours per service, never in
quiet hours, and only about being offline after 30 minutes awake in work hours.

### The health pill

The pill at the right of the inbox's top bar tells you, from across the desk, whether Work OS is
reading everything. When something needs a look, the whole top bar takes its colour.

| Pill | Means |
|---|---|
| Green, "All sources live · 2 min ago" | Every source read on time; the time is the oldest last read. The bar stays plain. |
| Blue, "Catching up after sleep" | The Mac woke up; Work OS is reading what fell due. |
| Amber, naming what's down and what's stale | A dependency has a problem, for example "Outlook not connected · mail and calendar stale". The fix is beside it as a link. |
| Amber, "Slack stale · last read 34 min ago" | A source hasn't been read for more than twice its interval (work or off hours), with no error. Work OS may have stopped polling quietly; open Usage & health, or choose **Poll now**. |
| Red, "Safe mode · nothing is being read" | See [Safe mode](#safe-mode). |
| Grey, "Stopping" | The server is shutting down. |

The banner still names problems you need to act on, and the dot beside Usage & health in the
sidebar stays.

## Keychain tokens

Tokens live in the macOS Keychain under the service `com.polestar.workos`:

| Account | Holds |
|---|---|
| `slack-user-token` | the Slack user token (`xoxp-…`) |
| `confluence-api-token` | your Atlassian email and API token, as `email:token` |

The `security` command's password prompt keeps only the first 128 characters, and an Atlassian
token with your email is longer than that. So pass the value as an argument instead. Copy the full
value to the clipboard, then run the line for that token:

```
security add-generic-password -U -s com.polestar.workos -a confluence-api-token -w "$(pbpaste)"
security add-generic-password -U -s com.polestar.workos -a slack-user-token -w "$(pbpaste)"
```

Then copy something else, to clear the clipboard, and choose **Check again**. Keychain Access
works too: find the item and paste into its password field.

For Confluence, use a classic API token from id.atlassian.com (Security › API tokens), not a
scoped one. To test a token before storing it:

```
curl -s -u 'you@polestarglobal.com:TOKEN' https://pole-star.atlassian.net/wiki/rest/api/user/current
```

`"type":"known"` means it is accepted; `"type":"anonymous"` means it is not.

## Confluence

- **"Confluence rejected the login"**: the token is wrong, expired or cut short. Store it again as
  above.
- **Preview catalogue shows nothing**: check the site, space key, root pages and labels in
  [Settings › Write targets](/settings/writing).
- **A draft fails with "no such section"**: the page changed while drafting. Re-draft.

## Outlook

- **"Microsoft 365 rejected the login"**: the connector is signed out on claude.ai. Sign it in
  again there (Settings → Connectors), then choose **Check again**. See
  [Reconnecting](outlook.md#reconnecting).
- **Connect says it can't find the connector**: add the Microsoft 365 connector on claude.ai first,
  or enter its ID in [Settings › Outlook](/settings/outlook).
- **"Microsoft 365 not working", saying it changed its tools**: Work OS stops reading Outlook
  rather than guess what the new tools mean. It needs an update; reconnecting won't help.
- **An email you expected isn't in the inbox**: receipts and automatic replies are skipped, and a
  poll reads at most 60 emails; the rest come on the next poll. With the calendar on, invitation,
  update and cancellation emails are left to the calendar: look for the invite's item instead.
- **The agenda says "Read 2 h ago"**: the calendar hasn't been read for three polls in a row.
  Check the health banner for Microsoft 365, or choose **Poll now** at the top of the inbox.
- **An invite you answered is still open**: it closes on the calendar's next poll, up to 30 minutes
  in work hours. One you never answered closes when the meeting starts.
- **An invite closed though you never answered it**: it was moved more than two weeks ahead, which
  looks the same as deleted. Once it is within two weeks again and still unanswered, it is triaged
  again.

## Wispr Flow

- **"Wispr Flow rejected the login"**: the sign-in lapsed or was removed. Choose **Reconnect** in
  [Settings › Wispr Flow](/settings/wispr). See [Reconnecting](wispr-flow.md#reconnecting).
- **Connected, but no meetings arrive**: check that Cloud Sync is on in the Wispr Flow app, and
  that the meeting has finished processing there.
- **"Wispr Flow not working", saying it changed its MCP tools**: Work OS stops reading rather than
  guess what the new tools mean. It needs an update; reconnecting won't help.

## Claude

- **"Claude rejected the login"**: run `claude login` in Terminal, then Check again.
- **Usage limit reached**: triage waits and resumes when the limit resets. Rules still decide in
  the meantime, so VIP DMs still reach Now.
- **Work OS will not start because `ANTHROPIC_API_KEY` is set**: Work OS uses your Claude
  subscription and refuses an API key, so usage is never billed by accident. Remove it with
  `launchctl unsetenv ANTHROPIC_API_KEY` and from your shell profile.

## Safe mode

If the server crashes more than five times in ten minutes, it starts in safe mode: the inbox works
but nothing is polled. Check the log in the data folder's `logs/`, fix the cause, then Check again.
