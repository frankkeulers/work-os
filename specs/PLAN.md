# Work OS: Plan and Requirements

Owner: Frank Keulers
Status: Draft v0.1, 5 Oct 2026
Working name: Work OS (rename freely)

---

## 1. Summary

A local app on Frank's laptop that polls work sources, decides what each item needs, and lets Frank act on it with one click.

For every incoming conversation it answers three questions:

1. Does it need Frank's attention (now, today, or not at all)?
2. Should it go into the Confluence PRD context?
3. Should it become a note in the Obsidian vault?

Where the answer is yes, the UI offers an action. Claude drafts it, Frank approves it, and the app writes it.

The MVP covers Slack only. Later phases add Outlook, Teams, Plaud and more actions, until the app replaces the current Cowork scheduled tasks and becomes Frank's personal work OS.

### Design principles

1. **Code fetches, Claude decides, Frank approves, code writes.** No model reads sources through connectors in a loop, and no model writes to a shared system without approval.
2. **Anthropic models only, on Frank's Claude subscription.** No API key. No third-party model providers.
3. **No database.** All state lives in local files: an append-only event log, JSON state files and settings.
4. **Every new source retires a scheduled task.** Running the new and old pipelines side by side is a failure mode, not a transition plan.
5. **Usage is measured, not assumed.** Every Claude call is logged with tokens and cost-equivalent.

### Timing

Phase 0 tasks (Slack app, baseline, labelling) can start now because they're quick and unblock the build. Code starts after the MVI V2 launch (15 Oct 2026) and the Apidog cutover have landed.

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
| S4 | Frank opens the dashboard | ≥ 4 of 5 working days in week 2 |
| S5 | Writes to Confluence or vault without approval | 0 |
| S6 | Observations about people written to Confluence | 0 |
| S7 | Slack knowledge digest scheduled task | Disabled |

### Kill criteria

Stop or redesign if any of these hold:

- S1 below 70% after two rounds of prompt tuning.
- S4 not met in week 2 (it has become another inbox nobody checks).
- S3 exceeded by more than 50% after the batching fixes in section 8.

---

## 3. Phase 0: pre-build gates (no code)

| ID | Task | Owner | Why |
|---|---|---|---|
| P0-1 | Create an **internal** Slack app in the PSG workspace (Frank has done this before for PDW and Meridia). Request the user-token scopes in section 7.1 and install it to get a user token. | Frank | Internal apps are exempt from Slack's 2025 rate-limit cuts for non-Marketplace apps. Check at install time that the user scopes (`search:read`, `im:history`, `mpim:history`) don't trigger an admin-approval step that bot-only apps didn't. |
| P0-2 | Confirm the Claude Agent SDK runs on Frank's PSG Claude plan with no `ANTHROPIC_API_KEY` set. One test call with Haiku. | Frank | Confirms subscription auth works on this plan, and records the usage it draws. |
| P0-3 | Measure the baseline: run the Slack digest prompt once with `claude -p --output-format json` and record `usage` and `total_cost_usd`. Repeat on a busy weekday. | Frank / Claude Code | Sets the S3 budget. |
| P0-4 | Build the labelled set: export 2 weeks of Slack threads Frank took part in or was mentioned in. Label ~200 threads for attention (now/today/none), confluence (y/n), vault (y/n). | Frank (Claude can pre-label for review) | Needed for the eval harness and thresholds. |
| P0-5 | Write down the vault conventions (frontmatter fields, note types, folders, linking rules) as a file the app can load. Source: Note Manager project. | Frank | Vault writes must match existing conventions. |
| P0-6 | List the Confluence pages the app may write to (allow-list of page IDs) and the space. | Frank | Limits the blast radius of Confluence writes. |
| P0-7 | Confirm FileVault is on. | Frank | Local files will hold company messages. |
| P0-8 | Create a personal Atlassian API token for Confluence REST writes, and store it in the macOS Keychain. | Frank | Deterministic writes without an LLM in the loop. |

