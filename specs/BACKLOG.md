# Work OS: backlog of enhancements, features and review findings

Owner: Frank Keulers
Started: 11 Oct 2026, from the full code and UX review

## How this file works

This file lists ideas that are not yet planned. When one is picked up, it moves into `PLAN.md` or
a SPEC (such as `cockpit/SPEC.md`) with requirement IDs, and its row here links there.

Each entry has a stable ID that commits can cite:

| Prefix | Section |
|---|---|
| `UX` | UX enhancements |
| `FT` | Features |
| `IN` | Insights groundwork |
| `RV` | Review findings |

| Status | Meaning |
|---|---|
| `idea` | Recorded, not yet looked at |
| `investigate` | Needs a spike or a decision before it can be specced |
| `specced` | Has requirements in PLAN.md or a SPEC |
| `built` | Shipped |

The aim behind every entry: a frictionless way to funnel incoming channels (Slack, Outlook mail and
calendar, Wispr Flow, later Teams) into the right next step (vault note, Confluence, to-do, reply,
later). After that, the aim is to use what flows through to improve the products and the way of
working.

---

## 1. UX enhancements

Ranked by friction removed. Here is the core funnel on the wide cockpit as it stood on 11 Oct
2026:

| Flow | Steps today | Keyboard only? |
|---|---|---|
| Close | `e`, or `⇧E` for done and next | Yes |
| Later | `s`, Tab ×n, Enter | Partly |
| Reply | Click Reply in Slack and switch apps; closes on its own once settled | No |
| Vault note or Confluence entry | Click Draft, wait 30–60 s, scroll, click Approve, click "Mark done and next item" | No |
| To-do | No target exists | — |

| ID | Enhancement | Why | Depends on | Status |
|---|---|---|---|---|
| UX-1 | **Filing actions on single keys.** `v` vault, `f` Confluence, `r` reply in source, `⌘↵` approve (or save and approve while editing), `x` discard, `z` undo from an undo stack. Number keys in the snooze menu, and `s s` for the suggested snooze. | Filing has no keyboard path today. | — | idea |
| UX-2 | **A sticky action bar while a draft is open.** "Approve and next ⌘↵ · Edit · Re-draft · Skip →" in the panel footer. | Approve sits below the fold, including in batch filing. | — | idea |
| UX-3 | **Draft ahead in the background**, within the drafts budget. Start the suggested draft when an item enters To file or when `j`/`k` lands on it. | Review becomes instant. Makes the batch's "one ahead" the default. | Budget headroom (Usage) | idea |
| UX-4 | **Close on file.** When every suggested filing is written, mark the item done with an Undo toast, as a batch already does. | Removes the "Mark done and next" click. Answers cockpit open question 5. | — | idea |
| UX-5 | **To-do as a first-class target.** `t` writes `- [ ] {next.step} 📅 {dueAt} [[source]]` to the Obsidian daily note or a Tasks note. The panel's "Action items for you" checkboxes call it. | To-dos are a destination in the funnel, but there is no target. The checkboxes aren't saved (RV-W8). | Vault conventions for tasks | idea |
| UX-6 | **Notifications and toasts open the item in the inbox panel** (`/?item=…&file=…`), not the full page. | Keeps your place and your keys. | — | idea |
| UX-7 | **A target picker.** A combobox on "Append to", listing the catalogue, recent pages and recent notes. Changing it re-runs placement only. | Today the only lever is Re-draft, which costs budget. | — | idea |
| UX-8 | **A ⌘K command palette.** Jump to an item, channel, setting or source history, or act on the selection. | Replaces the placeholder Full-scope search box. Fast navigation. | — | idea |
| UX-9 | **Gmail-style multi-select.** `x` toggles, shift-click selects a range, then `e`, `s` or `b` (file in a batch) act on the selection. | Bulk today is only "Mark all done" per channel. | — | idea |
| UX-10 | **An end-of-day sweep.** A batch over Needs you: `e`/`s`/`r`/`f`/`v` per item, with a tally at the end. | Aims at C3 (Needs you empty at 18:00). | UX-1 | idea |
| UX-11 | **A `?` overlay** that shows the keys for the current context (list, panel, draft, batch). | Today `?` leaves the inbox for the guide. | UX-1 | idea |
| UX-12 | **Done today shows filings**: what was written where, with Open note or Open page, and Undo. | Lets you trust the funnel without checking Obsidian or Confluence. | — | idea |
| UX-13 | **Don't open the panel on load** on the cockpit. | It covers Later until you close it once. | — | idea |

---

## 2. Features

