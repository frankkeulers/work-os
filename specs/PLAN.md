# Work OS: Plan and Requirements

Owner: Frank Keulers
Status: Draft v0.2, 6 Oct 2026 (v0.2 adds runtime robustness, autostart, offline handling, performance budgets and the multi-source groundwork)
Working name: Work OS (rename freely)

---

## 1. Summary

A local app on Frank's laptop that polls work sources, decides what each item needs, and lets Frank act on it with one click.

For every incoming conversation it answers three questions:

1. Does it need Frank's attention (now, today, or not at all), or is he waiting on someone else for it?
2. Should it go into the Confluence PRD context?
3. Should it become a note in the Obsidian vault?

Where the answer is yes, the UI offers an action. Claude drafts it, Frank approves it, and the app writes it.

The MVP covers Slack only. Later phases add Outlook, Teams, Plaud and more actions, until the app replaces the current Cowork scheduled tasks and becomes Frank's personal work OS.

### Design principles

1. **Code fetches, Claude decides, Frank approves, code writes.** No model reads sources through connectors in a loop, and no model writes to a shared system without approval. One narrow exception: a source that is only reachable through a claude.ai connector may be fetched with a relay call, where the model makes one fixed tool call and never sees the result (R2.5).
2. **Anthropic models only, on Frank's Claude subscription.** No API key. No third-party model providers.
3. **No database.** All state lives in local files: an append-only event log, JSON state files and settings.
4. **Every new source retires a scheduled task.** Running the new and old pipelines side by side is a failure mode, not a transition plan.
5. **Usage is measured, not assumed.** Every Claude call is logged with tokens and cost-equivalent.

### Timing

Phase 0 tasks (Slack app, baseline, labelling, spikes) come first because they're quick and unblock the build.

---

## 2. Goals, success criteria and kill criteria

### MVP goals

- Slack threads that need Frank are surfaced within one poll interval.
- Knowledge worth keeping reaches the vault or Confluence with one review click.
- The "Slack knowledge digest" scheduled task is retired.

### MVP success criteria (measured over 2 working weeks after cut-over)

| # | Criterion | Target |
|---|---|---|
| S1 | Precision of "now" + "today" attention labels on the labelled set | ≥ 80% |
| S2 | Recall of "now" items (nothing urgent missed) on the labelled set | ≥ 90% |
| S3 | Total daily Claude usage (Work OS + remaining scheduled tasks) | ≤ baseline measured in Phase 0 |
| S4 | Frank opens the dashboard (superseded by C3 and C4 once the cockpit ships: an inbox that stays open all day is always "opened") | ≥ 4 of 5 working days in week 2 |
| S5 | Writes to Confluence or vault without approval | 0 |
| S6 | Observations about people written to Confluence | 0 |
| S7 | Slack knowledge digest scheduled task | Disabled |

### Cockpit success criteria (`specs/cockpit/SPEC.md` §3, measured over 2 working weeks after Stage 3 ships)

| # | Criterion | Target |
|---|---|---|
| C1 | Share of Needs you exits closed by Frank's reply | ≥ 40% (a guess, to reset after the Stage 0 baseline) |
| C2 | False closes: closes by reply that Frank undoes, or reopens within 24 h | ≤ 2% of closes by reply |
| C3 | Needs you empty at 18:00 | ≥ 3 of 5 working days |
| C4 | Minutes a day with the item panel open | Down on the Stage 0 baseline |
| C5 | Now items done more than 4 h after their deadline | No increase on baseline |

C1 and C2 come from the event log (the projection counts closes and undos over 30 days) and show in Usage & health over the last 14 days. Kill criterion: C2 above 5% after one round of prompt tuning turns closing on reply back into a suggestion ("You replied · Mark done?", the setting in FR-8.3).

### Kill criteria

Stop or redesign if any of these hold:

- S1 below 70% after two rounds of prompt tuning.
- S4 not met in week 2 (it has become another inbox nobody checks).
- S3 exceeded by more than 50% after the batching fixes in section 8.

---

## 3. Phase 0: pre-build gates (no code)

| ID | Task | Owner | Why |
|---|---|---|---|
| P0-1 | Create an **internal** Slack app in the PSG workspace (Frank has done this before for PDW and Meridia). Request the user-token scopes in section 7.1 and install it to get a user token. **Done 6 Oct 2026: internal app installed, user token in the Keychain, the first poll fetched 222 threads.** | Frank | Internal apps are exempt from Slack's 2025 rate-limit cuts for non-Marketplace apps. Check at install time that the user scopes (`search:read`, `im:history`, `mpim:history`) don't trigger an admin-approval step that bot-only apps didn't. |
| P0-2 | Confirm the Claude Agent SDK runs on Frank's PSG Claude plan with no `ANTHROPIC_API_KEY` set. One test call with Haiku. **Done 6 Oct 2026: the first real triage run (about 9 Haiku calls) succeeded on the subscription, with no `ANTHROPIC_API_KEY`.** | Frank | Confirms subscription auth works on this plan, and records the usage it draws. |
| P0-3 | Measure the baseline: run the Slack digest prompt once with `claude -p --output-format json` and record `usage` and `total_cost_usd`. Repeat on a busy weekday. | Frank / Claude Code | Sets the S3 budget. |
| P0-4 | Build the labelled set: export 2 weeks of Slack threads Frank took part in or was mentioned in. Label ~200 threads for attention (now/today/none), confluence (y/n), vault (y/n). | Frank (Claude can pre-label for review) | Needed for the eval harness and thresholds. |
| P0-5 | Write down the vault conventions (frontmatter fields, note types, folders, linking rules) as a file the app can load. Source: Note Manager project. | Frank | Vault writes must match existing conventions. |
| P0-6 | List the Confluence pages the app may write to (allow-list of page IDs) and the space. | Frank | Limits the blast radius of Confluence writes. |
| P0-7 | Confirm FileVault is on. **Done: on since 6 Oct 2026 (`fdesetup status`).** | Frank | Local files will hold company messages. |
| P0-8 | Create a personal Atlassian API token for Confluence REST writes, and store it in the macOS Keychain. | Frank | Deterministic writes without an LLM in the loop. |
| P0-9 | Spike: confirm the claude.ai Microsoft 365 connector loads in a headless Agent SDK run started by launchd, and that a relay call (R2.5) returns the raw `outlook_email_search` result through a `PostToolUse` hook. Record whether the SDK init message reports connector status, and the tokens and latency per relay call. Gates Phase 2 email only. **Done, passed (findings below).** | Claude Code | Our own Graph app registration is unlikely to get admin consent. The connector is already approved for the tenant. |
| P0-10 | Spike: map Wispr Flow's local database (`~/Library/Application Support/Wispr Flow/flow.sqlite`). Identify the note and meeting tables and columns, choose cursor columns, confirm a read-only reader is safe in WAL mode while the app writes, and capture a schema fingerprint. Gates Phase 2 Wispr Flow only. **Done, passed (findings below).** | Claude Code | Local reads need no network, no tokens and no MCP, but the schema is undocumented. |
| P0-11 | Spike: sign in to Wispr Flow's official MCP server (`https://api.wisprflow.ai/connect/mcp`) from a headless Node process, list its tools, confirm meetings can be listed incrementally, and confirm the sign-in refreshes with no browser. Gates the Wispr Flow source through the MCP (amended from P0-10's local read, at Frank's choice). **Done, passed (findings below).** | Claude Code | The MCP is the only supported way meeting data leaves Wispr Flow, and it adds attendees and the share link. Its tool contract is undocumented. |
| P0-12 | Spike: the calendar through the same Microsoft 365 connector. Confirm the search window and paging, the time zones returned, whether Frank's own answer to an invite is readable, what identifies a recurring series, and whether mail marks meeting requests. Gates the calendar source (R2.8) only. **Done, passed with gaps (findings below).** | Claude Code | The agenda, invites and Wispr enrichment need the calendar; there is no other approved way to read it. |

### Phase 0 findings

**P0-9: Microsoft 365 connector relay (6 Oct 2026, Agent SDK 0.3.291, Claude Code 2.1.282).** Passed, from a shell and from a one-shot launchd job in the login session.

Results:
- **Auth:** subscription login (`apiKeySource: none`), with no Keychain prompt under launchd.
- **Connector:** `connected`. The model made exactly one `outlook_email_search` call and replied "OK".
- **Hook:** the `PostToolUse` hook captured the raw result; the model saw only "ok".
- **Per call:** $0.009 cost-equivalent, about 6 s, about 6.9k input tokens.
- **Per day:** about $0.25 at the default schedule.

Findings that change the design (R2.5, CL-9):
- **claude.ai connectors load asynchronously in headless runs.** A short call finishes before they connect, and the init message lists no servers. `ENABLE_CLAUDEAI_MCP_SERVERS` only disables them. So the relay must declare the connector explicitly: `mcpServers: { ms365: { type: 'claudeai-proxy', url: 'https://mcp-proxy.anthropic.com/v1/mcp/<serverId>', id: '<serverId>' } }` with `strictMcpConfig: true`. This also keeps the other connectors out of the call.
- **The server id is account-specific, not a secret.** It goes in `settings.sources.outlook.connectorId`, captured by a one-off setup command. The spike read it from the CLI debug log. In implementation, try `query().mcpServerStatus()` first: it reports each server's config, including `id`.
- **Trim the tool list.** Loading the connector exposes all 50 Microsoft 365 tools (about 31k tokens, $0.068 per call). Passing the other 49 in `disallowedTools`, read from the init message's tool list, removes them from the model's context and cuts the cost about 7×. Also set `tools: []`, so no Claude Code built-in tools load.
- **Don't list the relay tool in `allowedTools`.** That auto-approves it and bypasses `canUseTool` (the SDK warns about this). Gate it with `canUseTool` alone, which allows only that tool.
- **Confirmed option names:** `PostToolUse` returns `hookSpecificOutput.updatedToolOutput`. The init message carries `mcp_servers[{name, status}]` and `apiKeySource`.
- **Result shape:** an array of text blocks, one JSON email per block, plus a final paging item (`nextOffset`). Each email has `uri`, `id`, `subject`, `sender`, `recipients`, `receivedDateTime`, `sentDateTime`, `summary` (a short preview), `hasAttachments`, `importance`, `isRead`, `webLink` and `internetMessageId`. That is enough for triage. Full bodies need a second tool, `read_resource`, only when drafting.
- **Pagination:** at most 25 per page. Use `afterDateTime` with `folderName: 'Inbox'` (no `query`) and page with `offset`. Dedupe on `internetMessageId`.

**P0-9 addendum: the Outlook spike (8 Oct 2026, `npm run spike:outlook`, Agent SDK 0.3.293).** Passed. It changes R2.5 and answers open question 6.
- **Discovery:** `query().mcpServerStatus()` in streaming-input mode, with nothing sent, lists every claude.ai connector with its `config.id`, status and tools in 2–4 s. There is no model turn and no tokens, so setup needs no debug log.
- **Cost is far below P0-9:** with the other 49 tools hidden, a search run is about 1.2k input tokens, $0.0005–0.0011 and 5–6 s. P0-9's $0.009 was measured with the full tool list.
- **Batching works:** one run read 10 emails with `read_resource`: 10 of 10 read, none refused, 11 turns (Haiku made the calls one after another, not in parallel), $0.0027 and 10 s. So `maxTurns` is n + 1.
- **Search shape:** a preview only (`summary`, 255 chars, including the external-sender banner), the sender as a bare address, recipients as a flat address list, and **no `conversationId`**. With `folderName` and `order: 'oldest'` the results come oldest first and the paging item is `{moreResults, nextOffset, totalResultCount}`, or `{totalResultCount}` on the last page.
- **Read shape:** `body` (HTML, up to 33k chars seen), `sender {name, address}`, `toRecipients`, `ccRecipients`, `attachments[{name, isInline, …}]`, `flag`, `categories`, `conversationId` (80 chars, `[A-Za-z0-9=_-]`), `internetMessageId` (up to 242 chars) and `parentFolderId`.
- **No `/O=` senders** among 11 Inbox and Sent Items emails, though the tool documents them.
- **`get_me`** returns `{id, displayName, userPrincipalName, mail, jobTitle}`. A call with no arguments must be asked for in words: shown `{}`, Haiku sent `{"arguments":"{}"}`, which the argument gate refused.

**P0-10: Wispr Flow database (6 Oct 2026, Wispr Flow 1.6.1034).** Passed.

Database:
- **Access:** WAL mode. A read-only `node:sqlite` connection (`readOnly: true`, `query_only`) opened and read every meeting in 12 ms while the app was running.
- **No side effects:** the database, `-wal` and `-shm` files were unchanged afterwards, and a write attempt was refused. Tested on Node 24.16; confirm the minimum Node version for `node:sqlite` with `readOnly` before relying on Node 22.

Where the data is:
- **`Meetings` table** holds everything: 22 rows, 21 not deleted, since 30 Sep 2026. Useful columns:
  - `id`, `title`, `createdAt`, `modifiedAt`, `endedAt`
  - `finalized`, `refineStatus` (`complete`, or `transcribing` while in progress), `isDeleted`
  - `summary` (markdown text with headings and bullets, about 3 KB)
  - `notes` (short text), `participantNames` (currently empty)
- **Other tables:** `Notes`, `NoteVersions`, `MeetingVersions` and `Todos` exist but are empty for this account. Keep them on the allow-list, but expect them to be empty.
- **Transcripts** are outside the database, in `meetings/<id>/refined.ndjson`, one JSON line per utterance (`id`, `speaker`, `text`, `timestamp`). Each folder also holds raw audio (`upload.ogg`), which is never read.

Read rules:
- **Cursor:** `Meetings.modifiedAt` plus `id`. It is stored as text in `YYYY-MM-DD HH:MM:SS.mmm +00:00`, always UTC, so it sorts lexically.
- **Filter:** `isDeleted = 0 AND finalized = 1 AND refineStatus = 'complete'`. A meeting still transcribing is picked up when its `modifiedAt` changes.
- **Triage input:** triage reads `summary` and `notes` (R2.3). The transcript is read only for vault drafts.

Schema fingerprint: SHA-256 over `PRAGMA table_info` of `Meetings`, `Notes` and `Todos`, prefix `fd93d2789cea77ff`. A concurrent-writer test belongs to the reader's unit tests, against a synthetic database.