---

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
| Slack | `@slack/web-api` with a user token | Read-only scopes. |
| Confluence writes | Confluence Cloud REST API v2 | Atlassian API token from Keychain. |
| Secrets | macOS Keychain (`security` CLI or `keytar`) | Never in settings files or logs. |
| Real-time UI | Server-Sent Events | No websockets needed. |
| Logging | pino (JSON lines) | Daily files. |

### 4.2 Repo layout

```
work-os/
  CLAUDE.md
  PLAN.md                     (this file)
  apps/
    server/
      src/
        sources/slack/        adapter: fetchSince, normalise
        pipeline/             quietWindow, rules, triage, scheduler
        actions/              drafters (vault, confluence), executors
        claude/               single adapter around the Agent SDK + usage logging
        store/                event log, item files, snapshots, cursors, atomic writes
        api/                  REST routes + SSE
        config/               settings loader + validation
    web/
      src/                    inbox, item detail, action preview, settings, usage
  packages/
    shared/                   zod schemas + types
  prompts/                    default prompt templates (copied to data dir on first run)
  scripts/
    eval.ts                   runs triage over labels, reports precision/recall/usage
    rebuild-state.ts          rebuilds snapshot from the event log
```

### 4.3 Data directory (no database)

All runtime data lives outside the repo, default `~/WorkOS-data/` (configurable via `WORKOS_DATA_DIR`).

```
~/WorkOS-data/
  config/
    settings.json             sources, schedules, model map, budgets, allow-lists, VIPs
    rules.json                deterministic triage rules
    vault-conventions.md      from P0-5
    prompts/
      triage.md
      draft-vault.md
      draft-confluence.md
  state/
    cursors.json              last cursor per source
    snapshot.json             materialised inbox state (rebuildable from events)
    lock                      single-instance lock
  events/
    2026-10-20.jsonl          append-only event log (the audit trail)
  items/
    slack/<itemId>.json       raw thread content (subject to retention)
  drafts/
    <actionId>.json           draft content + target + base version
  labels/
    triage.jsonl              labelled set + corrections from the UI
  logs/
    app-2026-10-20.log
    usage-2026-10-20.jsonl    one line per Claude call
```

Rules for file storage:

- **The event log is the source of truth.** `snapshot.json` is a cache, rebuilt from events by `scripts/rebuild-state.ts` and on corruption.
- **Atomic writes**: write to `*.tmp`, `fsync`, then `rename`. Appends to JSONL use a single writer.
- **Single instance**: take a lock on `state/lock` at startup and refuse to start if it's held.
- **Retention**: delete raw content in `items/` older than `retention.rawContentDays` (default 30). Events keep IDs, decisions and permalinks, never message bodies.
- **Schema versioning**: every file and event carries `schemaVersion`.
- **No secrets** in any file under the data directory.

### 4.4 Core types (sketch)

```ts
type SourceId = 'slack' | 'outlook' | 'teams' | 'plaud';

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

type Attention = 'now' | 'today' | 'none';

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
  | 'item.done' | 'item.snoozed'
  | 'action.requested' | 'action.drafted' | 'action.approved'
  | 'action.executed' | 'action.failed' | 'action.discarded'
  | 'source.polled' | 'source.failed';
```

---

## 5. Claude usage design

### 5.1 Model map (configurable in `settings.json`)

| Purpose | Default model | Call shape |
|---|---|---|
| Triage | Haiku 4.5 (`haiku`) | One batched call per poll, only when threads are eligible. No tools, no MCP, short custom system prompt, single turn, JSON output. |
| Draft vault note | Sonnet 5.5 (`sonnet`) | Per click. Read-only vault access to find related notes. Output is the final markdown file. |
| Draft Confluence entry | Sonnet 5.5 (`sonnet`) | Per click. Read-only Confluence access to choose the page and section. Output is a structured patch. |
| Multi-source synthesis (later) | Opus 5.5 (`opus`) | Rare. Briefs and weekly reviews. |

### 5.2 Hard requirements for every Claude call