| ID | Feature | Why | Existing ID | Status |
|---|---|---|---|---|
| FT-1 | **Draft reply.** Sonnet drafts a Slack or email reply, opened in the native client as a draft and never sent. Pairs with the settle check, so a sent reply closes the item. | Reply is the most common exit from Needs you. | PLAN §9 Phase 3 | idea |
| FT-2 | **JPD idea (PSPD).** "This is a feature request" becomes one key. It follows `psg-idea-importer`: Pipeline Stage = triage, labelled for traceability, evidence linked. | Sends customer asks straight to discovery. | PLAN §9 Phase 3 | idea |
| FT-3 | **Jira task** into an allow-listed project, for delivery follow-ups. | A to-do that belongs to the team, not to you. | PLAN §9 Phase 3 | idea |
| FT-4 | **Commitments tracker.** Promises you made in your own messages ("I'll send X by Friday") become a lane with due dates. | Follow-through. Most inputs exist already: your messages, `next.dueAt`, settle checks. | PLAN §9 Phase 3 | idea |
| FT-5 | **File related items together.** One note per meeting, with its thread, its email and its invite, closing all of them. | Fewer, better notes, and nothing left open. | cockpit CK-6.1–6.4 | specced |
| FT-6 | **A people map across sources.** Slack IDs, email addresses and Wispr Flow names, maintained in Settings. | Needed by FT-5, rules and VIPs, the people check, IN-3 and FT-7. | cockpit Stage 6 open question 1 | idea |
| FT-7 | **Pre-meeting brief.** Related items, vault notes and open asks for the people in the next meeting, on the time column's card. | Walk into a meeting knowing what's open. | PLAN §9 Phase 4 | idea |
| FT-8 | **Teams chats as a source**, joining auto-close. | A channel that isn't read yet. | PLAN §9 Phase 2, cockpit B4 | idea |
| FT-9 | **A learning loop.** Corrections become few-shot examples, chosen by similarity. Usage shows precision per source. | Triage gets better from the corrections you already make. | PLAN §9 Phase 4 | idea |
| FT-10 | **Daily and weekly briefs** generated from the event log and inbox state. | Replaces the weekly focus brief task. | PLAN §9 Phase 4 | idea |

---

## 3. Insights groundwork

These entries are the groundwork for the next phase: using what flows through Work OS to suggest
product features, spot process improvements and see where your time should go.

### What survives today

Structured fields in the event log are kept forever:
- source, title, participants;
- triage attention, `targetHint` (free text), `next.need`, `dueAt`;
- corrections, closes (with their reason), snoozes;
- `topic.routed` merges and splits;
- action targets.

Also kept: the labels files and the usage log. See `packages/shared/src/events.ts`,
`apps/server/src/store/labels.ts` and `apps/server/src/claude/usage.ts`.

Free text (items, decisions, asks) expires after 30 days.

| ID | Item | Why | Depends on | Status |
|---|---|---|---|---|
| IN-1 | **An anonymised digest per item, taken before it expires.** Fields: theme, product area, ask type, customer or segment if named, sentiment. Produced by the triage call (a few extra fields, no extra call), stored in the log or `digests/*.jsonl`. | Without it, nothing older than 30 days can be analysed. Also settles the open retention question for `labels/` (RV-S12). | IN-2 | investigate |
| IN-2 | **A product and theme taxonomy** seeded from the Confluence PRD tree (product › area), which triage picks from instead of writing `targetHint` freely. | Makes themes countable over time. | — | investigate |
| IN-3 | **Cross-source identity.** | Needed for "who keeps asking for X". | FT-6 | idea |
| IN-4 | **Insight runs.** A weekly Opus pass over the digests: recurring asks per product area, offered as a draft JPD idea with its evidence (FT-2); process friction, such as the same question from many people or approvals that block for days (`need: approve` × time open); where your time went against your stated priorities. | The goal of the next phase. | IN-1, IN-2, IN-3 | idea |
| IN-5 | **A local vector database.** See below. | Similarity search across everything Work OS has seen. | — | investigate |

### IN-5: a local vector database

**Question (Frank, 11 Oct 2026):** could we run a local vector database to ingest Work OS data and
run insights from it? This entry records what a spike has to answer. It is not an answer.

**Fit with the design principles**
- **No database (PLAN §1, principle 3).** An embedded, file-based index fits the spirit of the
  principle. A vector server doesn't. Candidates:
  - `sqlite-vec` on the `node:sqlite` the app already uses;
  - LanceDB embedded;
  - a flat vector file searched by brute-force cosine similarity.
