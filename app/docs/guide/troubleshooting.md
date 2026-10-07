---
title: Troubleshooting
group: Help
order: 80
summary: What the health banner means, storing tokens, and what to do when something stops.
updated: 2026-10-07
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

## Keychain tokens

Tokens live in the macOS Keychain under the service `com.polestar.workos`:

| Account | Holds |
|---|---|
| `slack-user-token` | the Slack user token (`xoxp-…`) |
| `confluence-api-token` | your Atlassian email and API token, as `email:token` |

The `security` command's password prompt keeps only the first 128 characters, and an Atlassian
token with your email is longer than that. So pass the value as an argument instead. Copy the full
`email:token` to the clipboard, then run:

```
security add-generic-password -U -s com.polestar.workos -a confluence-api-token -w "$(pbpaste)"
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