**P0-11: Wispr Flow MCP (8 Oct 2026, server `wispr-meetings` v1, MCP SDK 1.32.1, Wispr Flow 1.6.1074).** Passed. The script is `npm run spike:wispr` (`apps/server/src/cli/wispr-spike.ts`); it prints shapes and counts only.

Sign-in:
- **OAuth 2.1 with dynamic client registration and PKCE** through the SDK's `OAuthClientProvider`. The authorisation server is `mcp-auth.wisprflow.com`. Scopes `openid offline_access`, a public client (no secret) and a loopback redirect to `127.0.0.1` all work.
- **Tokens:** a bearer access token valid for 7 days (`expires_in` 604800) and a refresh token.
- **Refresh with no browser works:** `auth()` returned `AUTHORIZED` in 1.3 s. **The refresh token rotates on every refresh**, so the stored copy must be replaced each time, by one writer.
- **Speed:** connect about 1 s, then about 0.7 s per tool call.
- **Not measured:** how long an unused refresh token lasts, and the rate limit (docs: wait a minute after "Too many requests").

Tools: 15, all annotated `readOnlyHint: true`. The source uses four of them (schemas in `apps/server/src/sources/wispr/fixtures/tools.json`):
- `get_account_info()`: the user's name and display-name aliases.
- `search_meetings(query?, since?, until?, limit?, cursor?, …)`: with no query, meetings **newest-modified first** (checked across 3 pages, 25 meetings). `since`/`until` filter on the meeting's start, not on `modified_at`. Page size up to 200, opaque `next_cursor`, capped at 1000 results per query.
- `get_meeting(meeting_id, view_content?, view_transcript?)`: everything for one meeting in one call.
- `get_meeting_participants_enriched(meeting_id)`: the user (with email) and each participant with `is_self`, `spoke`, `origin` and `relationship`.