- **Anthropic models only (principle 2).** Anthropic offers no embeddings model, so this needs one of:
  - a local embedding model running in-process with no network (for example transformers.js or
    ONNX with MiniLM or BGE);
  - an amendment to principle 2.

  **Frank's decision.**

**Scale**
- Expect a few thousand items a month. A brute-force scan over that many 384-dimension vectors
  takes milliseconds.
- So check whether a plain vector file is enough before adding a library.

**What to embed, and for how long**
- Embeddings of raw text count as raw content, because they can be partly inverted. They would
  follow the 30-day retention, like `items/`.
- Long-lived insight would embed the anonymised digests (IN-1) instead.
- Vault notes and filed Confluence pages could be embedded too, read-only.

**Use cases to test it against**
- Find related items (FT-5, CK-6.1).
- "Already filed" detection for the vault and Confluence (drafts today scan the whole vault, RV-E2).
- The pre-meeting brief (FT-7).
- Recurring themes and asks across sources (IN-4).
- Choosing few-shot examples for the learning loop (FT-9).
- Unified search: PLAN §9 Phase 4 already suggests MiniSearch for lexical search; vectors would sit
  beside it.

**Shape of the spike**
- Offline and read-only, over a `gen-data` folder.
- Measure index build time, query latency, and recall on a handful of hand-labelled "related" pairs.
- Then decide.

---

## 4. Review findings (Medium and Low)

These come from the 11 Oct 2026 review. The Critical and High findings were fixed on the
`review-fixes` branch. The findings below were checked against the code at the time, so line
numbers may have moved since.

### Correctness and robustness: server and pipeline (`RV-S`)

| ID | Finding | Where | Suggested fix |
|---|---|---|---|
| RV-S1 | A double submit creates duplicate drafts: two Sonnet calls for one click. | `actions/service.ts` `request()` | An in-memory pending set keyed `itemId\|type`, held until the append resolves |
| RV-S2 | Single Done isn't idempotent, so you get two `item.done` events and two Undo toasts. Bulk Done dedupes before resolving topic anchors. | `api/routes.ts` (done routes) | Skip items already done; dedupe after mapping to the anchor |
| RV-S3 | Rules are lost on topics. A fixed now/today rule that matches a part doesn't reach the anchor, and fixed rules fire again after you've replied. | `pipeline/poll.ts`, `pipeline/triage.ts`, `shared/rules.ts` | Evaluate rules on the anchor; match fixed rules on messages since your last one |
| RV-S4 | A poll and a "Reply in…" re-read can race on the same item, so your reply re-triages the item instead of getting a settle check. | `runtime/runtime.ts`, `pipeline/poll.ts` | Run re-reads through the poll queue, or read `prev` under the item lock |
| RV-S5 | Startup recovery quarantines events that fail today's schema, so a rollback loses state. | `store/recover.ts` | Keep unknown events in the log, skip them in the reducer, add upcasters by `schemaVersion` |
| RV-S6 | One bad field in one triage decision fails or re-sends the whole batch. | `pipeline/triage.ts`, `claude/adapter.ts` | Validate each decision; clamp text that's too long |
| RV-S7 | Settle checks give up after Claude outages, because an outage counts towards the 3 attempts. | `pipeline/settle.ts` | Don't count dependency outages |
| RV-S8 | Claude calls that time out or are aborted aren't counted against the budget. | `claude/adapter.ts` | Record an estimate on timeout |
| RV-S9 | Some network calls bypass the circuit breaker (non-negotiable 11): channels, people, earlier, Confluence catalogue, members. A half-open breaker doesn't limit trial calls. | `api/routes.ts`, `api/views.ts`, `start.ts`, `runtime/health` | One wrapper using `health.allowed(dep)` that reports the outcome |
| RV-S10 | The projection never prunes items or actions, so the synchronous snapshot `JSON.stringify` and the views grow without limit. | `store/retention.ts`, shared reducer | An `item.expired` event; drop expired entries |
| RV-S11 | Some writes aren't serialised: settings saves and prompt saves. `ItemFiles.read` can put a stale entry back into the cache. | `config/settingsState.ts`, `api/routes.ts`, `store/items.ts` | A mutex each; skip the cache update when a newer write exists |
| RV-S12 | `labels/*.jsonl` keep raw thread text forever, and `targetHint` text stays in the permanent log. Both conflict with "raw content only in items/". | `store/labels.ts`, `shared/events.ts` | Decide with IN-1 |
| RV-S13 | Eval input drops `before`, `meeting`, `done` and the thread flags, so meeting and invite scores measure something else. | `store/labels.ts` | Store what triage saw |
| RV-S14 | Slack edits and deletions barely reach triage; FR-2.8 only partly holds. | `pipeline/poll.ts`, `sources/slack/adapter.ts` | Re-fetch edited threads; mark deletions |
| RV-S15 | Time edge cases: `londonAt` is wrong above UTC+12 and on DST days elsewhere. Unknown Windows zone names become UTC silently. The reducer depends on the process time zone. | `shared/time.ts`, `calendar/time.ts`, `projection/transitions.ts` | Reuse the two-pass `wallToUtc`; log unknown zones; pass the zone into the reducer |
| RV-S16 | Content edge cases: the calendar window caps at 200 events, silently. `cut()` and `excerpt()` can split emoji. Dutch quote markers aren't cut. "Read:" subjects are dropped as receipts. The token estimate is low for emoji and CJK text. | `calendar/adapter.ts`, `pipeline/truncate.ts`, `outlook/html.ts`, `outlook/normalise.ts` | Each a small fix |
| RV-S17 | A piece that goes quiet between routing and triage is never routed into a topic. | `pipeline/triage.ts`, `pipeline/topics.ts` | Route at triage time |
| RV-S18 | The cockpit baseline counts decisions the reducer rejects as stale. | `cockpit/baseline.ts` | Apply the same staleness check |
| RV-S19 | During shutdown, an SSE reconnect attaches to a closed hub and holds `close()` until the deadline. A failing `source.failed` append in a poll is swallowed. | `api/sse.ts`, `runtime/scheduler.ts` | Refuse when closed; set `onError` |
| RV-S20 | A crash leaves vault temp files behind. An append via rename replaces a symlinked note and resets its mode. | `actions/vaultExecutor.ts`, `store/atomic.ts` | Clean up on startup; write through the link and keep the mode |