- **CL-1** All calls go through one module, `apps/server/src/claude/`. Nothing else imports the SDK.
- **CL-2** On startup the server refuses to run if `ANTHROPIC_API_KEY` is set. The goal is subscription usage, and the SDK would silently prefer the key.
- **CL-3** Each call sets its model, system prompt, allowed tools, MCP servers, setting sources and max turns explicitly. Defaults are not trusted. Check option names against the current Agent SDK docs before implementing.
- **CL-4** Triage calls load **no** Claude Code system prompt preset, **no** tools, **no** MCP servers and **no** filesystem settings. This keeps the per-call overhead to the triage prompt itself.
- **CL-5** Every call appends to `logs/usage-*.jsonl`: timestamp, purpose, model, input/output/cache tokens, cost-equivalent, duration, item IDs, prompt version.
- **CL-6** Daily budgets in settings (`budgets.triageCallsPerDay`, `budgets.draftsPerDay`, `budgets.costEquivalentPerDay`). When a budget is hit, the triage queue pauses, rules-only triage continues, and the UI shows a banner.
- **CL-7** Model outputs are validated with zod. On a schema failure, retry once, then mark the item `triage_failed` and show it in the inbox untriaged.
- **CL-8** The adapter is swappable. One setting switches the backend to an API key or Bedrock without changes elsewhere, in case subscription terms change.

### 5.3 Batching rules (to stay under the baseline)

- Triage only threads that have been quiet for `quietMinutes` (default 10). VIP rules bypass the wait.
- Batch all eligible threads into one call, up to `triage.maxThreadsPerCall` (default 25) and `triage.maxInputTokens`.
- Truncate long threads: keep the first message, the last N messages and any message mentioning Frank.
- Re-triage a thread only when its `revision` changes and the new messages are not from Frank alone.
- Skip the call entirely when nothing is eligible.

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
| M1 Ingest and store | E1 Settings and storage · E2 Slack polling · E3 Read-only inbox | 3–4 days |
| M2 Triage | E4 Rules · E5 Haiku triage · E6 Eval and feedback · E7 Usage tracking | 3–4 days |
| M3 Actions | E8 Vault note action · E9 Confluence entry action · E10 Notifications | 4–5 days |
| M4 Cut-over | E11 Hardening · E12 Retire the digest and measure | 2–3 days + 2 weeks of measurement |

---

## 7. MVP requirements

### 7.1 E1 Settings and storage

**FR-1.1** The server creates the data directory structure on first run and copies default prompts into `config/prompts/`.

**FR-1.2** `settings.json` is validated with zod at startup. Invalid settings stop the server with a clear message.

**FR-1.3** Settings include at least: data dir, poll schedule (work hours, interval in work hours, interval off hours), Slack channel include/exclude lists, VIP user IDs, quiet minutes, model map, budgets, retention days, Confluence allow-list (space key + page IDs), vault path, dry-run flag.

**FR-1.4** The event log, item files, cursors and snapshot follow the storage rules in section 4.3.

**FR-1.5** The UI settings page edits `settings.json` and `rules.json`. Changes are validated before saving and logged as events.

**FR-1.6** Dry-run mode (default **on** in development) redirects vault writes to `~/WorkOS-data/sandbox/vault/` and turns Confluence writes into logged no-ops.

> **Story 1.1** As Frank, I want all Work OS state in plain local files so that I can inspect, back up or delete it without a database.
>
> - Given a fresh install, when the server starts, then the data directory and default config files exist.
> - Given a corrupted `snapshot.json`, when the server starts, then it rebuilds state from the event log and logs a warning.
> - Given a second server instance, when it starts, then it exits because the lock is held.

### 7.2 E2 Slack polling

**FR-2.1** User-token scopes, all read-only: `search:read`, `channels:history`, `groups:history`, `im:history`, `mpim:history`, `channels:read`, `groups:read`, `im:read`, `mpim:read`, `users:read`.

**FR-2.2** The Slack token is read from the Keychain at startup. It is never logged.

**FR-2.3** Primary fetch: `search.messages` with a date filter, then filter by `ts > cursor`. This gets all channels and DMs Frank can see in one call per page.