Results come as `structuredContent` (the same JSON is also in a text block). Every timestamp is UTC ISO 8601 with microseconds, ending in `Z`.
- **Search result:** `id` (UUID), `title`, `content_excerpt`, `finalized`, `has_transcript`, `attendees`, `start`, `end`, `modified_at`, `share_link` (https, the meeting's notes page in Wispr Flow).
- **Meeting:** adds `content` (Frank's own notes, markdown), `summary` (markdown with `###` sections; action items are under `### Next Steps`), `todos` (empty so far) and `transcript`.
- **Transcript:** plain text, one `Speaker: text` turn per line, between two `<<<…>>>` fence lines. Unknown speakers are `Speaker 1`, `Speaker 2`. It is bounded (default 12,000 characters, maximum 40,000) and ends with `(...truncated, N chars remaining; continue with view_transcript.start_char=M...)` when more remains.
- **Attendees** come only from a linked calendar event: none of the 25 meetings had any. Participants from the speaker map have names but no emails.

Read rules:
- **Cursor:** `modified_at` plus `id` of the newest meeting seen. A poll pages `search_meetings` with no query until it reaches a meeting at or before the cursor. Meetings are processed oldest first, so the cursor only moves forward.
- **Filter:** `finalized = true`. A meeting that is not finalised yet is picked up when its `modified_at` changes.
- **Triage input:** `summary` and `content` (R2.3). The transcript is fetched only when drafting (vault or Confluence).
- **Permalink:** `share_link`. A meeting without one falls back to `wispr-flow://`, the scheme the app registers.

---

**P0-12: the calendar spike (8 Oct 2026, `npm run spike:calendar`, Agent SDK 0.3.293).** Passed with gaps. It shapes R2.8. Shapes and enumerations only were printed.
- **Search** (`outlook_calendar_search`, `query: '*'`, `afterDateTime`/`beforeDateTime`, `order: 'oldest'`) returns occurrences in start order, 25 a page, with the same paging item as mail (`{moreResults, nextOffset, totalResultCount}`). Yesterday to 14 days ahead held more than 25 events, so a poll pages. One search run: $0.0008, 6 s.
- **Times are UTC** (`start.timeZone: 'UTC'` on every event), as 27-character wall-clock strings with no `Z`. A mailbox time zone is still possible, so the reader converts named zones too.
- **Search fields:** `uri`, `id`, `subject`, `organizer` (an address), `attendees` (addresses only, or null), `start`, `end`, `showAs` (busy/free seen), `isAllDay`, `isCancelled`, `isOrganizer`, `importance`, `categories`, `webLink`, `summary` (Teams join text) and `recurrence` (null on every occurrence). There is **no response status and no modified time** in search.
- **Read** (`read_resource`, 10 in one run: 11 turns, $0.0017, 8 s) adds `organizer {name, address}`, `attendees [{name, address, type, responseStatus, responseTime}]`, `lastModifiedDateTime`, `body` (HTML), `onlineMeeting` and `meetingTranscriptUrl` (3 of 10), `sensitivity`.
- **Frank's answer is his own attendee entry:** `responseStatus` is `none`, `accepted`, `tentativelyAccepted` or `declined`. He was an attendee on 7 of 10 events and the organiser of 3. There is no event-level `responseStatus` or `responseRequested`.
- **No series identity:** no `seriesMasterId`, `type` or `iCalUId`, and `recurrence` is null on occurrences. A recurring meeting is a run of unrelated events.
- **Mail doesn't mark meeting requests:** a read email has no `@odata.type`, `meetingMessageType` or event link, so mail can only spot invites by subject.
- **Not settled read-only:** whether a reschedule resets Frank's answer, and whether events he declined stay in search. R2.8 copes with either.
- **Categories (9 Oct 2026, `spike:calendar categories`):** search gives each event's category names (`categories`, strings); 15 of 25 events had one, 3 names, none a preset name such as "Red category". The colours aren't readable: `read_resource` refuses every URI but messages, folders and events, and no tool lists the master category list (only create, update and delete take a colour). So Frank picks the colours in Settings.

## 4. Architecture

```
            ┌────────────────────────── Backend server (Node 22 + TypeScript, localhost only) ──────────────────────────┐
            │                                                                                                            │
 Slack  ──► │  Source adapters ──► Normaliser ──► Event log (JSONL) ──► Quiet-window check ──► Rules ──► Haiku triage   │
 (later:    │  fetchSince(cursor)   Item/thread    + item files           (thread idle ≥ N min)   (config)   (batched)    │
 Outlook,   │                                                                                                   │        │
 Teams,     │                                                                                                   ▼        │
 Plaud)     │                         Action executor ◄── Approval ◄── Draft (Sonnet + skill) ◄── Inbox state        │
            │                         (code writes:                                                                     │
            │                          vault file, Confluence REST)                                                     │
            │                                                                                                            │
            │  Usage logger · Scheduler · Settings · SSE stream to UI                                                    │
            └────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                                   ▲
                                                   │ HTTP + SSE (127.0.0.1, token-protected)
                                                   ▼
                                    React frontend (Vite + TypeScript + Tailwind)
```

### 4.1 Stack

| Layer | Choice | Notes |
|---|---|---|
| Backend | Node 22, TypeScript, Fastify | One process. Binds to `127.0.0.1` only. |
| Frontend | React, TypeScript, Vite, Tailwind | Served by the backend in production, Vite dev server in development. |
| Shared types | `packages/shared` with zod schemas | One source of truth for Item, Decision, Action, Event. |
| Claude | `@anthropic-ai/claude-agent-sdk` (TypeScript) | Authenticates through the local Claude Code login. |
| Slack | A small Web API client on `fetch` with a user token | Read-only scopes. Chosen over `@slack/web-api`: our breaker is the only retry policy, every call takes the deadline and sleep signal, and there is no axios in the bundle. |
| Confluence writes | Confluence Cloud REST API v2 | Atlassian API token from Keychain. |
| Secrets | macOS Keychain (`security` CLI or `keytar`) | Never in settings files or logs. |
| Real-time UI | Server-Sent Events | No websockets needed. |
| Logging | pino (JSON lines) | Daily files. |
| Process supervision | launchd LaunchAgent (`com.polestar.workos`) | Starts at login, restarts only after a crash (FR-12.3, FR-14.1). Runs a deployed release, never the repo. |
| Notifications | `terminal-notifier` | `osascript` notifications can't open the item when clicked (FR-11.1). |

### 4.2 Repo layout

```
work-os/
  CLAUDE.md
  PLAN.md                     (this file)
  apps/
    server/
      src/
        sources/              adapter interface (R2.1) and registry
        sources/slack/        adapter: fetchSince, normalise
        pipeline/             poll (per source), quietWindow, rules, triage, outbox
        actions/              drafters (vault, confluence), executors
        claude/               single adapter around the Agent SDK + usage logging, connector relay (R2.5)
        store/                event log, item files, snapshots, cursors, atomic writes, startup recovery
        runtime/              lock, clock, sleep/wake detection, supervisor, scheduler, shutdown, startup checks
        net/                  timeouts, error classification, backoff, circuit breakers, probes, dependency health
        notify/               macOS notifications and rate-limited health alerts
        api/                  REST routes + SSE
        config/               settings loader + validation, Keychain access
    web/
      src/                    inbox, item detail, action preview, settings, usage
  packages/
    shared/                   zod schemas + types
  prompts/                    default prompt templates (copied to data dir on first run)
  scripts/
    eval.ts                   runs triage over labels, reports precision/recall/usage
    rebuild-state.ts          rebuilds snapshot from the event log
    gen-data.ts, perf.ts      synthetic data and the performance budget check (NF-11)
    launchd/                  LaunchAgent plist template, install/uninstall/status, deploy
```

### 4.3 Data directory (no database)

All runtime data lives outside the repo, default `~/WorkOS-data/` (configurable via `WORKOS_DATA_DIR`).

```
~/WorkOS-data/
  config/
    settings.json             sources, schedules, model map, budgets, allow-lists, VIPs
    settings.last-good.json   last settings that passed validation (FR-1.2)
    rules.json                deterministic triage rules
    vault-conventions.md      vault filing guidance (P0-5), built-in default from the vault's Notes System note
    psg-context-builder.md    Confluence routing guidance, built-in default from the psg-context-builder skill
    prompts/
      triage.md
      topics.md
      settle.md               does Frank's reply settle the asks (cockpit CK-2.2)
      pick-confluence.md
      draft-vault.md
      draft-confluence.md
      people-check.md
  state/
    cursors.json              last cursor per source
    snapshot.json             materialised inbox state (rebuildable from events), with lastSeq
    lock                      single-instance lock: pid, process start time, boot time, instance, port
    refused.json              written when startup is refused (CL-2)
  events/
    2026-10-20.jsonl          append-only event log (the audit trail), one file per UTC day
    quarantine/               torn or unreadable lines moved aside at startup
  items/
    slack/<itemId>.json       raw thread content (subject to retention)
  drafts/
    <actionId>.json           draft content + target + base version
  labels/
    triage.jsonl              labelled set + corrections from the UI
    settle.jsonl              settle checks Frank showed wrong: an Undo, or a Done soon after "not settled" (cockpit CK-2.6)
  logs/
    app-2026-10-20.log
    usage-2026-10-20.jsonl    one line per Claude call
    launchd.out.log           output from before the logger starts (truncated by size)
```

Performance reports (`npm run perf`) run on synthetic data, never this directory, and go to `app/logs/perf-<timestamp>.json` in the repo (ignored by git).

The deployed release lives outside the data directory, in `~/Library/Application Support/WorkOS/releases/<version>/` with a `current` symlink. Development uses a separate data directory, `~/WorkOS-data-dev`, a separate port and dry-run forced on, so it never contends with the autostarted instance for the lock.

Rules for file storage:

- **The event log is the source of truth.** `snapshot.json` is a cache, rebuilt from events by `scripts/rebuild-state.ts` and on corruption. Every event carries a gap-free `seq` and a typed payload, so the log alone can rebuild the inbox. The snapshot records the `lastSeq` it covers, and startup replays only the events after it.
- **Atomic writes**: write to `*.tmp`, `fsync`, then `rename`, then `fsync` the directory. Appends to JSONL use a single writer with group commit: one write and one sync per batch, and a command returns only after its event is synced.
- **Write order in a poll**: item files, then events, then `source.polled` with the cursor, then `cursors.json`. A crash at any point re-fetches and dedupes.
- **Startup recovery**: a torn last line in a JSONL file is truncated and quarantined, leftover `*.tmp` files are deleted, and a missing item file is re-fetched.
- **Single instance**: take a lock on `state/lock` at startup and refuse to start if it's held by a live process. A lock left by a dead process, a reused pid or a previous boot is stale and taken over.
- **Retention**: delete raw content in `items/` older than `retention.rawContentDays` (default 30). Events keep IDs, decisions and permalinks, never message bodies. Decisions are logged without their free text (summary, reason, the wording of the next step): that text paraphrases the messages, so it is stored with the raw content in `items/` and expires with it.
- **Schema versioning**: every file and event carries `schemaVersion`.
- **No secrets** in any file under the data directory.

### 4.4 Core types (sketch)

```ts
type SourceId = 'slack' | 'outlook' | 'teams' | 'plaud' | 'wispr';

interface Item {                 // one conversation unit: a Slack thread or DM window
  id: string;                    // e.g. "slack:C123:1728031234.000100"
  source: SourceId;
  kind: 'thread' | 'dm' | 'email' | 'meeting';
  title: string;                 // channel name or subject
  permalink: string;
  participants: { id: string; name: string }[];
  messages: { id: string; authorId: string; ts: string; text: string }[];
  lastActivityAt: string;        // ISO
  revision: number;              // increments when new messages arrive
  schemaVersion: 1;
}

type Attention = 'now' | 'today' | 'follow' | 'none'; // follow: amendment to FR-8.1

interface TriageDecision {
  itemId: string;
  itemRevision: number;
  attention: Attention;
  confluence: { suggested: boolean; targetHint?: string };
  vault: { suggested: boolean; targetHint?: string };
  containsPeopleObservations: boolean;
  summary: string;               // one line
  reason: string;                // one short sentence
  decidedBy: 'rule' | 'model';
  ruleId?: string;
  model?: string;
  promptVersion?: string;
  decidedAt: string;
}

type ActionType = 'vault_note' | 'confluence_entry';
type ActionStatus = 'drafting' | 'ready' | 'approved' | 'executing' | 'done' | 'failed' | 'discarded';

interface Action {
  id: string;
  itemId: string;
  type: ActionType;
  status: ActionStatus;
  target: { path?: string; pageId?: string; baseVersion?: number };
  draftRef: string;              // drafts/<id>.json
  error?: string;
}

type EventType =
  | 'item.upserted' | 'triage.decided' | 'triage.corrected'
  | 'triage.confirmed'           // Frank said the decision for this revision was right (FR-6.2)
  | 'item.done'                  // data, when not Frank's click: { by: 'source' | 'reply', ... } (cockpit CK-2.2)
  | 'item.reopened' | 'item.snoozed'
  | 'item.unsnoozed'             // the snooze time passed (FR-8.3)
  | 'item.seen'                  // opening the item cleared "new replies" or "back from snooze"
  | 'item.notified'              // logged even when quiet hours held it back, so it never repeats (FR-11.2)
  | 'action.requested' | 'action.drafted' | 'action.edited' | 'action.approved'
  | 'action.executing'           // fsynced before every write attempt (FR-14.5)
  | 'action.executed' | 'action.failed' | 'action.discarded'
  | 'source.polled' | 'source.failed'
  | 'settle.checked'             // a settle check's answer for a revision: allSettled, the askIds settled (cockpit CK-2.2)
  | 'settle.failed'              // the check got no usable answer; tried up to 3 times
  | 'system.started' | 'system.stopped' | 'system.woke' | 'health.changed';

interface WorkEvent {
  seq: number;                   // gap-free, global across day files
  id: string;
  type: EventType;
  at: string;                    // ISO, UTC
  itemId?: string;
  actionId?: string;
  data?: EventPayloads[EventType]; // typed per event type; never message bodies
  schemaVersion: 1;
}
```

Every change to inbox or action state is an event, so replaying the log rebuilds the state exactly. `packages/shared/src/projection` holds the one reducer the server and the mock both use. `action.drafted` carries the write target, `action.requested` the action it supersedes. Bump `PROJECTION_VERSION` whenever the reducer changes, so the server replays the whole log instead of trusting `snapshot.json`.

---

## 5. Claude usage design

### 5.1 Model map (configurable in `settings.json`)

| Purpose | Default model | Call shape |
|---|---|---|
| Triage | Haiku 4.5 (`haiku`) | One batched call per poll, only when threads are eligible. No tools, no MCP, short custom system prompt, single turn, JSON output. |
| Settle (cockpit CK-2.2) | The triage model | After a poll brings in Frank's reply to an open item that awaits one: does the reply settle the open asks? Batched, at most 20 per call. No tools, no MCP, its own short prompt (`config/prompts/settle.md`), JSON output. Counts towards the triage budget. |
| Draft vault note | Sonnet 5.5 (`sonnet`) | Per click. Read-only vault access to find related notes. Output is the final markdown file. |
| Draft Confluence entry | Sonnet 5.5 (`sonnet`) | Per click. Read-only Confluence access to choose the page and section. Output is a structured patch. |
| Multi-source synthesis (later) | Opus 5.5 (`opus`) | Rare. Briefs and weekly reviews. |

### 5.2 Hard requirements for every Claude call

- **CL-1** All calls go through one module, `apps/server/src/claude/`. Nothing else imports the SDK.
- **CL-2** On startup the server refuses to run if `ANTHROPIC_API_KEY` is set. The goal is subscription usage, and the SDK would silently prefer the key. Under launchd it sends a macOS notification, writes `state/refused.json` and exits with code 0, so launchd does not restart it in a loop. Run interactively, it exits with code 78.
- **CL-3** Each call sets its model, system prompt, allowed tools, MCP servers, setting sources and max turns explicitly. Defaults are not trusted. Check option names against the current Agent SDK docs before implementing.
- **CL-4** Triage calls load **no** Claude Code system prompt preset, **no** tools, **no** MCP servers and **no** filesystem settings. This keeps the per-call overhead to the triage prompt itself.
- **CL-5** Every call appends to `logs/usage-*.jsonl`: timestamp, purpose, model, input/output/cache tokens, cost-equivalent, duration, item IDs, prompt version.
- **CL-6** Daily budgets in settings (`budgets.triageCallsPerDay`, `budgets.draftsPerDay`, `budgets.costEquivalentPerDay`). When a budget is hit, the triage queue pauses, rules-only triage continues, and the UI shows a banner.
- **CL-7** Model outputs are validated with zod. On a schema failure, retry once, then mark the item `triage_failed` and show it in the inbox untriaged.
- **CL-8** The adapter is swappable. One setting switches the backend to an API key or Bedrock without changes elsewhere, in case subscription terms change.
- **CL-9** Relay calls (R2.5) allow exactly one connector tool and deny every other tool.
  - **Connector:** declared explicitly (`claudeai-proxy`, `strictMcpConfig: true`).
  - **Other tools:** `tools: []`; the connector's other tools go in `disallowedTools`; the relay tool is gated by `canUseTool`, never `allowedTools`.
  - **Result:** a `PostToolUse` hook hands the raw result to code and replaces it with "ok" (`updatedToolOutput`) before the model sees it, so source content never enters the model's context.
  - **Logging:** relay calls are logged with purpose `fetch`.

  See the P0-9 findings.
- **CL-10** Every call has a timeout (triage 120 s, drafts 240 s) and is aborted on sleep or shutdown. Claude calls do not start during a brief Power Nap wake: the machine must have been awake for at least 45 s (FR-14.2).

As built (M2 step 14), checked against the Agent SDK 0.3.291 types and the P0-9 spike:

- Every call sets these explicitly:
  - `model`, `systemPrompt` (a plain string, so no Claude Code preset);
  - `tools: []` and `allowedTools: []`;
  - `mcpServers` (empty except for a relay) with `strictMcpConfig: true`;
  - `settingSources: []`, `maxTurns`, `permissionMode: 'default'`, and a deny-all `canUseTool`.
- It also sets `thinking: disabled` and `persistSession: false`. The second keeps message text out of `~/.claude/projects`.
- The SDK gets its own environment: the account variables are stripped, then set for the chosen backend (CL-8). An API key comes only from the Keychain account `anthropic-api-key`.
- The SDK is imported lazily on the first call, and deploy installs it into the release as an external package.
- Failures are classified from the SDK's typed assistant `error`:
  - login problems → `auth_failed`;
  - `rate_limit` or `billing_error` → `rate_limited` for 15 minutes;
  - everything else → `degraded`.
- A call that throws on the network counts as offline, and the probe confirms it. The deadline is a `timeout`; a sleep or shutdown abort passes through unchanged.
- Usage is logged for every call that returns a result, failed ones included, from the SDK's per-model totals.
- Model names: `haiku-4.5` → `claude-haiku-4-5`, `opus-5.5` → `claude-opus-5-5`. The settings ID `sonnet-5.5` is mapped to `claude-sonnet-5`, because there is no Sonnet 5.5; **the settings label needs a decision**.

### 5.3 Batching rules (to stay under the baseline)

- Triage only threads that have been quiet for `quietMinutes` (default 10). VIP rules bypass the wait.
- Batch all eligible threads into one call, up to `triage.maxThreadsPerCall` (default 25) and `triage.maxInputTokens`.
- Truncate long threads: keep the first message, the last N messages and any message mentioning Frank.
- Re-triage a thread only when its `revision` changes and the new messages are not from Frank alone. An open item in Needs you or This week that awaits Frank's reply gets a settle check instead (cockpit CK-2.2).
- Skip the call entirely when nothing is eligible.

As built (M2 step 13):

- Rules run in the poll, on every item with new messages from someone other than Frank. A `drop` rule keeps a new thread out altogether, but never removes an item that is already stored. A `now` or `today` rule logs its `triage.decided` (`decidedBy: rule`) in the same append as the upsert, so the item never waits for the quiet window. A `model` rule's `min` is applied to the model's answer in step 15.
- The queue (`pipeline/eligibility.ts`) holds pending items that have been quiet for `quietMinutes`, oldest first, and reports when the next one goes quiet.
- Truncation keeps the first message, the last `keepLastMessages`, and every message that mentions Frank (`<@id>` or "@handle"). It sends a count of the rest, and cuts any single message at 2,000 characters. Threads are packed in order within `maxThreadsPerCall` and `maxInputTokens` (estimated at four characters per token, prompt included); a thread too big for any batch goes alone.

As built (M2 step 15):

- Triage runs from the 5 s tick and straight after each poll, one run at a time. It runs only when Claude may be used: awake for 45 s (CL-10), not offline, and the `claude` breaker ready. The breaker's half-open trial is used only by a run that actually calls the model.
- The prompt lives in `config/prompts/triage.md`, written on first run and read on every call. Its version is the declared name plus a hash of the text, so an edit shows in the usage log even if the name isn't bumped.
- The budget (CL-6) is checked before every batch. Once it is spent, the queue waits and is rechecked every 15 minutes; rules still decide at ingest.
- Each decision is for the revision the model saw. The decision's text goes into the item file under the item's lock, and only if the file is still that revision; then `triage.decided` is logged. A thread that moved on during the call is triaged again at its new revision.
- An answer that fails zod twice logs `triage.failed` for its batch (CL-7). An item missing from the answer, or whose file is gone, fails on its own. "Try again" (`POST /api/items/:id/retry-triage`) triages that item at once, whatever its quiet window. It answers 429 when the budget is spent, and 503 when Claude can't be called.
- A model rule's `min` is a floor on the model's answer. It is checked against the topic's messages after Frank's last one, so once he has answered, the model's answer stands; with nothing after his last message there is no floor. When a floor or a To file rule changes the model's answer, the decision keeps it as `modelAttention`, and Triage details shows both. A thread with observations about people never gets a Confluence suggestion.
- The poll now writes each item under the same per-item lock. A reply whose file was written but never logged (a crash in between) is recovered on the next poll.
- Tests and `--fakes` runs use a keyword-based fake model and never call Claude.

---

## 6. MVP scope (Slack only)

### In scope

- Slack polling with a user token, catch-up from cursors.
- Thread-level items, quiet window, rules, batched Haiku triage.
- Inbox UI with lanes, item detail, mark done, snooze, correct triage.
- Two actions with preview and approval: vault note, Confluence entry.
- macOS notification for "now" items.
- Usage log, budgets, usage panel.
- Eval harness over the labelled set.
- Retirement of the Slack knowledge digest scheduled task.

### Out of scope for MVP

- Any other source.
- Sending messages or replies anywhere.
- Auto-execution of any write without approval.
- Running anywhere other than Frank's laptop.
- Multi-user access.

### Outcome

Frank sees what needs him in Slack within 10 minutes, and files knowledge with one review click, at or below today's Claude usage.

### Milestones and epics

| Milestone | Epics | Rough effort with Claude Code (guess) |
|---|---|---|
| M1 Ingest and store | E1 Settings and storage · E2 Slack polling · E3 Read-only inbox · E13 Runtime robustness (autostart, sleep, offline, degraded mode) | 6–8 days |
| M2 Triage | E4 Rules · E5 Haiku triage · E6 Eval and feedback · E7 Usage tracking | 3–4 days |
| M3 Actions | E8 Vault note action · E9 Confluence entry action · E10 Notifications | 4–5 days |
| M4 Cut-over | E11 Hardening · E12 Retire the digest and measure | 2–3 days + 2 weeks of measurement |

Robustness lands in M1, not M4: the server runs unattended from the first milestone, so autostart, sleep and offline handling, crash recovery and degraded mode (E13, section 7.14) are built before triage.

---

## 7. MVP requirements

### 7.1 E1 Settings and storage

**FR-1.1** The server creates the data directory structure on first run and copies default prompts into `config/prompts/`, and the default filing guidance into `config/vault-conventions.md` and `config/psg-context-builder.md`. A prompt or guidance file that still holds an earlier built-in default (byte for byte, once trimmed) is replaced by the current default at start; an edited file is never touched. An empty or missing file means the built-in default.

**FR-1.2** `settings.json` is validated with zod at startup. If it is invalid, the server does not stop: it logs a clear message, falls back to `settings.last-good.json`, and runs in degraded mode with the error shown in the UI (FR-14.6). With no good copy, the server stays up with every source paused until the settings are fixed. A stopped server would be invisible when it starts unattended at login.

**FR-1.3** Settings include at least: data dir, poll schedule (work hours, interval in work hours, interval off hours), Slack channel include/exclude lists, VIP user IDs, quiet minutes, model map, budgets, retention days, Confluence scope (site, space key, root pages, labels, excluded pages and single pages; amended from an allow-list of page IDs, see FR-10.2), vault path, dry-run flag. Per-source schedules live in an optional `sources.<id>` block (`enabled`, `intervalWorkMinutes`, `intervalOffMinutes`, where `null` means work hours only), with defaults, so existing settings stay valid. Defaults: Slack 10 / 60 min, email 30 / 120 min, Wispr Flow 180 min in work hours only.

**FR-1.4** The event log, item files, cursors and snapshot follow the storage rules in section 4.3.

**FR-1.5** The UI settings page edits `settings.json` and `rules.json`. Changes are validated before saving and logged as events. Each save sends the files the form had when the change was made, and the server applies only what changed from them (`mergeEdit`), so a change the server made meanwhile (Connect or Disconnect turning a source on or off, Wispr Flow's sign-in) is kept though the form hadn't caught up with it. Undo takes back only that save's change.

**FR-1.6** Dry-run mode (default **on** in development) redirects vault writes to `~/WorkOS-data/sandbox/vault/` and turns Confluence writes into logged no-ops.

**FR-1.7** Settings › Prompts lists the prompt files (triage, topics, settle, draft vault, pick Confluence, draft Confluence and people check) and the two filing guidance files with their versions, marks the ones that differ from the built-in default, and edits them with an explicit Save (not autosave: every Claude call reads its file fresh, so a half-typed edit would reach a real call). A save names the version it was edited from and fails as a conflict if the file changed on disk since. Reset to default asks first. Each change is logged as `prompt.changed`. The two guidance files name their sources in their header (`<!-- source: <id> sha1:<12 hex> -->`: the psg-context-builder and obsidian-vault-reader skills, the vault's Notes System note and llms.txt). The server compares each with the source as it is now and Settings marks the file "Source changed"; once the guidance has been checked against it, Mark reviewed records the current hashes. Tests and fakes never look at the real sources.

**FR-1.8** The app has a user guide at `/guide`, reached from a quiet sidebar link and from contextual links where a setting or failure needs explaining. Its pages are Markdown files kept in the repo (`app/docs/guide/`). The web build carries a copy; the server reads the folder on each request (`GET /api/guide`: `<slug>.md` files only, at most 100 of 256 kB each), and the page uses that when it can, re-reading it when the window regains focus, so an edit shows without a deploy. The folder is `WORKOS_GUIDE_DIR`, which `agent:install` sets to the repo's folder for prod; development reads the repo's copy. Without a readable folder (the mock, a moved repo, macOS refusing access to ~/Documents) the build's copy is shown, and the page says which copy it is. A file that doesn't parse keeps its built-in copy and the page names the problem. Raw HTML in them is not rendered. A test checks every page's front matter and that every link between pages, every anchor, every app route a page links to, and every contextual link into the guide still resolves. A change to what Frank sees updates the guide in the same commit.

> **Story 1.1** As Frank, I want all Work OS state in plain local files so that I can inspect, back up or delete it without a database.
>
> - Given a fresh install, when the server starts, then the data directory and default config files exist.
> - Given a corrupted `snapshot.json`, when the server starts, then it rebuilds state from the event log and logs a warning.
> - Given a second server instance, when it starts, then it logs the running instance's URL and exits because the lock is held (code 0 under launchd, 75 interactively).
> - Given the laptop lost power while the server was running, when it starts after the reboot, then it takes over the stale lock and recovers any torn event line.

### 7.2 E2 Slack polling

**FR-2.1** User-token scopes, all read-only: `search:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `channels:read`, `groups:read`, `im:read`, `mpim:read`, `users:read`.

**FR-2.2** The Slack token is read from the Keychain at startup. It is never logged.

**FR-2.3** Primary fetch: `search.messages` with a date filter, then filter by `ts > cursor`. This gets all channels and DMs Frank can see in one call per page.

**FR-2.4** Fallback fetch (setting `slack.fetchMode = "history"`): `conversations.history` for included channels and DMs, plus `conversations.replies` for active threads.

**FR-2.5** Spike in M1: verify that search returns thread replies and DMs reliably, and how long it lags. Pick the primary mode based on the result and record the finding in this file. Run it with `npm run spike:slack` once the token is in the Keychain (P0-1). It prints counts only. Until then the adapter assumes search lags by up to 15 minutes (each poll looks back that far before the cursor) and keeps search to conversations Frank is a member of, plus any in `includeChannels`. Also to confirm: that a query with only `after:` works.

**FR-2.6** Messages are grouped into items by thread (`thread_ts`) or, for DMs without threads, into windows separated by a gap of 30+ minutes.

**FR-2.7** Polling interval comes from settings (default 10 min in work hours, 60 min outside). The scheduler detects a wake by comparing wall-clock time with monotonic time on a 5-second tick: a gap of more than 30 s, with a changed kernel wake time, is a wake. It then polls within 1 minute, or as soon as the network returns if it is still offline (FR-14.2). The earlier rule, a clock jump larger than 2× the interval, missed a 1-hour sleep when the off-hours interval is 60 minutes. A manual clock change is not treated as a wake.

**FR-2.8** Polling is idempotent. Message `ts` is the dedupe key. The cursor only advances after the items are persisted. A message whose text changed under the same ID (a Slack edit, a Wispr Flow summary rewritten) is saved and logged at the same revision, so it is not triaged again.

**FR-2.9** On HTTP 429, honour `Retry-After`. Other failures back off exponentially with jitter and emit `source.failed`. Failures are classified as offline, captive portal, rate limited, auth failed or server error (FR-14.3). Being offline is not a source failure: the cursor stays put and polling resumes when the network returns. The UI shows source health.

**FR-2.10** Bot messages and excluded channels are dropped at ingest. They are not stored.

> **Story 2.1** As Frank, I want the app to catch up on Slack after my laptop has been asleep so that nothing is missed.
>
> - Given the laptop slept for 3 hours, when it wakes, then the next poll runs within 1 minute and fetches all messages since the last cursor.
> - Given the laptop wakes with no network, when the network returns, then a catch-up poll runs within 1 minute of reconnecting.
> - Given a poll fails halfway, when the next poll runs, then no messages are duplicated or skipped.

### 7.3 E3 Read-only inbox (M1)

**FR-3.1** The UI lists items newest-first with source, channel, participants, last activity and a permalink to Slack.

**FR-3.2** The UI updates over SSE when items change.

**FR-3.3** The API is only reachable on `127.0.0.1`, and requires a per-install bearer token (generated on first run, injected into the served UI). CORS allows only the app's own origin. The token is stored in the Keychain so open tabs survive a restart. Requests with a `Host` other than `127.0.0.1` or `localhost` (DNS rebinding) or a foreign `Origin` are refused. The UI reads SSE through `fetch`, so the token travels in a header, never in a URL.

### 7.4 E4 Rules

**FR-4.1** `rules.json` holds ordered rules. Each rule has `id`, conditions (sender in list, channel in list, mentions Frank, DM, keyword regex) and an outcome (attention level, drop, or "send to model").

**FR-4.2** The first matching rule wins. A rule outcome of a fixed attention level skips the model call.

**FR-4.3** Default rules: DMs from VIPs → `now`; @-mentions of Frank → send to model with a minimum of `today`; excluded channels → drop.

### 7.5 E5 Haiku triage

**FR-5.1** Triage runs after each poll on items that are eligible under section 5.3.

**FR-5.2** The prompt (`config/prompts/triage.md`) contains:
- Frank's role in a few lines. No observations about people.
- Definitions and 2–3 examples per category: `now`, `today`, `none`, confluence-worthy, vault-worthy.
- The rule that observations about named people set `containsPeopleObservations` and are never repeated in the summary or reason. *Amended 2026-10-10:* the flag no longer removes the Confluence suggestion; Confluence is judged on the product content, and the draft anonymises (FR-10.1).
- The JSON output schema.

**FR-5.3** Output per item matches `TriageDecision`. Each decision is stored as a `triage.decided` event with the model and prompt version.

**FR-5.4** Items with new revisions are re-triaged (section 5.3). The UI shows the latest decision.

**FR-5.5** Haiku is not asked for a confidence number. Thresholds come from the eval, not from self-reported confidence.

> **Story 5.1** As Frank, I want each quiet Slack thread labelled for attention, Confluence and vault so that I only look at what matters.
>
> - Given 12 threads have become quiet since the last poll, when triage runs, then a single Haiku call labels all 12.
> - Given no threads are eligible, when a poll completes, then no Claude call is made.
> - Given a thread gets a new reply from a colleague after triage, when it goes quiet again, then it is re-triaged.

### 7.6 E6 Eval and feedback

**FR-6.1** `npm run eval` runs triage over `labels/triage.jsonl` and reports precision and recall per category, the confusion matrix for attention, and tokens and cost-equivalent used. `npm run eval -- --purpose settle` runs the settle check over `labels/settle.jsonl` (once it holds 30 labels) and reports false closes and missed closes (cockpit CK-2.6).

**FR-6.2** In the UI, Frank can correct any decision with one click (attention level, confluence y/n, vault y/n). Corrections append to `labels/triage.jsonl` and emit `triage.corrected`. **Triage was right** (`y`) appends the decision as it stands (origin `confirmed`) and emits `triage.confirmed { revision }`, so the labelled set holds what triage gets right as well as its mistakes; the latest line per item counts.

**FR-6.3** The eval report is saved to `logs/eval-<timestamp>.json` so prompt changes can be compared.

> **Story 6.1** As Frank, I want to correct a wrong triage in one click so that the labelled set grows from real use.
>
> - Given an item labelled `none`, when I set it to `today`, then the inbox moves it and the label file gains one line.

As built (M2 step 16):

- Each line of `labels/triage.jsonl` is one label: the item, its revision and source, the label, the triage it replaced, and **the thread as the model sees it** (truncated, with display names; Frank's messages as "me"). Holding the thread means the eval still works after the item's raw content has gone to retention. The flip side: **labelled threads are kept beyond `retentionDays`.** The labelled set is meant to be kept, but this is a data-protection choice for Frank to confirm.
- The latest line for an item is its label. The labelled count is the number of distinct threads; the correction count is the number of lines that came from the UI.
- A correction writes its label line first, then `triage.corrected`. If a crash falls between the two, the result is an extra label, never an inbox change without its label. An item whose content has expired is still moved, but gets no label.
- The eval scores the prompt and model alone: rules are not applied. It uses the latest label per thread and the triage batching. A thread the model gives no usable answer for is counted in `failed`, not scored.
- The eval's calls are logged as `eval` and count towards the day's cost-equivalent budget. A large eval run in the morning can therefore pause model triage for the rest of the day; Frank to decide whether `eval` should be left out of the budget.
- Usage › Run eval runs it in the server, in the background. It answers 409 with no labels and 503 when Claude can't be called, and a Claude failure is reported to health. `npm run eval` does the same from the terminal, but takes the lock, so it runs only while the server is stopped. That way the usage log never has two writers.
- Success criteria: S1 and S2 come from the last eval, S3 from the usage log. S4–S7 show "Measured in the parallel run" until M4 measures them. "Polls skipped" counts polls today, since the last start, after which triage found nothing eligible.

### 7.7 E7 Usage tracking

**FR-7.1** Implements CL-5 and CL-6.

**FR-7.2** The UI usage panel shows today's and the last 7 days' calls, tokens and cost-equivalent by purpose and model, against the Phase 0 baseline.

### 7.8 Inbox lanes (M2 UI)

**FR-8.1** The inbox shows two groups: **Needs you** (attention now or today, plus items whose triage failed, shown untriaged) and **To file** (confluence or vault suggested, attention none). A Sort menu orders the lists by **Priority** (the default since the cockpit, CK-1.1): Needs you lists Now items first, then failed ones, then Today items by deadline; or by last activity, newest or oldest first. **Group by channel** (off by default since CK-1.1, switched on in the same menu) brings each Slack channel's or DM's items together under its name; channels follow the chosen order. Both choices are kept in the browser. **Low priority** (no attention, nothing to file) is a footer link that opens its list. Lanes stay as before underneath (now, today, follow, file, else, failed, waiting). **This week** (cockpit CK-3.10) is a view of Today, not an attention level: a Today item whose open next step is due after the end of the day (Europe/London), or, with no `dueAt`, labelled "this week" or "by Friday" (Monday to Thursday) or "next week", shows under This week instead of Needs you, soonest due first. It moves into Needs you on the day it falls due; the server tells open tabs at midnight. A correction to Now keeps it in Needs you. Labels and the eval are unaffected.

*Amended 11 Oct 2026 (Waiting on others):* a third group, **Waiting on others** (attention `follow`), sits between Needs you and To file and shows only when it holds something; on the cockpit it sits at the top of Later, above To file. It holds topics where Frank owns the outcome but someone else has the next move: he asked for something, started a request or handed work on, and it isn't resolved. Before this, triage called them "someone else's to act on" and they landed in Low priority, out of sight. Unlike This week (CK-3.10, a view rule with no new attention level), this is a fourth attention level, because the model must tell "someone else's, not mine" from "someone else's move, my outcome" and only the thread says which. Triage prompt v9 defines it; a reply that hands the next step back to Frank is Today, and a resolved or dropped request is None. A reply from Frank that hands an ask on while he still owns the outcome is not settled: the settle check (prompt v2) answers `handedOn`, and the item moves to Waiting on others instead of closing or nagging, until someone else writes and triage decides afresh. The finish check (v2) treats such a hand-on as not settled. A rule's floor (FR-4.3) still lifts `follow` to Today; the count pills and the sidebar count leave it out (nothing to do yet), and no notification fires. The eval scores `follow` as a fourth attention level; reports saved before it are read with an empty `follow` row and column, so S1 and S2 compare across the change.

**FR-8.2** Item actions: Open in Slack, Done, Snooze (1h / tomorrow 09:00 / custom), Correct triage, Draft vault note, Draft Confluence entry.

**FR-8.3** Done and snoozed items leave the two groups. Each has a footer link that opens its list (Snoozed shows when the next one comes back). Snoozed items return at the snooze time, marked "Back from snooze". Threads waiting for the quiet window show as a quiet "N still active" link in the header. Done items say how they closed: by Frank ("Done by you"), by the source ("Answered in Outlook", "Closed in Slack"), or by his reply (`item.done { by: 'reply' }`, "Your reply in Slack"). An item closes on Frank's reply when a settle check finds it settles every open ask (cockpit CK-2.1–2.7); a partial answer ticks off the settled asks (`topic.askDone { by: 'reply' }`). Settings › Triage rules turns closing off (the row then asks "Mark done?") and picks the sources whose replies are checked: Slack on, Outlook off until the CK-2.9 gate. Undo, or a Done within 30 minutes of a "not settled" check, is written to `labels/settle.jsonl` for `npm run eval -- --purpose settle`. A topic that others settled (the model's re-triage says None and a finish check finds every ask settled) is suggested as **Looks finished** in place; Done and Not finished are labels in `labels/finish.jsonl` for `npm run eval -- --purpose finish` (cockpit CK-2.10).

**FR-8.4** (cockpit CK-4.1–4.4) **File in a batch**, in the To file header, opens each To file item in turn on its suggested filing, with the next item's draft running ahead (one at most). Approve writes and moves on; Skip (`→`) leaves the item in To file; the end shows "N filed · M skipped". An approval from a batch (`action.approved { markDoneWhenFiled: true }`) marks the item done once all its suggested filings are written, in the same append as the last write. Single filing still leaves the item open (JOURNEYS open question 5). *Amended 11 Oct 2026 (UX-4):* single filing closes it too. Approving a draft for an open item in To file asks for `markDoneWhenFiled` as a batch does, so the write that completes its suggested filings marks it done; a toast says "Filed, so marked done" with Undo. A to-do is not a suggested filing and never closes an item, and an item with a step left (Now, Today, Waiting on others) stays open after filing. *Also 11 Oct 2026 (UX-1, UX-2):* while a draft is open its action bar (Approve `⌘↵`, Edit, Re-draft, Discard `x`) stays in view at the foot of the panel; in a batch, Approve reads "Approve and next". The item panel files by key (`f` Confluence, `v` vault, `a` to-do, `r` reply in the source), the snooze menu takes a number or `s` for the suggested time, and `z` walks back through the Undos toasts offered. *Also 11 Oct 2026 (UX-3):* drafts run ahead outside a batch too. The suggested draft starts, quietly (`quiet`), when an item enters To file or when `j`/`k` or a click lands on one: one at a time, never while 3 or fewer drafts are left today or the cost budget is reached, and never again for a filing already drafted ahead. Items already in To file when the inbox loads wait until Frank lands on them.

### 7.9 E8 Vault note action

**FR-9.1** "Draft vault note" emits `action.requested` and runs a Sonnet draft with:
- the item content,
- `vault-conventions.md`,
- read-only access to the vault to find related notes. Prefer the Obsidian MCP server if available to the SDK; otherwise allow `Read`, `Grep` and `Glob` scoped to the vault path.

**FR-9.2** The draft output is either a **new note** (path + full markdown) or an **append** to an existing note (path + heading anchor + markdown block). Either way it follows the vault conventions, including frontmatter and links.

**FR-9.3** The UI shows a preview: a diff for appends, full content for new notes. Frank can edit the text before approving.

**FR-9.4** On approval, **code** writes the file (no model involved). For appends, the executor checks that the file's hash matches the hash at draft time. If it changed, it re-drafts instead of writing.

**FR-9.5** People observations are allowed in the vault (it is private), but only in the notes the conventions allow for them.

**FR-9.6** *Added 2026-10-10, after prod filed a Wispr meeting as a new note beside the Teams note on the same meeting.* Before a draft, code finds the notes that may already hold the thread or meeting, and the draft must weigh them. If one does, the draft appends only what it lacks; if it lacks nothing, the draft files nothing and says which note holds it. A new note beside a likely match is shown with a warning, not blocked.

**FR-9.7** *Added 2026-10-11, after every Wispr meeting drafted so far was filed as a new meeting note while the vault had topic notes for them.* Update existing notes wherever possible. A thread or meeting is filed by topic: each decision, fact or finding goes under the heading of the note that owns it, and one draft can add to several notes. A meeting note holds only what no existing note covers; when everything has a home, there is none. Action items stay out of the vault unless there is a meeting note anyway. Approving writes every note, or none if one changed since the draft.

> **Story 9.1** As Frank, I want to turn a Slack thread into a vault note with one review so that knowledge lands in my vault without copy-paste.
>
> - Given a thread suggested for the vault, when I click Draft vault note, then a preview appears within ~60 seconds showing the target path and content.
> - Given I approve, when the executor runs, then the file is written and `action.executed` is logged with the path.
> - Given the target note changed after drafting, when I approve, then the app re-drafts instead of overwriting.

As built (M3 step 17):

- The vault draft call (Sonnet, `config/prompts/draft-vault.md`) gets the Read, Grep and Glob tools only, with the vault as its working directory. Every tool call is checked twice, by a `PreToolUse` hook and by `canUseTool`: paths and patterns must stay inside the vault after symlinks are resolved. There are no MCP servers; the Obsidian MCP server is not used.
- The model answers `{kind: new, path, content}` or `{kind: append, path, heading, content}`. Code then checks the answer against the vault as it is: the path is Markdown, not in a hidden folder and inside the vault; a new note doesn't already exist; an append's heading is there. Code also records the note's hash (`baseHash`) in `drafts/<id>.json`. An answer that fails these checks fails the action (`model_error`) and says why.
- The event log is the queue. Drafting actions are drafted one at a time when Claude may be called; a sleep or a lost login leaves them drafting, and they run again later (FR-14.4). Approved and executing actions are the outbox. They are written one at a time once the Mac has been awake for 45 s; no network is needed for the vault.
- Each write attempt runs in this order:
  1. Save the expected hash to the draft file.
  2. Sync `action.executing`.
  3. Write: an append replaces the file atomically, and a new note is linked into place, which fails rather than overwrite.
  4. Log `action.executed`.
- On the next attempt or after a restart, the note's hash decides what happens: the expected hash means already written, the base hash means write, and anything else means a conflict. A conflict fails the action and starts a re-draft, budget permitting. A disk error is retried with a growing delay; after 5 attempts the action fails as `unreachable`.
- In dry-run the note goes to `<data>/sandbox/vault/<path>`, and the vault itself is only read. A sandbox copy stands in for the vault note, so a second approval sees the first.
- A ready, approved or executing action whose draft file is gone fails as `draft_missing` at startup.
- `--fakes` runs use a made-up vault in their temp data directory.

As built (FR-9.6, 2026-10-10):

- **What code looks for** (`actions/vaultCandidates.ts`). Before the call it reads every `.md` file in the vault, skipping hidden folders; in dry-run it reads the sandbox first, whose copy stands in for the vault note. That is 271 notes, about 120 ms on Frank's vault.
  - **Strong:** a note that contains a link of the topic (`itemLinks`, without Wispr's `wispr-flow://` placeholder), on any day. For a meeting, also a note whose filename date or `created:`/`date:` is the meeting's London date and whose first 40 lines name a participant or invitee other than Frank (also as "Last, First").
  - **Weak:** a `type: meeting` note on that date that names no one from the meeting.
  - At most 5, strong first. Source lines are not compared: meeting notes come from Plaud, Teams and pasted summaries as well as Work OS, and never share one.
- **The request** gains `<existing-notes>`, one JSON line per note, and a meeting's `attendees`. draft-vault v4 must open them, also Grep for the permalink, and answer `append` with only what the note lacks, or `{kind: filed, path, why}`. vault-conventions v3 puts the recording's link in a meeting note's `source:`.
- **`vault_filed`.** Code checks the note exists. Approving it writes nothing and logs `action.executed` with `unchanged: true`, so `filedAll` and batch filing count it. A filed note that has since gone is a conflict and re-drafts. It can't be edited.
- **Backstop.** A `new` answer beside a strong match keeps `possibleDuplicates`; the panel shows "This may already be in the vault" with Re-draft.

As built (FR-9.7, 2026-10-11):

- **Rules.** draft-vault v5 and vault-conventions v4 say it: file by topic, a meeting note only for what fits nowhere, never a note just for action items, and every block ends with its source link (the Wispr share link for a meeting), so the FR-9.6 check finds the meeting in the topic notes later. Unedited v4 and v3 defaults are upgraded on start.
- **The answer** gains `{kind: notes, notes: [...]}`, up to 6 entries, each `append` or `new`. One entry is still a `vault_append` or `vault_new` draft. Two or more are a `vault_multi` draft (`parts`), checked note by note as before (path, heading, no overwrite); two appends to one note land in turn. `drafts/<id>.json` holds `baseHashes` by path; the action's target has `paths`.
- **Writing.** The executor reconciles each note by its own hashes and writes nothing unless every note checks out. Every expected hash (`expectedHashes`) is saved and synced before the first write, so after a crash the notes already written match and only the rest are written. A note that changed fails the action as a conflict and re-drafts. `action.executed` carries `paths`.
- **Panel.** "Files into N notes", then each note with its target, its existing lines and its own Edit; `PUT /api/actions/:id/draft` takes `part`, and the Edited badge is per note.
- **Backstop.** A `vault_multi` with a new note beside a strong match keeps `possibleDuplicates`, minus the notes it adds to.

### 7.9b To-do action (UX-5, added 11 Oct 2026)

*Added 11 Oct 2026, from specs/BACKLOG.md UX-5. To-dos were a destination in the funnel with no target, and the "Action items for you" checkboxes looked like a to-do list but kept nothing.* Frank uses the Obsidian Tasks plugin.

**FR-9.8** **Add to-do** turns an item's open steps into Obsidian Tasks lines, one per step: `- [ ] {step} 📅 YYYY-MM-DD [{source title}]({permalink})`. The date is the step's deadline in London and is left out when there is none. The steps are a topic's open asks, or a meeting's action items, or the next step, or "Follow up: {summary}" when there is nothing else.

**FR-9.9** Code builds the to-do from the triage, with no model call and no draft spent, so the drafts budget never holds it up. It is ready to review at once (`action.requested` and `action.drafted` in one append). Frank reviews, may edit the lines, and approves. Code then appends the lines to the end of one Tasks note, set in Settings › Write targets (`tasksNote`, default `Work/Tasks.md`), creating the note if it is missing. The path is checked against the vault as for vault notes, and in dry-run the sandbox copy stands in for the note.

**FR-9.10** An append adds only lines that aren't already in the note. A line counts as there when its task matches, ticked or not, and with or without the ✅ date the Tasks plugin adds when ticked. So an attempt cut short is finished and never repeated. An append can't clash with what Frank changed in the note since, so there is no conflict check; if the note changes between the plan and the write, the attempt starts again.

**FR-9.11** In the item panel, **Add to-do** sits under File it, with the key `a`. A meeting's **Action items for you** are a picker: all ticked at first, then **Add to Tasks** makes a to-do of the ticked ones, replacing a to-do still waiting for review. Triage never suggests a to-do, so it stays out of the card actions and batches. The vault drafter keeps its rule that action items stay out of the vault (FR-9.7), and the "already filed" search (FR-9.6) skips the Tasks note.

### 7.10 E9 Confluence entry action

**FR-10.1** Allowed only for items where `containsPeopleObservations` is false. Otherwise the button is disabled with an explanation. *Amended 2026-10-10:* allowed for every item. A thread that mentions people is not blocked; the draft anonymises them the way the `psg-context-builder` skill does (its exclusion screen and attribution ladder: drop the person, keep the fact, and answer no fit only when nothing survives). Confluence entries never identify people.

**FR-10.2** "Draft Confluence entry" runs a Sonnet draft with read-only Confluence access (Atlassian MCP or REST search) limited to the pages in scope, and the `psg-context-builder` routing guidance. *Amended 2026-10-07:* the scope is a live catalogue, not a fixed list of page IDs, because pages are added to the PRD context tree all the time and must not be missed. It is every root page and everything below it, every page in the space with one of the scope labels, and any single pages, minus the excluded pages and everything below them. It is read from Confluence for every draft.

**FR-10.3** The draft output is a structured patch: page ID, page version at draft time, section heading anchor, and content in Confluence storage format.

**FR-10.4** Before showing the preview, a second Haiku check confirms there are no observations about named people. If it finds any, the draft is blocked. *Amended 2026-10-10:* the check confirms the entry identifies no individual, by name or by an identifying description, following the skill's rules. If it does, that draft is blocked and Frank can re-draft; the thread itself is never blocked. *Amended 2026-10-11:* an entry Frank has edited is checked again when he approves it. If it identifies someone, approval is refused with the reason and the draft stays ready, with his edit, to fix; if Claude can't be reached for the check, approval is refused too.

**FR-10.5** On approval, **code** applies the patch through the Confluence REST API, with an optimistic version check. A version mismatch means re-draft, never overwrite.

**FR-10.6** Pages outside the scope are refused by the executor, whatever the draft says. *Amended 2026-10-07:* the executor checks the scope as it is in Confluence at write time.

**FR-10.7** *Added 2026-10-10.* Before a draft, code finds the sections of the picked pages that already link to the thread or meeting, and the draft sees each section's latest entries. The draft writes only what the page lacks; if it lacks nothing, it files nothing and says where it is. An entry beside a section that already links to the thread is shown with a warning, not blocked.

> **Story 10.1** As Frank, I want to file a decision from Slack into the right Confluence context page so that the PSPD pipeline and the Knowledge Desk can use it.
>
> - Given a thread suggested for Confluence, when I click Draft Confluence entry, then I see the target page, section and content.
> - Given a thread that mentions named people, when I draft a Confluence entry, then the entry keeps the facts and identifies no one.
> - Given the page was edited after the draft, when I approve, then the app re-drafts instead of writing.
> - Given a draft targets a page outside the scope, when I approve, then the executor refuses and logs `action.failed`.
> - Given a page added under a root page since the last draft, when I draft, then it can be picked without changing settings.

As built (M3 step 18):

- **The live catalogue (FR-10.2, amended).** This follows the psg-context-builder skill's Step 1. For every draft, code runs one CQL search over REST v1 (`GET /wiki/rest/api/content/search`, with ancestors and labels expanded, following `_links.next`, at most 1,000 pages):

  `space = "<key>" AND type = page AND (id in (<roots, single pages>) OR ancestor in (<roots>) OR label in (<labels>)) AND id not in (<excluded>) AND ancestor not in (<excluded>)`

  Each page becomes `{id, path, labels, hub}`:
  - `path` is its ancestors below the space home, then its title.
  - `labels` keeps only the `psg-*` labels.
  - `hub` means another page in the catalogue sits under it.

  Settings › Write targets has a **Preview catalogue** button (`GET /api/confluence/catalogue`) that shows the same list, grouped by root.

  The defaults are the skill's constants:
  - the seven BU roots;
  - UX Principles, Competitor Profiles, Glossary & Taxonomy and Company Strategic & Commercial Context;
  - the six `psg-shared-*` labels;
  - excluded: the skill's two never-write pages and Archive.

  Settings files from before the amendment get these defaults when they load. Their old page list stays, as single pages. On 2026-10-07 the PRD tree had about 145 pages in scope.
- **Two calls (FR-10.2).** 145 outlines don't fit one call, so drafting runs in two:
  1. A picker (`config/prompts/pick-confluence.md`, usage purpose `confluence_pick`, the Confluence draft model) gets the routing guidance, the thread and the catalogue. It answers with one to three candidate page IDs, or `noFit`. Picks that aren't in the catalogue are dropped; if none is left, the action fails as `allow_list`.
  2. Code reads only the candidates over REST v2 (`GET /wiki/api/v2/pages/{id}?body-format=storage`), and the draft call (`config/prompts/draft-confluence.md`) gets their section outlines. A candidate that answers 404 is skipped; if none can be read, the action fails as `allow_list`.

  Neither call has tools or MCP servers, so the model only ever sees pages in scope. The draft records the page's ancestors (`ancestorIds`), so the item panel can warn when the page, or a page above it, has been excluded since drafting. The picker costs a call, but it is not counted as a draft against the drafts budget.
- **A token Confluence doesn't accept.** Confluence answers it as an anonymous user, with empty search results and 404s rather than a 401. An empty search therefore checks `GET /wiki/rest/api/user/current`. If the answer is `anonymous`, the call fails as `auth_failed` (`token_rejected`), and the message says to store a classic API token as `email:token`.
- **Routing guidance.** It comes from `config/psg-context-builder.md`, written on first run from a built-in default distilled from the psg-context-builder skill for a single drafting call: the exclusion screen, the attribution ladder and tiers, how to choose the business unit, and where each kind of fact goes (FR-1.1). The skill's interactive modes, tools and label handover are left out. Edit it in Settings › Prompts (FR-1.7).
- **No fit.** The picker or the draft call may answer `{noFit, reason, suggestedHome}` instead. They do this when:
  - the right page isn't in the catalogue;
  - nothing survives the exclusion screen;
  - the thread isn't context.

  The action fails as `no_fit`, before any page is read when the picker declines, and always before the people check. The panel offers a vault note instead.
- **Deviation from FR-10.3: the draft is Markdown, not storage format.** The model answers `{pageId, section, title, content}` with Markdown content. That is what the preview shows and what Frank edits. Code checks that the page and section exist, records the page version at draft time (`baseVersion`), and converts the Markdown to storage format only when it writes. The conversion handles a safe subset: headings, paragraphs, lists, bold, italics, code, and https or mailto links. Everything else is escaped. The entry goes at the end of the chosen section, under a heading one level below it.
- **People check (FR-10.4).** A second Haiku call (`config/prompts/people-check.md`, usage purpose `people_check`) reads the entry as it would be written. If the entry still identifies a person, the action fails as `people_check`, nothing is shown, and the panel offers a re-draft. Items flagged `containsPeopleObservations` are drafted like any other (FR-10.1, amended 2026-10-10).
- **Executor (FR-10.5, FR-10.6, NF-5).** Before every attempt, code:
  1. checks the scope as it is now, with the catalogue's CQL narrowed to `id = <page>`. A page no longer in scope fails the action as `allow_list`. A failed query is a failed attempt, never a yes;
  2. re-reads the page;
  3. decides from the version it finds:
     - the drafted version: save version + 1 with the version message `Work OS <actionId>`;
     - version + 1 with that message: an earlier attempt already wrote it, so the action is done (this covers a save whose answer was lost);
     - anything else: a conflict, which fails the action and re-drafts, budget permitting.

  A 409 on save means another save won the race: the next attempt, 30 s later, re-reads and reconciles. Offline, needs-probe, auth and rate-limit failures don't use up any of the 5 attempts.
- **Dry-run.** The page is only read. The would-be page is saved to `<data>/sandbox/confluence/<pageId>-<actionId>.html`, and the result says "Dry-run: write logged only. <page> stays at v<n>".
- **Credentials (P0-8).** They are `email:token` in the Keychain account `confluence-api-token`, sent as Basic auth. The site URL and the scope come from settings.
- **Retries.** A draft that fails on a transient Claude or Confluence error stays drafting and waits at least 30 s before the next try, so a failure the breaker lets through is not retried at once. Writes after a 409 or a dropped connection wait the same way.
- **Test runs.** Tests and `--fakes` runs use a made-up Confluence (`actions/fakeConfluence.ts`). It checks Basic auth and version numbers, evaluates the CQL the catalogue writes, and can answer as an anonymous user. Under vitest, with no fake given, any Confluence call fails.

As built (FR-10.7, 2026-10-10):

- **Linked sections** (`findOnPages`, `storage.sectionsLinking`). In the picked pages' storage, code finds each of the topic's links, also with `&` written as `&amp;`, and takes the nearest heading above it. The request gains `<already-filed>`: one JSON line per section, with its text (the last 3,000 characters if it is longer).
- **Outlines.** Each section's excerpt is its first 150 and last 450 characters, instead of the first 300, within the same 8,000-character budget per page. Entries go at the end of a section, so the end is where the latest ones are.
- **draft-confluence v6** compares facts, not wording, so an entry filed from another source counts. It answers `{alreadyFiled, pageId, section, why}` when the page lacks nothing. Code checks the page and section, and the draft becomes `confluence_filed`, with no people check. Approving it writes nothing, not even a dry-run preview, and logs `action.executed` with `unchanged: true`.
- **Backstop.** An entry beside a linked section keeps `possibleDuplicates`; the panel shows "This page may already have it".

### 7.11 E10 Notifications

**FR-11.1** New `now` items trigger a macOS notification with the one-line summary. Clicking it opens the item in the UI. Uses `terminal-notifier`, because `osascript` notifications can't open a URL. *Amended 11 Oct 2026 (BACKLOG UX-6):* the item opens in the inbox panel (`/?item=…`), not as a full page, so Frank keeps his place and the panel's keys. The same goes for the in-app notification card, the "draft ready" and "draft failed" toasts and the bell's item entries. An item the inbox doesn't show (out of scope, or gone from it) opens as the full page instead.

**FR-11.2** No more than one notification per item, recorded as an `item.notified` event so a restart never repeats one. Quiet hours come from settings. Three or more `now` items found in one catch-up poll after a wake become a single summary notification.

As built (M3 step 19):

- **Which decisions notify.** Any decision that makes an item Now and not yet notified puts it in a pending set: the model's, or a rule's at ingest. Corrections never notify, since Frank made them.
- **When they go out.** Pending items go out after each triage run, so what one run decides goes out together. After a wake or reconnect catch-up poll, three or more become one summary ("3 items need you now", which opens the inbox). Otherwise each item gets its own notification with its one-line summary, and a click opens `/item/<id>`. Items wait at most 2 minutes for a triage run (Claude may be down), then go out on their own. An item Frank has already marked done or snoozed is skipped.
- **Recorded before shown.** `item.notified {kind: now|summary}` is synced before anything appears, so a crash shows nothing rather than showing it twice, and a restart never repeats one.
- **Quiet hours and the off switch.** They record the item as `suppressed: quiet_hours|disabled` and show nothing, then or later; the item is in the inbox either way. The UI also gets an SSE `notification` notice for each one shown.
- **Health alerts (FR-14.6), `notify/alerts.ts`:**
  - `auth_failed` on any dependency alerts at once.
  - Settings paused (invalid, with no good copy) alerts at once.
  - The network offline alerts only after 30 minutes of awake time in work hours. The monotonic clock stops in sleep.
  - `degraded` and `rate_limited` never alert.
  - At most one alert per dependency every 4 hours.
  - Quiet hours and the off switch hold an alert back rather than drop it.
  - "<Dependency> is back" follows only an alert that was sent.
  - A click opens Usage & health.
  - The 4-hour memory is in memory only, so a restart may repeat an alert once.
- **terminal-notifier.** It is used when installed (`/opt/homebrew/bin` or `/usr/local/bin`, checked directly because launchd's PATH lacks them); otherwise osascript, whose notifications can't open a URL. Text goes in as arguments, and a leading `-` or `[` is escaped. **It is not installed on this Mac yet: `brew install terminal-notifier`.** `npm run agent:status` shows which one is in use. Tests and `--fakes` runs never show notifications.

**FR-11.3 The bell.** A bell at the right of every page's top bar lists what needs Frank's follow-up, so he can start a draft, carry on, and come back when it is ready. It is derived from state as it stands (`GET /api/attention`, built by `buildAttention` in `packages/shared/src/attention.ts`, the same in the server and the mock), so an entry goes as soon as he deals with it. Nothing is stored but dismissals.

- **The count** is the number of entries. It is accent while some arrived since he last opened the bell, and quiet once he has. With nothing to follow up there is no count at all. When the bell was last opened is kept per browser.
- **Working on**, below the entries, lists drafts in progress with their stage ("Finding related notes · 2 of 3"), or why one waits: its turn, the drafts budget, Claude, Confluence. These don't count.
- **Every page** has it: the Inbox, a source's page, Settings, the Guide, Usage & health and the item page. The macOS-style cards moved below it.
- **Refreshing:** the client fetches the bell again on the notices that already say its views changed (`inbox`, `item`, `health`, `usage`, `evals`, `settings`), plus `attention` after a dismissal. The SSE stream's other notices are unchanged.

**FR-11.4 What it lists.** Each entry has a title, what it is about, sometimes one more line, and a button.

| Kind | Shows when | Goes when | Dismiss |
|---|---|---|---|
| Draft ready | a vault note or Confluence entry draft waits for review. Says so when new replies came in since, or after a day. | approved, discarded or re-drafted | no |
| Draft failed | drafting failed, with the server's reason | re-drafted or discarded | yes |
| Couldn't file | an approved write failed (`failedWhile: writing`). A conflict that re-drafts at once doesn't show. | re-drafted or discarded | yes |
| Fix needed | a dependency rejected the login or is paused, safe mode, a failed startup check no dependency covers, or drafts waiting for the drafts budget | fixed | no |
| Back from snooze | a snoozed item came back | opened | yes |
| Looks finished | others' messages settled what a topic asked of Frank (CK-2.10) | Done or Not finished | yes |
| Your reply left asks open | the settle check found asks his reply didn't settle (CK-2.3) | done, or a later check | yes |
| Triage eval finished | an eval finished in the last 24 hours | the report is opened | yes |
| Guidance sources changed | a guidance file's sources changed since it was distilled (FR-1.7). Checked at most every 10 minutes. | marked reviewed | yes |

- **Only the current action per type counts** (`currentAction`), so a failure replaced by a re-draft goes.
- **A draft on a done item** shows only if it became ready or failed after the item was closed. That is the draft Frank asked for on his way out; one he left behind when he closed the item stays out.
- **A failed draft** also raises a `draft_failed` notice. The UI shows it as a toast unless the item is on screen or the draft was made ahead in a batch.

**FR-11.5 Dismissing.** A dismissible entry's key names its occurrence: `draft_failed:<action>`, `snooze_back:<item>:<when>`, and so on. `POST /api/attention/dismiss {key}` logs `attention.dismissed`, and the projection keeps the key for 90 days. A new occurrence has a new key, so it shows again.

**FR-11.6 macOS notifications for drafts.** A draft that is ready or failed notifies, as Frank may have moved on. Clicking the notification opens the item: *amended 11 Oct 2026 (UX-6)*, in the inbox panel on the draft's filing (`/?item=…&file=vault`), as FR-11.1.

- **Same rules as FR-11.2:** quiet hours and the off switch apply, and the bell lists it either way.
- **Batch drafts don't notify:** drafts made ahead while filing in a batch are requested with `quiet: true` (CK-4.2).
- **Nothing is recorded:** each action is drafted once, so the notification can't repeat after a restart.

As built:

- The projection gains `dismissed`, `backAt` (when a snooze ended) and, on actions, `failedWhile` and `quiet`. PROJECTION_VERSION is now 5.

### 7.12 E11 Hardening

- **FR-12.1** Retention job runs daily (section 4.3).
  As built (FR-12.2):

  - **The Claude login check makes no call of its own.** It reports Claude's health as the last real call left it. Triage and draft calls all report to health, so a lost login shows at the first call that needs it, with its fix. Until the first call, the check is a warning. This deviates from "one minimal Haiku call": a call every 5 minutes would cost more than it tells.
  - **"Check again" also polls** any source whose dependency is `auth_failed`. Without that, a token fixed in the Keychain kept showing as broken until the next scheduled poll, because Poll now is refused while the token is rejected.
  - A missing Slack token says it is missing ("No Slack token in the Keychain yet"), not that Slack rejected it.

  As built (M4 step 20):

  - **What is removed.** `store/retention.ts` removes what holds message text and is older than `retentionDays`:
    - item files, by the thread's last activity;
    - the drafts of finished actions (done, failed, discarded) on those items;
    - `sandbox/` files, by modification time;
    - `logs/app-<date>.log` by date.
  - **What stays.** Events, the usage log, eval reports and labels stay: the first three hold no message text, and labels are kept on purpose (§7.7, still for Frank to confirm). Drafts still in play (drafting, ready, approved, executing) stay too, whatever their age.
  - **No race with a poll.** An item file is removed under the item's lock, and only if the file itself says the thread is old. A poll that has just merged a new reply into an old thread keeps it.
  - **What the inbox shows.** The item stays, from its events, with `contentExpired`.
  - **launchd logs.** `logs/launchd.{out,err}.log` are cut in place to their last 1 MB of whole lines once over 5 MB. In place, because launchd keeps them open.
  - **When it runs.** The first tick at or after 03:00 on a day it hasn't run yet. The last run day is kept in `state/retention.json`, so a restart doesn't repeat it, and a Mac asleep at 03:00 runs it on the first tick after waking. "03:00" is London time, like the budgets and work hours (see the London-only note); FR-14.8 asks for the system time zone, which is still open.

- **FR-12.2** Startup checks: FileVault on (warn if not), no `ANTHROPIC_API_KEY`, Slack token present, Claude login works (one minimal Haiku call, logged), settings valid, Keychain readable, and a note if Power Nap is on. Checks run after the API is up, so they never delay first paint. Except for the API key, a failed check puts the server in degraded mode and is re-checked: Keychain and token every 5 minutes, the Claude login on a 15–60 minute backoff, and on wake, on settings save and on demand from the UI (FR-14.6).
- **FR-12.3** launchd LaunchAgent so the server starts at login. **Required in the MVP and built in M1** (FR-14.1).
- **FR-12.4** Tests: unit tests for rules, quiet window, grouping, cursor handling, atomic writes and executors. Contract tests for model output schemas, using recorded fixtures. There is no live-model call in CI.

### 7.13 E12 Cut-over and measurement

- **FR-13.1** After 3 working days of parallel running, compare the Work OS output with the Slack digest. Then disable the digest scheduled task.
- **FR-13.2** Measure S1–S7 for 2 working weeks and record the results in this file.

**Before the soak (Frank).** Before the soak can start, Frank needs to:

1. Store the Slack user token (P0-1) and, if Confluence filing is wanted, the Confluence `email:token` (P0-8, Keychain account `confluence-api-token`). Copy each value to the clipboard and pass it as an argument: the `security` password prompt keeps only the first 128 characters, which cuts an `email:token` short. Then copy something else to clear the clipboard.

   ```
   security add-generic-password -U -s com.polestar.workos -a slack-user-token -w "$(pbpaste)"
   security add-generic-password -U -s com.polestar.workos -a confluence-api-token -w "$(pbpaste)"
   ```
2. Check the Confluence scope in Settings › Write targets (P0-6; the defaults cover the PSG context tree), and use Preview catalogue to confirm the token works. Check the vault conventions (P0-5).
3. Optionally, `brew install terminal-notifier`. The filing guidance ships with the app; adjust it in Settings › Prompts.
4. Deploy and install:

   ```
   cd app
   npm run deploy
   npm run agent:install
   npm run agent:status
   ```

Keep dry-run on for the first day; turn it off in Settings once the drafts look right.

**Soak checklist (M4 step 21).** Each line is one check, with what should happen. `agent:status` means `npm run agent:status` from `app/`. "The log" means today's `~/WorkOS-data/events/<UTC date>.jsonl`.

| # | Do this | Expect |
|---|---|---|
| 1 | Reboot and log in. | Within 30 s `agent:status` is all ✓: plist, launchd running, no `ANTHROPIC_API_KEY`, health `normal`. |
| 2 | Close the lid for 3 h or more, then open it. | Within 1 minute: `system.woke`, then `source.polled` with `reason: wake`. No gap: threads from the sleep are in the inbox. With 3 or more Now items, one summary notification. |
| 3 | Wi-Fi off for 20 minutes. Meanwhile, approve a vault note and a Confluence entry. Then Wi-Fi on. | While off: the inbox, Done and Snooze work; the header says offline; nothing fails. On reconnect: a `reconnect` poll, then each action written once (one `action.executed` each). The Confluence page is one version up, with the message `Work OS <actionId>`. |
| 4 | Stay offline for over 30 minutes during work hours. | One "Work OS is offline" notification, then "Network is back" on reconnect. |
| 5 | Join a hotel or café captive portal without signing in. | Network shows offline with "Sign in to the Wi-Fi portal". No error notification. |
| 6 | Turn the VPN on and off during a poll. | At most a degraded blip in Usage & health; the next poll succeeds. |
| 7 | Log out and back in. | `system.stopped` (SIGTERM), then `system.started`. Not counted as a crash. |
| 8 | Run `pkill -9 -f server.mjs` during a poll (Poll now, then kill at once). | launchd restarts it within 30 s. No duplicate items, and no skipped messages on the next poll. |
| 9 | Approve a Confluence entry with dry-run off, and `pkill -9 -f server.mjs` right after. | After the restart the action ends `done`. The page went up exactly one version. |
| 10 | Change the clock forward 2 h, then back. Change the time zone. | No burst of polls, and the log notes the clock change. Work and quiet hours stay on London time for now: FR-14.8's system zone is still open. |
| 11 | Lock the login Keychain (Keychain Access › Lock), then Check again. | Keychain shows degraded with "Unlock the login Keychain". Work continues on the cached token. |
| 12 | Sign Claude Code out (`/logout` in a `claude` session), then wait for a triage. | One "Claude needs you" notification. Rules still decide. Items wait as pending. After signing back in and Check again: "Claude is back", and triage resumes. |
| 13 | `launchctl setenv ANTHROPIC_API_KEY x`, then `launchctl kickstart -k gui/$(id -u)/com.polestar.workos`. Afterwards run `launchctl unsetenv ANTHROPIC_API_KEY` and kickstart again. | A "Work OS did not start" notification, `state/refused.json`, and no restart loop (`agent:status` shows exit 0). |
| 14 | Leave it running overnight. | `state/retention.json` shows today's date after 03:00 (or after waking). Item files older than `retentionDays` are gone, and those items show as expired. |

Automated tests cover the same ground with fakes:

- **Crash injection** (`apps/server/src/crash.test.ts`, with `WORKOS_CRASH_AT` in `--fakes` runs only): SIGKILL after the item files, after the events and after the cursor, and before and after a vault write. After each, the test checks that nothing was duplicated, skipped or written twice.
- **Wake and offline:** `runtime/wake.test.ts`.
- **Real Confluence writes:** `commands.test.ts` covers lost answers, 409 races and dropped connections.

### 7.14 E13 Runtime robustness (M1)

The server runs unattended on a laptop that sleeps, travels and loses its network. These requirements make that safe.

**FR-14.1 Autostart.** A launchd LaunchAgent (`com.polestar.workos`) starts the server at login with no window or browser:
- **Restarts:** `RunAtLoad`, `KeepAlive` with `SuccessfulExit: false` (restart only after a crash), `ThrottleInterval` 30.
- **Session:** `ProcessType` Standard, `ExitTimeOut` 10, and `LimitLoadToSessionType` Aqua, so the login Keychain, the Claude login and notifications are available.
- **Plist contents:** absolute paths, an explicit `PATH` and no secrets.
- **What it runs:** a deployed release (`npm run deploy`), never the repo.
- **Commands:** `npm run agent:install`, `agent:uninstall` and `agent:status`.
- **Development:** uses its own data directory and port, so it can run alongside.

**FR-14.2 Sleep and wake.** A 5-second tick compares wall-clock time with monotonic time.
- **On wake:**
  1. Abort in-flight requests.
  2. Wait 10 s for the network.
  3. Probe.
  4. Poll within 1 minute.
- **Wake with no network:** the catch-up poll runs on reconnect instead.
- **Power Nap:** during a brief wake, source fetches may run, but Claude calls and approved writes wait until the machine has been awake for 45 s.
- **Keeping the machine awake:** a `caffeinate` assertion is held only during a triage call or an approved write. Correctness never depends on it.

**FR-14.3 Network handling.**
- **Timeouts:** every network call has one. Slack 20 s, Confluence 15 s for reads and 30 s for writes, probes 5 s.
- **Classification:** failures are classified as:
  - offline (the probe also fails)
  - degraded (the probe succeeds)
  - captive portal (TLS errors, or HTML on a JSON endpoint)
  - rate limited (wait for `Retry-After`)
  - auth failed
- **Backoff:** jittered and capped. Offline: probe only, up to 5 minutes. Degraded: up to 10 minutes. Claude: up to 15 minutes.
- **Circuit breakers:** one per dependency. Work waits for the breaker instead of retrying on its own, so there are no retry storms.
- **When the network returns:** catch-up poll first, then the outbox, then triage.

**FR-14.4 Working offline.** The inbox, done, snooze and corrections work with no network.
- Triage keeps items pending, and rules still apply.
- A draft request waits for Claude.
- Sources that need no network (local reads, R2.6) keep ingesting. Wispr Flow now reads through its MCP server (R2.7, amended from R2.6), so it pauses offline like Slack and catches up on reconnect.

**FR-14.5 Durable outbox.** An approval made offline, or interrupted by sleep or a crash, is never lost and never applied twice.
- **Before every write attempt:** an `action.executing` event is fsynced, and the executor reconciles against the target.
- **Confluence:** re-read the page version. A version of `base + 1` with the Work OS marker means an earlier attempt already succeeded.
- **Vault:** compare the file hash with the base and expected hashes.
- **Target changed by someone else:** re-draft, never overwrite.
- **Attempts:** offline time does not use up attempts. After 5 transient failures the action fails with reason `unreachable`.

**FR-14.6 Degraded and safe mode.** Problems are shown, not hidden.
- **Health:** each dependency (network, Slack, Claude, Confluence, Keychain, storage) reports `ok | unknown | offline | degraded | rate_limited | auth_failed | paused`. The health API and SSE expose this.
- **UI:** a banner shows the problem, how to fix it and a "Check again" button. The blocking startup screen is kept only for the API key (CL-2).
- **Alerts:**
  - macOS alerts are rate limited to one per dependency every 4 hours and respect quiet hours.
  - Offline is alerted only after 30 minutes awake in work hours.
  - "Recovered" is sent only if a problem alert was sent.
- **Safe mode:** more than 5 crashes in 10 minutes puts the server in safe mode (UI only, no scheduler) with a notification.
- **Full disk:** the server switches to read-only and commands return 503.

**FR-14.7 Shutdown and crash recovery.**
- **On SIGTERM (logout, restart):**
  1. Stop the tick.
  2. Abort fetches.
  3. Give an in-flight write 5 s.
  4. Sync the log and write the snapshot.
  5. Release the lock.
  6. Exit within 8 s.
- **After a crash or power loss:** recover at startup as described in section 4.3.

**FR-14.8 Clocks and time zones.**
- **Storage:** all instants are stored in UTC.
- **Snooze:** presets become an absolute instant when set.
- **Local time:** work hours, quiet hours and budget days use the current system time zone, re-read every minute so travel is picked up.
- **DST:** handled through Intl, never fixed offsets.
- **Clock changes:** a manual change in either direction recomputes due times without a poll storm.
- **Retention:** runs on the first tick after 03:00, or after the next wake if that time was missed.

> **Story 14.1** As Frank, I want Work OS running whenever I'm logged in, without thinking about it.
>
> - Given a reboot, when I log in, then the server is up within 30 s and `npm run agent:status` reports it healthy.
> - Given the server crashes, when launchd restarts it, then no event is lost and no message is fetched twice.
> - Given `ANTHROPIC_API_KEY` is set in the launchd environment, when the server starts, then I get a notification and it does not restart in a loop.

> **Story 14.2** As Frank, I want to approve a vault note on a train with no signal and have it land once I'm back online.
>
> - Given I approve an action offline, when the network returns, then the outbox writes it once.
> - Given the target note changed while I was offline, when the outbox runs, then the app re-drafts instead of writing.
> - Given the laptop sleeps during a Confluence write, when it wakes, then the executor re-reads the page and does not write the entry twice.

---

## 8. Non-functional requirements

| ID | Area | Requirement |
|---|---|---|
| NF-1 | Privacy | Data stays on the laptop. No telemetry. The server binds to localhost only. |
| NF-2 | Privacy | Observations about people never leave the vault, and Confluence entries never identify people: the draft anonymises (FR-10.1) and the people check confirms it (FR-10.4). |
| NF-3 | Security | Secrets live only in the Keychain. Never logged, never in files or prompts. |
| NF-4 | Security | Slack scopes are read-only. The app never sends messages in the MVP. |
| NF-5 | Safety | Every write needs explicit approval. Executors re-validate the target (Confluence scope, version or hash) at write time, and reconcile against the target before every retry, so a write is applied at most once (FR-14.5). |
| NF-6 | Reliability | Polling is idempotent. State can be rebuilt from the event log. Single instance. The server starts at login, survives sleep, network loss, crashes and power loss, and shows degraded states instead of stopping (E13). |
| NF-7 | Performance | A poll with triage completes in under 60 s for 25 threads. The UI first paint is under 1 s. Detailed budgets in NF-11. |
| NF-8 | Cost | Daily usage stays at or under the Phase 0 baseline (S3). The usage panel makes drift visible. |
| NF-9 | Portability | The Claude adapter can switch to an API key or Bedrock through settings only (CL-8). |
| NF-10 | Compliance | Internal tool, not customer-facing, so the EU AI Act customer-facing obligations do not apply. Re-assess if any part is exposed to customers. |
| NF-11 | Performance | Budgets in the table below, checked by `npm run perf` against 90 days of synthetic data (about 50k events) with fake Slack and fake Claude. The script fails on any breach. |

NF-11 budgets:

| Measure | Budget |
|---|---|
| Cold start to API ready | < 400 ms from the snapshot; < 1.5 s with a full replay |
| `GET /api/inbox` | p95 < 15 ms server-side, payload < 300 KB as sent (gzip); an unchanged inbox answers 304 |
| `GET /api/items/:id` | p95 < 5 ms warm, < 20 ms cold |
| Commands (done, snooze, correct), including fsync | p95 < 30 ms |
| SSE notice after a commit | p95 < 50 ms |
| UI first paint | < 1 s |
| Poll + triage of 25 threads, excluding Claude time | < 10 s (NF-7 total < 60 s) |
| Idle CPU | < 0.5 % average |
| Steady memory (RSS) | < 150 MB |

How the budgets are measured and met (M1 step 12):

- `npm run gen-data` makes the synthetic directory: 90 days of 60 Slack items a day (5,400 items, about 48,600 events), made-up text only. It refuses `~/WorkOS-data*` and any folder that is not empty.
- `npm run perf` bundles the server as `deploy` does, starts it with `--fakes` and the plist's Node flags, and measures over HTTP. Cold starts are the median of three. The poll budget runs the real adapter and pipeline in-process against the fake Slack at 150 ms a call. Claude time is not in it until M2.
- The inbox has an ETag from its body and is gzipped above 8 KB. It stays `no-store`, because summaries paraphrase messages and must not outlive retention in the browser's disk cache. The web client keeps the last inbox in memory and revalidates with `If-None-Match`.
- Node runs with `--max-semi-space-size=2` as well as `--max-old-space-size=256`. With V8's default young generation, RSS after the API run was about 169 MB; with the cap, it is 117–131 MB, and latencies are unchanged.

---

## 9. Roadmap to the full work OS

Each phase starts only when the previous phase meets its success criteria. Each new source retires the scheduled task it replaces.

### Phase 2: More sources

| Source | Approach | Approval needed | Retires |
|---|---|---|---|
| Outlook mail | Relay calls (R2.5) on the claude.ai Microsoft 365 connector, every 30 min in work hours and 120 min outside: `outlook_email_search` on Inbox and Sent Items, then `read_resource` for each new email, batched up to 10 per run, for the body, names, To/Cc and `conversationId` (one item per conversation). Sent Items is context only: triage sees Frank's replies as "me" and lanes don't move on their own, except a reply that settles an item's asks (cockpit CK-2.1), once Outlook is turned on for it. Go-live gate: three working days alongside the digest, at least 30 corrected emails, and S1/S2 on Outlook alone (`npm run eval -- --source outlook`). Our own Graph app registration is unlikely to get consent, and the connector is already approved for the tenant. Local reads are not viable: new Outlook for Mac caches mail in an undocumented binary store (`HxStore.hxd`) that only refreshes while Outlook runs. Fallback if P0-9 fails: add the account to Apple Mail and read its local store, which needs Full Disk Access. | P0-9 passes. Tell IT the approved connector will be polled automatically. | Daily Outlook digest |
| Outlook calendar | Relay calls (R2.5) on the same connector, every 30 min in work hours and 120 min outside (R2.8): `outlook_calendar_search` over a rolling window, then `read_resource` only for new or changed invites. Feeds an agenda strip on the inbox, adds calendar titles and invitees to Wispr Flow meetings, and makes unanswered invites triaged items. A shadow week in Full scope first. | P0-12 passes. Covered by the mail notice to IT. | Checking invites by hand in Outlook |
| Wispr Flow meetings | Wispr Flow's official MCP server, called from code with an MCP client and no model in the loop (R2.7), every 3 h in work hours. Amended from local reads of `flow.sqlite` (R2.6, P0-10) at Frank's choice: the MCP is the only supported way out and adds attendees and a share link. The local read stays the documented fallback if the MCP is withdrawn or its sign-in can't be kept. | P0-11 passes (P0-10 for the fallback) | Whichever scheduled task covers Wispr Flow notes, if any |
| Teams chats | Graph delta on chats Frank is in | `Chat.Read` delegated, admin consent | Part of the daily Teams transcript sweep |
| Teams meeting transcripts | Graph online meeting transcripts for meetings Frank organised or attended | `OnlineMeetingTranscript.Read.All` (admin-level; may be refused) | Daily Teams transcript sweep |
| Plaud | Plaud API if one is available to Frank; otherwise call the Plaud MCP server directly from code through an MCP client, with no model in the loop | Plaud account | Daily Plaud transcript sweep |

Requirements:

- **R2.1** Each source implements the same adapter interface: `fetchSince(cursor) → { items, nextCursor }`, plus `normalise`, `probe`, its dependencies (`deps`) and `needsNetwork`. The interface, the source registry, per-source schedules, cursors, health and circuit breakers are built in the MVP with Slack as the only adapter, so a Phase 2 source needs no changes to the core. After a wake, only overdue sources run, one after another (Slack, then email, then Wispr Flow). Amendment (R2.7): cursors are opaque strings that the cursor file compares as numbers only when both parse as numbers, and otherwise as text, so a source's cursor must sort as text (Wispr Flow: `modified_at|id`).
- **R2.2** Triage prompts gain per-source sections. The eval set gains labelled examples per source before the source goes live.
- **R2.3** Meeting items are triaged on the transcript summary, not the full transcript. Summarise with Haiku, or use Plaud's own summary.
- **R2.4** If a Graph permission is refused, the source stays on the existing scheduled task. No workarounds that bypass IT. Using a connector IT has already approved is not a workaround, but tell IT before polling through it.
- **R2.5** Relay fetch: for a source only reachable through a claude.ai connector, `claude/relay.ts` runs one Haiku call that may use exactly one connector tool (CL-9), up to 10 times with argument sets given by code (`relayBatch`).
  - **The call:** the connector is declared explicitly by its server id, because claude.ai connectors load asynchronously in headless runs. Amended (8 Oct 2026): the id lives in `settings.connectors.ms365`, shared by Outlook mail and calendar, and Settings finds it with `mcpServerStatus()` (P0-9 addendum), with a pasted id as the fallback. Code captures each raw tool result through a `PostToolUse` hook, and the model sees only "ok".
  - **The gate:** `canUseTool` allows each argument set asked for once, and refuses any other arguments or a repeat. Calls the model leaves out get one more run; any still missing go back to the source, which doesn't move its cursor past them.
  - **The adapter:** still normalises, dedupes and advances its cursor only after persisting.
  - **Failures:** connector trouble goes to its own dependency (`ms365`), not to `claude`. `needs-auth` or `disabled` in the init message shows as `auth_failed`, with the fix "reconnect it on claude.ai"; `pending` or `failed` is `degraded`; the tool missing from the init tool list is `tools_changed`.
  - **When:** built and tested on fixtures in the MVP, first used in Phase 2.
  - **Measured cost** (P0-9 addendum): about $0.001 and 5–6 s per search run; about $0.003 and 10 s for 10 reads in one run.
- **R2.6** Local reads: a source that keeps its data in a local database is read directly, read-only.
  - **Access:** `node:sqlite` with `readOnly`, `query_only`, a 2 s busy timeout and one short transaction per run.
  - **Tables:** allow-listed tables only. For Wispr Flow: `Meetings` (plus `Notes` and `Todos`, empty today), never the dictation `History`. Transcripts are read from `meetings/<id>/refined.ndjson` for vault drafts only; audio files are never read (P0-10 findings).
  - **Schema check:** a fingerprint compared on every run. A mismatch after an app update marks the source `degraded` (`schema_changed`) and sends a notification.
  - **Never** writes to the source database.
- **R2.7** MCP sources: a source whose only supported way out is a remote MCP server is read by code through an MCP client (`@modelcontextprotocol/sdk`), with no model in the loop. This is not the R2.5 relay: no Agent SDK call, no tokens.
  - **Sign-in:** OAuth with dynamic client registration and PKCE. The redirect is the server's own loopback address (`127.0.0.1`), the only API route without the bearer token, and it checks the OAuth `state`. The client registration and tokens live in the Keychain as one item (`wispr-oauth`), never in files or logs. Refresh tokens rotate, so the server is the only writer of that item.
  - **Tools:** an allow-list of read tools, checked against the server's tool list (with `readOnlyHint`) when connecting. For Wispr Flow: `get_account_info`, `search_meetings`, `get_meeting`, `get_meeting_participants_enriched`.
  - **Network:** every call has a deadline and goes through the source's own breaker (`wisprMcp`), with no SDK retries. A 401 or a failed refresh is `auth_failed` with the fix "Reconnect Wispr Flow in Settings". A 429 backs off.
  - **Content:** triage reads the summary and Frank's notes (R2.3). Transcripts are fetched only when drafting, and are never stored in `items/`.

- **R2.8** Calendar (P0-12): the calendar is read as a snapshot of a rolling window, not as a stream, because search filters on start time and has no modified time.
  - **Window:** from this week's Monday 00:00 (or yesterday, on a Monday) to 14 days ahead, London time, paged. The days already gone this week are for the calendar week view (cockpit CK-5.6); past meetings are never read. The snapshot lives in `state/calendar.json` and holds subjects, times, the organiser and attendees (names and addresses) and Frank's answer only: never a body, summary or join link. The agenda is read from the snapshot, outside the event log.
  - **Reads:** an event is read when it is new or its search fields changed (a hash), Frank isn't its organiser, it has attendees and it is still to come. An event that is never read (one that has started, or was answered before the first poll) keeps search's bare addresses; where it is shown, as on a Wispr Flow meeting joined to it, a name is made from the address (`sam.okafor@…` is Sam Okafor). Every event in an open invite is read again each poll, because search has no answer and only a read shows Frank has answered. At most 15 reads a poll, new and changed events first, then open invites, each soonest first; the rest wait for the next poll.
  - **Times:** UTC as the connector returns them; a named zone (IANA or Windows) is converted with `wallToUtc`.
  - **Invites:** an event needs an answer when Frank's attendee entry says `none`. With no series identity, unanswered events with the same organiser and subject are one item, `calendar:<sha1(organiser|subject)>`, kind `event`, so a weekly series asks once. Messages: `invite` and `moved` (which re-triages), with the Teams block and passcode cut. A cancellation is not a message: it closes the item, and the close carries the reason. Frank is matched by his address; an invite that reaches him only through a distribution list is not an item.
  - **Closing:** the source closes an invite item (`item.done`, by source) when Frank answers, every event in it is cancelled or gone, or the last one starts. If a reschedule resets his answer, the item opens again.
  - **Categories:** each event's Outlook category names come with search and are kept in the snapshot (a change needs no read), on invite items and on Wispr Flow meetings joined to an event. Their colours are `settings.calendar.categoryColors` (name → one of Outlook's 25), set in Settings › Outlook; a category without one has a steady colour from its name. Shown on agenda chips (a colour bar and a light shade behind), as tags on the item, and as a dot each beside the item's title in the inbox (the item cache keeps an item's event and categories, so the inbox needs no file reads).
  - **Before a meeting:** in the app only (Frank, 9 Oct 2026: Outlook already reminds him). From `settings.notifications.meetingLeadMinutes` (1 to 30, default 5) before a meeting until it starts, the sidebar shows it as Next and its agenda chip counts down, amber in the last two minutes; from its start until its end, the sidebar shows it as Now (Frank, 9 Oct 2026). Overlapping meetings are a line each, those on now first, then those to come, each soonest first; at most three, then "+N more". A line can be dismissed (Frank, 9 Oct 2026): that occurrence, by event ID and start, stays out of the sidebar until it ends, kept in the browser's preferences (`dismissedMeetings`) and dropped once it has ended; the agenda is unchanged. No notification, sound or motion. Only timed meetings Frank accepted, accepted tentatively or organised, not shown as Free. Worked out in the browser from the agenda, which carries the lead time.
  - **The cockpit (CK-3.4–3.7):** on a window 1600 px or wider, the agenda strip becomes the inbox's time column: the next meeting Frank is going to (the same rules as Before a meeting) with the Needs you items due before it starts, and the day as a timeline of meetings and deadline pins. The sidebar's Now/Next lines are left out there, as the card does their job; they return below 1600 px, where the strip stays.
  - **Mail:** while the calendar is on, meeting requests, updates and cancellations in Outlook mail are dropped when the calendar holds an event with the same subject (less any `Canceled:`/`Updated:` prefix) from the same sender, and the email has such a prefix or a Teams or Zoom joining block. Replies and forwards about a meeting stay in mail, as do answers.
  - **Health and cost:** the `ms365` dependency, shared with mail. About $0.002 a poll for two search pages, plus $0.0017 for each ten reads.

### Phase 3: More actions

| Action | Notes |
|---|---|
| Draft reply (Slack, email) | Drafted by Sonnet, opened in the native client as a draft. **Never auto-sent.** |
| Create JPD idea (PSPD) | Follows `psg-idea-importer` conventions: Pipeline Stage = triage, labelled for traceability. |
| Create Jira task | For delivery follow-ups, into an allow-listed project. |
| Commitments tracker | Extracts promises Frank made ("I'll send X by Friday") from his own messages into a Commitments lane with due dates. Supports follow-through. |
| Batched action execution | Approved actions run in groups by target page or note on a schedule, to cut repeated context loading (section 5.3). |

### Phase 4: Work OS

| Capability | Notes |
|---|---|
| Daily and weekly briefs | Generated from the event log and inbox state (Opus, once a day or week). Replaces the Weekly focus brief task. |
| Pre-meeting account brief | **To do (logged 8 Oct 2026, at Frank's request).** Builds on the calendar source (R2.8): before a customer meeting on the agenda, pulls related items, vault notes and CRM context into a brief. Shown as a P4 placeholder on the agenda and in Settings › Outlook until built. The first new build recommended in the October setup review. |
| CRM and call sources | Salesforce, HubSpot and Gong as read-only sources, for the revenue focus. Needs the matching approvals and data-rights checks. |
| Unified search | Across items, decisions and the vault, from the local files. Add a local search index (still file-based, e.g. MiniSearch persisted to JSON) when linear scans get slow. |
| Learning loop | Corrections become few-shot examples in the triage prompt, chosen by similarity. The eval gates every prompt change. |
| Plugin model | Sources and actions as folders with a manifest, so adding one needs no core changes. |
| Remote access or hosting | Out of scope while on the subscription. Moving off the laptop means an API key or Bedrock, PSG vendor and security review, and a re-check of Slack and Graph terms. |

---

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| User-token scopes (DMs, search) need admin approval | Low | Delays MVP | Frank already creates Slack apps. If user scopes are gated, start with channel history only and add DMs once approved. |
| Anthropic changes subscription terms for SDK use | Medium | Usage moves to a credit or API billing | CL-8 adapter switch. Usage log gives the numbers for a business case. |
| Triage precision too low | Medium | Noise, the app gets ignored | Eval harness, rules first, corrections loop, kill criteria. |
| Usage above baseline | Medium | Competes with Cowork work | Batching rules, budgets, usage panel, retire old tasks. |
| Writing wrong content into Confluence | Low | Pollutes the shared context | Scope rules with excluded pages, preview, people check, version check, approval. |
| Company data on the laptop | Low | Data-protection exposure | FileVault, localhost only, retention, Keychain secrets. |
| Scope creep before committed work lands | High | Delays MVI V2, Apidog and other commitments | Phase 0 first; phases gated on success criteria. |
| The server silently stops running (sleep, network loss, crash, bad settings) | Medium | Items missed while Frank thinks the app is watching | E13: launchd autostart, wake catch-up, degraded mode with a visible banner and rate-limited alerts, safe mode instead of a crash loop. |
| Wispr Flow changes its MCP tools, or its sign-in lapses | Medium | The Wispr Flow source stops | Tool allow-list checked on connect, response schemas validated with zod, `auth_failed` or `degraded` status and a notification, with a reconnect button (R2.7). Fallback: the local read (R2.6, P0-10). Other sources are unaffected. |
| A Claude Code or SDK update changes how claude.ai connectors load headless | Low | The email source stops | P0-9 passed with an explicit connector declaration. The relay checks the connector's status in the init message and shows `auth_failed` with a fix. Fallback: Apple Mail local store. |

---

## 11. Open questions

1. Does `search.messages` return thread replies and DMs reliably enough to be the primary fetch? (Spike FR-2.5.)
2. Which Agent SDK option names control the system prompt preset, tools, MCP servers and settings loading in the current SDK version? (Check docs at build time, CL-3.)
3. Is the Obsidian MCP server usable from the Agent SDK, or should vault reads use scoped file tools?
4. How does Haiku usage weigh against plan limits compared with Sonnet and Opus? Measure from the usage log.
5. ~~Which Confluence pages go on the initial allow-list (P0-6)?~~ Answered (7 Oct 2026): none. The scope is a live catalogue of the PSG context tree (FR-10.2, amended).
6. ~~Do claude.ai connectors load in a headless Agent SDK run under launchd, and what does one relay call cost?~~ Answered by P0-9: yes, if declared explicitly; about $0.009 per call. ~~Still open: does `mcpServerStatus()` expose the connector id, so setup needs no debug log?~~ Answered (8 Oct 2026, P0-9 addendum): yes, as `config.id`, with no model turn.
7. ~~Does Node's `fsync` on macOS issue `F_FULLFSYNC`?~~ Answered (6 Oct 2026): libuv's macOS `fsync` and `fdatasync` both use `F_FULLFSYNC`, falling back to `F_BARRIERFSYNC`. Measured on this Mac (Node 24.16, libuv 1.52.1, APFS): `datasync` and `sync` both take 3.0 ms p50 and under 4 ms p95, which is drive-flush time, not the ~0.1 ms of a plain `fsync`. Group commit keeps this to one sync per batch, well inside the 30 ms command budget (NF-11).