### Security hardening (`RV-H`)

| ID | Finding | Where | Suggested fix |
|---|---|---|---|
| RV-H1 | Keychain writes pass the secret in argv, where `ps` can see it. | `config/keychain.ts` | Feed `security -i` on stdin |
| RV-H2 | Confluence Basic auth follows any `siteUrl` and stays cached for the life of the process. | `actions/confluenceApi.ts` | Allow-list `*.atlassian.net`; clear the cached auth when the URL changes |
| RV-H3 | The bearer token in `index.html` can be read by any local process. Browsers are blocked by the Host and Origin checks. | `api/static.ts` | Record as accepted, or restrict to the owning user |
| RV-H4 | Server-supplied URLs go into `href` and `window.open` without a scheme check. | `web: components/item.tsx`, `ItemPanel.tsx`, `TimeColumn.tsx`, `NotificationBell.tsx` | A `safeHref()` allow-list: https, slack, obsidian, msteams |
| RV-H5 | Unverified: Glob brace patterns may slip past the vault read guard and list file names outside the vault. | `claude/readGuard.ts` | Reject braces in patterns |

The 11 Oct checks found no problems in these areas:
- **Authentication:** the bearer compare uses `timingSafeEqual`; Host and Origin are enforced; SSE
  sends the token in a header.
- **Isolation:** only `claude/` imports the Agent SDK; triage calls have no tools.
- **Writes and commands:** atomic writes; `execFile` takes argument arrays; zod validates request
  bodies.
- **XSS:** Slack and email links are limited, Tiptap rejects `javascript:`, and the guide escapes
  its HTML.

### Efficiency (`RV-E`)

| ID | Finding | Where | Suggested fix |
|---|---|---|---|
| RV-E1 | Each `/api/inbox` call rebuilds every row and searches the calendar per row, then hashes and gzips synchronously. Every poll publishes `inbox` three times. | `api/views.ts`, `start.ts` | Cache the serialised inbox and its ETag on `lastSeq` plus the settings and calendar versions; coalesce notices |
| RV-E2 | Every vault draft walks and reads the whole vault. | `actions/vaultCandidates.ts` | Index once and update it; see IN-5 |
| RV-E3 | Startup reads every item file three times. | `start.ts` | One pass |
| RV-E4 | The bell and the week view get slower as history grows. | `api/views.ts` | Bound them by time |
| RV-E5 | Slack history mode reads every member conversation every poll. Users are fetched one by one with `users.info`. | `sources/slack/adapter.ts`, `directory.ts` | Only conversations with activity; warm users from `listPeople` |
| RV-E6 | Outlook's recent-email set lives in memory, so a restart re-reads the overlap with paid relay runs. | `sources/outlook/adapter.ts` | Persist it with the cursor |
| RV-E7 | In the web app, every row runs its own `useNow` interval and re-renders on every inbox notice, with no `React.memo`. The open item refetches on every usage or settings notice. Source history and the Done list aren't virtualised. | `web: Inbox.tsx`, `cockpit/rows.tsx`, `usePanelHost.ts`, `Source.tsx` | One shared clock, memoised rows, narrower topics, virtualisation |