**FR-2.4** Fallback fetch (setting `slack.fetchMode = "history"`): `conversations.history` for included channels and DMs, plus `conversations.replies` for active threads.

**FR-2.5** Spike in M1: verify that search returns thread replies and DMs reliably, and how long it lags. Pick the primary mode based on the result and record the finding in this file.

**FR-2.6** Messages are grouped into items by thread (`thread_ts`) or, for DMs without threads, into windows separated by a gap of 30+ minutes.

**FR-2.7** Polling interval comes from settings (default 10 min in work hours, 60 min outside). The scheduler detects sleep or wake (a clock jump larger than 2× the interval) and polls immediately.

**FR-2.8** Polling is idempotent. Message `ts` is the dedupe key. The cursor only advances after the items are persisted.

**FR-2.9** On HTTP 429, honour `Retry-After`. Other failures back off exponentially and emit `source.failed`. The UI shows source health.

**FR-2.10** Bot messages and excluded channels are dropped at ingest. They are not stored.

> **Story 2.1** As Frank, I want the app to catch up on Slack after my laptop has been asleep so that nothing is missed.
>
> - Given the laptop slept for 3 hours, when it wakes, then the next poll runs within 1 minute and fetches all messages since the last cursor.
> - Given a poll fails halfway, when the next poll runs, then no messages are duplicated or skipped.

### 7.3 E3 Read-only inbox (M1)

**FR-3.1** The UI lists items newest-first with source, channel, participants, last activity and a permalink to Slack.

**FR-3.2** The UI updates over SSE when items change.

**FR-3.3** The API is only reachable on `127.0.0.1`, and requires a per-install bearer token (generated on first run, injected into the served UI). CORS allows only the app's own origin.

### 7.4 E4 Rules

**FR-4.1** `rules.json` holds ordered rules. Each rule has `id`, conditions (sender in list, channel in list, mentions Frank, DM, keyword regex) and an outcome (attention level, drop, or "send to model").

**FR-4.2** The first matching rule wins. A rule outcome of a fixed attention level skips the model call.

**FR-4.3** Default rules: DMs from VIPs → `now`; @-mentions of Frank → send to model with a minimum of `today`; excluded channels → drop.

### 7.5 E5 Haiku triage

**FR-5.1** Triage runs after each poll on items that are eligible under section 5.3.

**FR-5.2** The prompt (`config/prompts/triage.md`) contains:
- Frank's role in a few lines. No observations about people.
- Definitions and 2–3 examples per category: `now`, `today`, `none`, confluence-worthy, vault-worthy.
- The rule that observations about named people are vault-only and must set `containsPeopleObservations`.
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

**FR-6.1** `npm run eval` runs triage over `labels/triage.jsonl` and reports precision and recall per category, the confusion matrix for attention, and tokens and cost-equivalent used.

**FR-6.2** In the UI, Frank can correct any decision with one click (attention level, confluence y/n, vault y/n). Corrections append to `labels/triage.jsonl` and emit `triage.corrected`.

**FR-6.3** The eval report is saved to `logs/eval-<timestamp>.json` so prompt changes can be compared.

> **Story 6.1** As Frank, I want to correct a wrong triage in one click so that the labelled set grows from real use.
>
> - Given an item labelled `none`, when I set it to `today`, then the inbox moves it and the label file gains one line.

### 7.7 E7 Usage tracking

**FR-7.1** Implements CL-5 and CL-6.

**FR-7.2** The UI usage panel shows today's and the last 7 days' calls, tokens and cost-equivalent by purpose and model, against the Phase 0 baseline.

### 7.8 Inbox lanes (M2 UI)

**FR-8.1** The inbox shows two groups: **Needs you** (attention now or today, plus items whose triage failed, shown untriaged) and **To file** (confluence or vault suggested, attention none). Needs you lists Now items first, then failed ones, then Today items by deadline. **Low priority** (no attention, nothing to file) is a footer link that opens its list. Lanes stay as before underneath (now, today, file, else, failed, waiting).

