---
title: Dev and prod
group: Start here
order: 20
summary: The two instances of Work OS, which one writes for real, and how a change reaches the one you use every day.
updated: 2026-10-07
---

Work OS can run as two separate instances on the same Mac. They never share data.

| | Dev | Prod |
|---|---|---|
| Started by | `npm run dev`, by hand | launchd, at login; restarted after a crash |
| Runs | the source code, restarting on every change | a built, smoke-tested release |
| Data | `~/WorkOS-data-dev` | `~/WorkOS-data` |
| Address | 127.0.0.1:5173 (the web app) and 4318 (the server) | 127.0.0.1:4317 |
| Dry-run | always on, whatever Settings says | follows the Settings switch |

Dev is where the code changes, so it can never write to Confluence or your vault. Prod runs a
frozen release, and only prod writes for real.

The Slack and Confluence tokens in the Keychain are shared by both. Each instance has its own
token for the web app, created on first start.

## Installing prod

From the `app` folder:

```
npm run deploy
npm run agent:install
npm run agent:status
```

`deploy` builds and smoke-tests a release under `~/Library/Application Support/WorkOS`.
`agent:install` installs the launchd agent and starts it. `agent:status` should show every line
ticked: the plist, launchd running, no `ANTHROPIC_API_KEY`, and health normal.

Prod starts with default settings. Bring your VIPs, channels, rules, vault path and Confluence
scope across, or set them again in prod's Settings. The inbox fills from Slack on the first poll.

## Shipping a change

After a change has been tried in dev, `npm run deploy` again. It builds a new release, swaps it in
and restarts the agent. Settings, data and prompt edits in `~/WorkOS-data` are kept.

## Turning dry-run off

Keep it on in prod for the first day and check the drafts. Then turn it off in
[Settings › Write targets](/settings/writing). From then on, approved vault notes go to the real
vault and approved Confluence entries to the real pages.