### Web quality and accessibility (`RV-W`)

| ID | Finding | Where | Suggested fix |
|---|---|---|---|
| RV-W1 | Escape closes nested dialogs together. A backdrop click discards rule edits without asking. | `components/ui.tsx` `Dialog`, `Rules.tsx` | A dialog stack; confirm before discarding a changed rule |
| RV-W2 | `Dialog` refocuses its × on every parent render, because its effect depends on an inline `onClose`. There is no focus trap. | `components/ui.tsx` | Keep `onClose` in a ref; add a focus trap |
| RV-W3 | The item panel says "Loading…" forever when the item fails to load. | `hooks/usePanelHost.ts`, `ItemPanel.tsx` | Show the error with Retry |
| RV-W4 | "Done and next" breaks out of a filing batch. | `hooks/usePanelHost.ts` | In batch mode, the footer becomes Approve, Skip and Stop (UX-2) |
| RV-W5 | Requests have no timeout, so buttons can stay busy for ever. | `api/http.ts` | `AbortSignal.timeout(15 s)` |
| RV-W6 | Toasts cap at four and don't pause on hover, so fast triage loses Undo. | `store/toasts.ts`, `Toasts.tsx` | An undo stack on `z` (UX-1); pause on hover |
| RV-W7 | Focus and accessibility: opening the panel focuses the row behind it; menus have no arrow keys; the Full-scope search box blurs as soon as it's focused. | `usePanelHost.ts`, `ui.tsx`, `Inbox.tsx` | Focus the panel heading; roving tabindex; make the box a button |
| RV-W8 | The "Action items for you" checkboxes aren't saved. | `pages/inbox/ItemPanel.tsx` | UX-5, or show them as a plain list |
| RV-W9 | The sidebar Inbox badge counts differently from the lane pills. | `Shell.tsx`, `lib/next.ts` | Use `laneCounts` in both |
| RV-W10 | Small bugs: Copy link always reports success. Custom snooze uses the browser's time zone. The inbox has no Retry when it fails to load. Rule conditions use `key={i}`. Dismissed banners come back. Toasts sit bottom-centre, not bottom-right. Truncation in the time column at 400 px. | various | Each a small fix |
| RV-W11 | Mock drift: the mock's inbox doesn't drop old done items or excluded channels; the mock discards in any state; `replied` and `getEarlier` are stubs. On the server, `fileVaultOff` is hard-coded. | `web/src/mock/server.ts`, `api/views.ts` | Align the mock; read the real FileVault check |
| RV-W12 | Placeholder values shown as data: `outbox`, `rateLimitedToday` and `ruleHits` are always 0. | `api/views.ts` | Compute them or hide them |
| RV-W13 | Some screenshots are stale (`inbox-light.png`, `panel-vault-light.png`). | `app/screenshots/` | Regenerate them |

### Maintainability (`RV-M`)

| ID | Finding | Suggested fix |
|---|---|---|
| RV-M1 | Large files mix responsibilities: `Inbox.tsx` (1,083 lines), `ActionPanel.tsx` (931), `settings/sections.tsx` (1,714), `actions/service.ts` (635), `api/routes.ts` (513), `api/views.ts` (666), `start.ts` (517). | Inbox: `useBatch` and `useInboxKeys` hooks, plus Header, Banners and QueueRow files. ActionPanel: a lookup for its failure banners. Settings: a file per section. Server: split `outbox.ts` and `drafter.ts`; route modules per area; a `wire()` in `start.ts` that builds in dependency order. |
| RV-M2 | Duplication: `runSettle` and `runFinish` (about 80% the same); `isTyping` (six copies); JSONL readers; per-key locks; action sorting; triage zod schemas that duplicate shared ones with different limits; `hhmm` (three copies). | Extract shared helpers |
| RV-M3 | The model id `'haiku-5.5'` is hard-coded in `claude/relay.ts` and `pipeline/topics.ts`. | Read it from the settings model map |
| RV-M4 | Dead code: `net/http.ts` `withDeadline`. `DepId 'wisprDb'` has no implementation behind it (the R2.6 fallback isn't built). | Remove it, or build the fallback |