**FR-8.2** Item actions: Open in Slack, Done, Snooze (1h / tomorrow 09:00 / custom), Correct triage, Draft vault note, Draft Confluence entry.

**FR-8.3** Done and snoozed items leave the two groups. Each has a footer link that opens its list (Snoozed shows when the next one comes back). Snoozed items return at the snooze time, marked "Back from snooze". Threads waiting for the quiet window show as a quiet "N still active" link in the header.

### 7.9 E8 Vault note action

**FR-9.1** "Draft vault note" emits `action.requested` and runs a Sonnet draft with:
- the item content,
- `vault-conventions.md`,
- read-only access to the vault to find related notes. Prefer the Obsidian MCP server if available to the SDK; otherwise allow `Read`, `Grep` and `Glob` scoped to the vault path.

**FR-9.2** The draft output is either a **new note** (path + full markdown) or an **append** to an existing note (path + heading anchor + markdown block). Either way it follows the vault conventions, including frontmatter and links.

**FR-9.3** The UI shows a preview: a diff for appends, full content for new notes. Frank can edit the text before approving.

**FR-9.4** On approval, **code** writes the file (no model involved). For appends, the executor checks that the file's hash matches the hash at draft time. If it changed, it re-drafts instead of writing.

**FR-9.5** People observations are allowed in the vault (it is private), but only in the notes the conventions allow for them.

> **Story 9.1** As Frank, I want to turn a Slack thread into a vault note with one review so that knowledge lands in my vault without copy-paste.
>
> - Given a thread suggested for the vault, when I click Draft vault note, then a preview appears within ~60 seconds showing the target path and content.
> - Given I approve, when the executor runs, then the file is written and `action.executed` is logged with the path.
> - Given the target note changed after drafting, when I approve, then the app re-drafts instead of overwriting.

### 7.10 E9 Confluence entry action

**FR-10.1** Allowed only for items where `containsPeopleObservations` is false. Otherwise the button is disabled with an explanation.

**FR-10.2** "Draft Confluence entry" runs a Sonnet draft with read-only Confluence access (Atlassian MCP or REST search) limited to the allow-listed space and pages, and the `psg-context-builder` routing guidance (see CLAUDE.md for how to make the skill available).

**FR-10.3** The draft output is a structured patch: page ID, page version at draft time, section heading anchor, and content in Confluence storage format.

**FR-10.4** Before showing the preview, a second Haiku check confirms there are no observations about named people. If it finds any, the draft is blocked.

**FR-10.5** On approval, **code** applies the patch through the Confluence REST API, with an optimistic version check. A version mismatch means re-draft, never overwrite.

**FR-10.6** Pages outside the allow-list are refused by the executor, whatever the draft says.

> **Story 10.1** As Frank, I want to file a decision from Slack into the right Confluence context page so that the PSPD pipeline and the Knowledge Desk can use it.
>
> - Given a thread suggested for Confluence with no people observations, when I click Draft Confluence entry, then I see the target page, section and content.
> - Given the page was edited after the draft, when I approve, then the app re-drafts instead of writing.
> - Given a draft targets a page outside the allow-list, when I approve, then the executor refuses and logs `action.failed`.

### 7.11 E10 Notifications

**FR-11.1** New `now` items trigger a macOS notification with the one-line summary. Clicking it opens the item in the UI.

**FR-11.2** No more than one notification per item. Quiet hours come from settings.

### 7.12 E11 Hardening

- **FR-12.1** Retention job runs daily (section 4.3).
- **FR-12.2** Startup checks: FileVault on (warn if not), no `ANTHROPIC_API_KEY`, Slack token present, Claude login works (one minimal Haiku call, logged).
- **FR-12.3** launchd plist so the server starts at login (optional in MVP, required in Phase 2).
- **FR-12.4** Tests: unit tests for rules, quiet window, grouping, cursor handling, atomic writes and executors. Contract tests for model output schemas, using recorded fixtures. There is no live-model call in CI.

### 7.13 E12 Cut-over and measurement

- **FR-13.1** After 3 working days of parallel running, compare the Work OS output with the Slack digest. Then disable the digest scheduled task.
- **FR-13.2** Measure S1–S7 for 2 working weeks and record the results in this file.

---

## 8. Non-functional requirements

| ID | Area | Requirement |
|---|---|---|
| NF-1 | Privacy | Data stays on the laptop. No telemetry. The server binds to localhost only. |
| NF-2 | Privacy | Observations about people never leave the vault. Enforced by FR-10.1 and FR-10.4. |
| NF-3 | Security | Secrets live only in the Keychain. Never logged, never in files or prompts. |
| NF-4 | Security | Slack scopes are read-only. The app never sends messages in the MVP. |
| NF-5 | Safety | Every write needs explicit approval. Executors re-validate the target (allow-list, version or hash) at write time. |
| NF-6 | Reliability | Polling is idempotent. State can be rebuilt from the event log. Single instance. |
| NF-7 | Performance | A poll with triage completes in under 60 s for 25 threads. The UI first paint is under 1 s. |
| NF-8 | Cost | Daily usage stays at or under the Phase 0 baseline (S3). The usage panel makes drift visible. |
| NF-9 | Portability | The Claude adapter can switch to an API key or Bedrock through settings only (CL-8). |
| NF-10 | Compliance | Internal tool, not customer-facing, so the EU AI Act customer-facing obligations do not apply. Re-assess if any part is exposed to customers. |

---

## 9. Roadmap to the full work OS

Each phase starts only when the previous phase meets its success criteria. Each new source retires the scheduled task it replaces.

### Phase 2: More sources

| Source | Approach | Approval needed | Retires |
|---|---|---|---|
| Outlook mail | Microsoft Graph delta query on the Inbox, polled. No webhooks, so no public endpoint. | Entra app registration + admin consent (delegated `Mail.Read`) | Daily Outlook digest |
| Teams chats | Graph delta on chats Frank is in | `Chat.Read` delegated, admin consent | Part of the daily Teams transcript sweep |
| Teams meeting transcripts | Graph online meeting transcripts for meetings Frank organised or attended | `OnlineMeetingTranscript.Read.All` (admin-level; may be refused) | Daily Teams transcript sweep |
| Plaud | Plaud API if one is available to Frank; otherwise call the Plaud MCP server directly from code through an MCP client, with no model in the loop | Plaud account | Daily Plaud transcript sweep |

Requirements:

- **R2.1** Each source implements the same adapter interface: `fetchSince(cursor) → { items, nextCursor }`, plus `normalise` and `health`.
- **R2.2** Triage prompts gain per-source sections. The eval set gains labelled examples per source before the source goes live.
- **R2.3** Meeting items are triaged on the transcript summary, not the full transcript. Summarise with Haiku, or use Plaud's own summary.
- **R2.4** If a Graph permission is refused, the source stays on the existing scheduled task. No workarounds that bypass IT.

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
| Pre-meeting account brief | Calendar-aware. Pulls related items, vault notes and CRM context before customer meetings. The first new build recommended in the October setup review. |
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
| Writing wrong content into Confluence | Low | Pollutes the shared context | Allow-list, preview, people check, version check, approval. |
| Company data on the laptop | Low | Data-protection exposure | FileVault, localhost only, retention, Keychain secrets. |
| Scope creep before committed work lands | High | Delays MVI V2, Apidog and other commitments | Phase 0 now; code after 15 Oct; phases gated on success criteria. |

---

## 11. Open questions

1. Does `search.messages` return thread replies and DMs reliably enough to be the primary fetch? (Spike FR-2.5.)
2. Which Agent SDK option names control the system prompt preset, tools, MCP servers and settings loading in the current SDK version? (Check docs at build time, CL-3.)
3. Is the Obsidian MCP server usable from the Agent SDK, or should vault reads use scoped file tools?
4. How does Haiku usage weigh against plan limits compared with Sonnet and Opus? Measure from the usage log.
5. Which Confluence pages go on the initial allow-list (P0-6)?
