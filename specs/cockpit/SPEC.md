# Work OS Cockpit: spec and implementation stages

Owner: Frank Keulers
Status: Draft v0.1, 9 Oct 2026
Design: `specs/cockpit/design/` (Claude Design canvas "Work OS Cockpit", light and dark artboards)
Requirement prefix: **CK-** (cockpit). These amend PLAN.md and DESIGN.md; section 11 lists the amendments.

---

## 1. Summary

Work OS becomes a cockpit that stays open all day on the 16" MacBook Pro, which Frank uses as a second screen. It shows everything at once, so the separate Slack, Outlook and calendar windows can close.

The screen answers three questions without a click, in this order:

1. **Does anything need me right now?** The Now items, and the meeting that's on or next.
2. **What do I have to do before my next meeting?** Today's deadlines, set out on a timeline alongside the meetings.
3. **What can wait?** Items to file, items due later this week, and snoozed items.

The biggest saving isn't the layout. It's that **an item closes by itself once Frank has answered it in Slack or Outlook**, so he doesn't handle it twice.

### What changes, in one list

| # | Change | Stage |
|---|---|---|
| 1 | Group by channel off by default; sort by priority by default | 1 |
| 2 | Rows hold their place; new items carry a New dot | 1 |
| 3 | Glance type sizes for counts, the clock, the next meeting and Needs you summaries | 1 |
| 4 | Triage details (model, prompt version, batch, revision) behind a disclosure in the panel | 1 |
| 5 | A health pill in the top bar, readable from across the desk | 1 |
| 6 | Dark-mode tokens for everything new | 1 |
| 7 | Items close by themselves after Frank replies (Slack, then Outlook) | 2 |
| 8 | Three fixed zones: Time, Needs you, Later | 3 |
| 9 | Time column: clock, next-meeting card, timeline with deadline pins | 3 |
| 10 | Later zone: To file, This week, Snoozed, Low priority | 3 |
| 11 | File in a batch | 4 |
| 12 | Free time and what fits in it | Backlog (B1) |
| 13 | Source views: a sidebar source opens everything it has stored, untriaged, with the item panel | 5 |
| 14 | Related items across sources, filed together and optionally marked done | 6 (specced) |

### What stays

- The **item panel** keeps its slide-over behaviour, its 240/180 ms motion and its one-card Next step. It is open only while Frank is reading an item.
- Lanes, triage, rules, topics, corrections, the eval and filing all work as they do today.
- Keyboard: `j`/`k`, `e`, `E`, `s`, `c`, `o`, `Esc`, `[` and `?` are unchanged.

---

## 2. Goals, success criteria and kill criteria

### Goals

- Frank works through Needs you in a few short passes a day, and it's empty by the end of most working days.
- Most items that need a reply leave the inbox without a click in Work OS.
- No separate calendar window is needed during the working day.

### Success criteria (measured over 2 working weeks after Stage 3 ships)

| # | Criterion | Target | Source |
|---|---|---|---|
| C1 | Share of Needs you exits closed by Frank's reply | ≥ 40% (guess, to reset after Stage 0) | event log |
| C2 | False closes: auto-closes undone, or reopened by Frank within 24 h | ≤ 2% of auto-closes | event log |
| C3 | Needs you empty at 18:00 | ≥ 3 of 5 working days | daily snapshot |
| C4 | Minutes a day with the item panel open | Down on the Stage 0 baseline | client usage events |
| C5 | Missed Now items: Now items done more than 4 h after their deadline | No increase on baseline | event log |

S4 in PLAN.md ("opens the dashboard 4 of 5 days") stops meaning anything once the app is always open. C3 and C4 replace it for the cockpit.

### Kill or rethink criteria

- **C2 above 5% after one round of prompt tuning.** Turn auto-close back to a suggestion ("You replied · Mark done?") rather than a close.
- **C5 gets worse.** The cockpit is hiding things; review the layout before going further.
- **Fewer than 30% of Needs you items carry a deadline after the Stage 3 prompt change.** The time column is then mostly a calendar. Keep the next-meeting card and drop the timeline pins.

---

## 3. Stage 0: baseline (read-only, about half a day)

**Why:** the targets above are guesses. Two numbers decide how much stages 2 and 3 are worth, and both come from the existing event log.

**CK-0.1** `npm run cockpit:baseline` reads `~/WorkOS-data` read-only and writes `logs/cockpit-baseline-<date>.json`, covering the last 14 days. It needs no model calls and no network, and it takes no lock: it only reads the log.

It reports:

1. **Items per day by lane** (now, today, file, else, failed), and how many Needs you items Frank marked done.
2. **Deadline coverage:** the share of Needs you decisions whose `next.dueAt` is set, by source and by need.
3. **Auto-close potential:** of the items Frank marked done, the share where a `fromMeOnly` revision (Frank's own reply) arrived before the Done, and the median gap between the two. This is the ceiling for C1.
4. **Time to done**, by lane: the median and p90 from first appearance to Done.
5. **End-of-day backlog:** Needs you count at 18:00 each working day (C3 baseline).

**Gate to Stage 2:** auto-close potential ≥ 20%. Below that, Stage 2 drops behind Stage 3.
**Gate to Stage 3:** none. A low deadline coverage instead triggers the prompt change in CK-3.9 before the timeline ships.

**First run, 9 Oct 2026.** The dev data directory was the only one with history: there's no `~/WorkOS-data` yet. It covers 6–9 Oct, about three working days, including a clear-out day with 51 Dones.

| Measure | Result |
|---|---|
| Auto-close potential | 5 of 77 Dones on Needs you came after Frank's own reply: **6.5%**, median gap 78 min |
| Deadline coverage | 32 of 134 Needs you decisions set `dueAt`: **23.9%** (Slack 24%, decide 55%, review 41%, reply 33%) |
| Time to done, median | Now 160 min, Today 627 min |
| Needs you at 18:00 | 4 (7 Oct), 17 (8 Oct) |

- **Gate result.** 6.5% is under 20%, so by the gate **Stage 2 moves behind Stage 3**: the order is 1 → 3 → 2 → 4.
- **Treat it as a floor.** Frank's replies only count when a poll fetched them, and Outlook was connected for a day or two.
- **Rerun** the baseline after a full fortnight on the autostarted instance (`WORKOS_INSTANCE=prod npm run cockpit:baseline`) before Stage 2 starts.

---

## 4. Stage 1: quick wins on today's layout (about 1–2 days)

Everything here is UI and preference changes on the current Inbox. There are no schema changes and no change to triage.

**CK-1.1 Group by channel off by default.** `prefs.groupByChannel` defaults to `false`; a preference already saved in the browser is kept. The Sort menu defaults to **Priority** (Now, failed, Today by deadline) instead of Newest first. Both stay in the Sort menu.

**CK-1.2 Rows hold their place.**
- An update to an existing item (a new revision, a re-triage that keeps its lane) never moves its row.
- A new item, or one whose lane changed, is inserted at its sorted position. Rows above the viewport are scroll-anchored, so what Frank is looking at doesn't jump.
- While the item panel is open, the list doesn't re-sort. Pending inserts land when the panel closes, or as each arrives if it is below the viewport.
- An item that lands above the viewport while Frank is scrolled down shows a pill at the top of its group: "1 new Now item above". Clicking it scrolls there.
- A row leaving (Done, Snooze, auto-close) collapses over 200 ms. With reduced motion it disappears at once.

**CK-1.3 New marker.** An item that entered Needs you or Later since Frank last looked carries a blue "New" dot in its meta line. "Looked" means the row was in view while the window had focus for 2 s, or the item was opened. The dot also clears after 30 minutes. The marker is a client preference, like the panel state: it is not stored on the server.

**CK-1.4 Glance type.** New tokens in `tokens.css`, used only where named:

| Token | Size / weight | Used for |
|---|---|---|
| `--text-glance-xl` | 28 / 600 | Clock in the time column |
| `--text-glance-l` | 22 / 600 | Count pills in the top bar |
| `--text-glance-m` | 18 / 600 | Next-meeting title, zone titles |
| `--text-row` | 15 / 500 | Needs you summaries |

Everything else keeps the DESIGN.md scale. Later rows stay 14 / 500.

**CK-1.5 Count pills in the top bar.** "3 now · 6 today · 4 to file", each in its lane colour (orange, blue, teal) at `--text-glance-l`. A click scrolls to the group. They replace no other top-bar item.

**CK-1.6 Triage details behind a disclosure.** In the panel, the line "Triaged 09:33 by model · haiku-5.5 · triage v3 · batch of 3 threads · revision 1" becomes a collapsed row: "› Triage details · model" (or "· rule vip-dm"). Expanded, it shows model, prompt version, batch, revision and time. The state is remembered per browser.

**CK-1.7 Health pill.** The top bar gains one pill on the right, mapped from the existing app health (FR-14.6):

| State | Pill | Top bar |
|---|---|---|
| Running normally | ● green "All sources live · 2 min ago" | plain |
| Catching up after sleep | ● blue "Catching up after sleep" | blue tint |
| A dependency degraded or failing | ● amber, naming it and what's stale: "Outlook not connected · mail and calendar stale", plus the fix as a link | amber tint and amber hairline |
| Safe mode | ● red "Safe mode · nothing is being read", link to Usage & health | red tint and red hairline |
| Stopping | ● grey "Stopping" | plain |

- **New staleness rule:** if any enabled source's last successful poll is older than 2× its current interval (work or off hours), the pill turns amber: "Slack stale · last read 34 min ago". This catches a server that is silently not polling.
- The health banner stays for things Frank must act on. The pill doesn't replace it; it makes the state visible from his seat.
- The sidebar health dot stays.
- Amendment (FR-11.3): the bell is the last thing on the right, after the usage button, on every page. Its count shows only while something needs a follow-up, so the corner stays quiet otherwise.

**CK-1.8 Dark mode for everything new.** Every colour the cockpit adds is a token with a light and a dark value, under `:root[data-theme="dark"]` and `prefers-color-scheme` like the existing ones. The new tokens:

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--green-wash` | `#F0FAF3` | `#13261B` | health pill, "you replied" row, auto-close note |
| `--amber-line` | `#F59E0B` | `#7A5410` | degraded top bar, meeting starting soon |
| `--now-line` | `#F7DCC8` | `#3A2418` | hairline between Now rows |
| `--later-bg` | `#FCFCFD` | `#171A20` | Later zone ground |
| `--past` | `#FAFAFB` | `#16191F` | the elapsed part of the timeline |
| `--selection` | `rgba(29,78,216,.08)` | `rgba(138,168,255,.12)` | selected row wash |
| `--health-blue-bar` | `#EFF6FF` | `#172033` | catching-up top bar |
| `--health-amber-pill` | `#FEF3C7` | `#3A2C10` | degraded pill |
| `--health-red-pill` | `#FCE4E4` | `#3A1A1A` | safe-mode pill |

Everything else reuses existing tokens (`--orange-wash`, `--orange-wash-2`, `--accent-wash`, `--teal-wash`, `--tray`, `--line-*`, `--scrim`). The design's dark artboards are the reference. The source marks (Slack, Outlook, Teams, Wispr Flow) stay `BrandIcon.tsx`'s real marks in both themes; the design's lettered squares are placeholders.

**CK-1.9 Guide.** Update `inbox.md` (sort default, New dot, health pill) and `shortcuts.md` if anything changed.

> **Story 1.1** As Frank, I want the inbox to stay still while I read it so that I don't lose my place when new items arrive.
>
> - Given I'm reading row 5 with the panel open, when a new Now item arrives, then no row moves and a "1 new Now item above" pill appears.
> - Given the panel closes, when pending inserts exist, then they land at their sorted positions and rows in view stay where they are.
> - Given a new item has been in view for 2 s with the window focused, then its New dot clears.

> **Story 1.2** As Frank, I want to see from my seat whether Work OS is healthy so that I never rely on a stale inbox.
>
> - Given Slack's last successful poll was 25 minutes ago in work hours (interval 10), when the pill updates, then it reads "Slack stale · last read 25 min ago" in amber and the top bar is tinted.
> - Given Outlook's connector needs auth, then the pill names Outlook and links to "Reconnect on claude.ai".

**Journeys** (add to JOURNEYS.md): J50 Still list (an SSE insert with the panel open), J51 Health from across the desk (each health state from the scenarios drawer, in light and dark).

---

## 5. Stage 2: items close by themselves after you reply (about 3–4 days)

### 5.1 How it works today

When a new revision's messages are all Frank's own (`fromMeOnly`), the projection skips re-triage (§5.3), and the item stays where it was until Frank presses Done. Invites already close themselves through `result.resolved` (R2.8).

### 5.2 The new behaviour

**CK-2.1 Trigger.** An **open** item in Needs you or Later › This week (not To file, Low priority or Snoozed) gets a `fromMeOnly` revision. Frank's message must be **after the latest message from someone else**. Matching:
- **Slack:** a reply in the same thread, or a message in the same DM window, by Frank's user ID (`directory.identity`).
- **Slack, amended (topics):** a piece made only of Frank's messages, such as a channel post or a reply in another thread, that routing places in the topic. `topic.routed` carries `fromMeOnly`, and the join waits for a settle check instead of re-triaging the topic, as Frank's messages on a part already did.
- **Outlook:** a Sent Items email in the same `conversationId`, from Frank's address (`get_me`).

**CK-2.2 Settle check.** The item goes to a **settle check**: a Haiku call, separate from triage, that decides whether Frank's message settles the open asks.
- **Input:** the thread as triage sees it (Frank as "me"), the item's open asks (`next.asks`, or `next` alone), and Frank's latest message marked as such.
- **Output** (zod, `SettleDecision`): `{ itemId, itemRevision, asks: [{ index, settled: boolean, why: string }], allSettled: boolean, handedOn?: boolean }`. `handedOn` (prompt `settle v2`, PLAN FR-8.1 amended 11 Oct 2026): the reply hands what is open on to someone else while Frank still owns the outcome; the item moves to Waiting on others instead of staying in Needs you.
- **No quiet window:** Frank's message ends his turn, so the check runs right after the poll that brought it in.
- **Batched:** one call per poll, at most 20 items (§5.3 batching rules apply). It has its own purpose in the usage log, `settle`, and counts towards the daily budget.
- **No tools, no MCP, no preset prompt** (CL-4). The prompt is `config/prompts/settle.md`, versioned like the others (FR-1.7).
- The deterministic option (closing reply-need items with no model call) was rejected. "Will look later" or a 👀 would close the item wrongly, and a wrong close is a missed item. The check costs about $0.001 per batch, a guess based on triage costs.

**CK-2.3 Outcomes.**
- **All asks settled:** append `item.done { by: 'reply', source, messageId, check: <batchId> }`. The item leaves Needs you (CK-2.5).
- **Some settled:** tick those asks off (`ask.settled` per ask, which the panel shows as ticked). The item stays, and its next step becomes the first open ask.
- **None settled:** the item stays. The panel shows "You replied · still open: <why>".
- **Check failed** (Claude down, budget paused): the item stays as it is, and the check retries on the next poll, with at most 3 attempts. Nothing closes on a failure.

**CK-2.4 Targeted check after "Reply in …".** When Frank uses the panel's "Reply in Slack" or "Reply in Outlook", the server schedules a refresh of that one item at +2 min and +6 min:
- **Slack:** one `conversations.replies` call for a thread, or `conversations.history` for the DM window.
- **Outlook:** one relay `outlook_email_search` on Sent Items since the click.
- Each goes through its dependency's breaker (FR-14.3). Nothing is scheduled while the source is paused or its breaker is open.
- The normal poll still catches replies Frank makes without the button.

**CK-2.5 What Frank sees.**
- **The row:** for 5 s it shows "✓ You replied 1 min ago", with the summary struck through and a green wash, then it collapses (CK-1.2). Nothing else moves until it has gone.
- **A toast:** "Closed: you replied in Slack", with the item's summary and **Undo** (DESIGN.md principle 8).
- **The Needs you footer:** "N closed by your replies today · latest <time>: <title>", with a Review link that opens Done filtered to auto-closes.
- **The Done list** labels each item: "Your reply in Slack", "Your reply in Outlook", "Answered in Outlook" (invites, existing), or "Done by you".
- **The panel:** under the primary Reply action, "Closes by itself when you reply in the thread." For Decide, Approve or Review items: "Closes when your reply settles it."

**CK-2.6 Undo and reopening.**
- **Undo** (the toast, or Reopen from Done) appends `item.reopened` and a negative label line in `labels/settle.jsonl` (the thread as the model saw it, the asks, the decision). The eval then measures the settle prompt against those labels, as FR-6.1 does for triage.
- **A manual Done** within 30 min of a `fromMeOnly` revision whose check said "not settled" writes a positive label: the check missed it.
- **A manual Done that no check saw** (amended) writes a positive label too, origin `manual_done_unchecked`. It applies when the item still waits on Frank, he wrote on it since its triage (a newer revision, or a piece of his own joined the topic), and no check ran on that revision: the check was off for the source, failed, or never got the reply. The check is built at Done, as it would have gone to the model, so the settle eval can score it; there is no model answer to keep. A Done with nothing written since triage is not labelled. `npm run eval -- --purpose settle` reports right answers by origin as well as by source.
- **A new message from someone else** after an auto-close re-triages the item as today (JOURNEYS open question 1 default: it comes back with "New replies").

**CK-2.7 Settings.** Settings › Inbox › Triage rules gains "Close items when your reply settles them", with **On** as the default, and a per-source list (Slack, Outlook). Off means the check still runs and shows "You replied · Mark done?" on the row, but nothing closes.

**CK-2.8 Measurement.** Usage & health gains C1 and C2 next to S1–S7, from the event log.

**CK-2.9 Order:** Slack first. Outlook follows once 20 Slack auto-closes have run with no Undo, or after one week, whichever comes later.

**CK-2.10 Looks finished** (amendment). A topic can run its course without Frank writing anything: someone else does it, the ask is withdrawn, or the question is answered.
- **Trigger.** An open item that was Now or Today is re-triaged after messages from others, and the model's own answer is None (before any rule floor, so a mention-me item the floor holds in Today still qualifies). Nothing is suggested for filing, and Settings › Triage rules › "When others settle it" is on for the source: Slack on, Outlook off by default.
- **Check.** A finish check (Haiku, prompt `finish v1`, now `v2`, which treats a hand-on that leaves Frank owning the outcome as not settled; separate from settle) judges the asks open before re-triage against the messages since, by anyone. An ask the model leaves out counts as not settled. The answer goes in the item file and as `finish.checked`; a failure is `finish.failed` and shows nothing.
- **What Frank sees.** When every ask is settled, the row says **Looks finished · <why>** in place, where "You replied" would be; nothing moves or closes. The panel opens with a green **Looks finished** callout: the why, **Done** and **Not finished**. A new message from someone else, a correction or Done clears it.
- **Labels.** Done on a suggested item writes a positive line to `labels/finish.jsonl` (origin `finish_accepted`); **Not finished** writes a negative one (`finish_rejected`) and corrects the item to Today. `npm run eval -- --purpose finish` scores the finish prompt against them, as settle is scored. Closing by itself (`auto`) waits for at least 30 labels and a false-close rate at or below the C2 target.

> **Story 2.1** As Frank, I want a thread to leave my inbox once I've answered it in Slack so that I don't have to come back and press Done.
>
> - Given Matt's DM asks for a go/no-go and I reply "Go, for the 15th" in the DM, when the next poll runs, then the settle check marks the ask settled, the item closes with "Closed: you replied in Slack", and the Done list shows "Your reply in Slack".
> - Given I reply "I'll look after lunch", when the check runs, then the item stays and the panel shows "You replied · still open".
> - Given an item auto-closed, when I press Undo, then it returns to its lane and `labels/settle.jsonl` gains one negative line.
> - Given Claude is unavailable, when the check fails, then nothing closes and the check retries on the next poll.

> **Story 2.2** As Frank, I want the close to happen quickly when I reply from the panel so that the cockpit is current by the time I look back.
>
> - Given I click "Reply in Slack" and reply within a minute, then the item closes within 2–3 minutes, not at the next 10-minute poll.

**Events (new or changed):**
- `item.done` data gains the variant `{ by: 'reply', source: SourceId, messageId: string, check: string }`. The existing `{ by: 'source', reason }` and `undefined` (Frank) stay.
- `settle.checked { revision, batchId, allSettled, settled: number[] }`. No free text, as for `triage.decided` (events never hold message bodies).
- `ask.settled { index, by: 'reply' | 'user' }`.
- `settle.failed { revision, attempts, reason }`.

**Tests:** recorded settle fixtures validated against `SettleDecision` (no live calls, non-negotiable 10); projection tests for every outcome; a crash test between `settle.checked` and `item.done`. An eval suite (`npm run eval -- --purpose settle`) runs over `labels/settle.jsonl` once it holds 30 lines.

**Journeys:** J52 Reply closes it (Slack), J53 Reply doesn't settle it (Decide), J54 Undo an auto-close, J55 Outlook reply closes it.

**As built (9 Oct, Slack):**
- `settle.checked` carries `settled: askId[]` (strings), and `ask.settled` is the existing `topic.askDone { askId, by: 'reply' }` (§13).
- The check runs straight after triage in the same runtime pass, at most 20 items per call within `maxThreadsPerCall`; the per-ask `why` and the input go to the item file, not the event.
- The +2/+6 min reads are Slack only (`POST /api/items/:id/replied`). Outlook, once turned on, is checked at the next mail poll; the Sent Items targeted check is not built.
- The settle eval is CLI only (`npm run eval -- --purpose settle`); Usage shows C1/C2, not the eval.
- An item that a reply closes from Later › This week gets the toast but isn't held as a "You replied" row; only Needs you rows are.
- C1 counts exits from This week as Needs you exits.
- J55 (Outlook) waits for the CK-2.9 gate.

---

## 6. Stage 3: the three-zone cockpit (about 4–6 days)

The layout matches artboards 1 and 2 of the design: `Main.dc.html` and `Panel.dc.html`, with their dark versions.

### 6.1 Layout

**CK-3.1 Zones.** At a viewport width of 1600 px or more, the Inbox is three fixed columns under the 64 px top bar:

| Zone | Width | Scrolls |
|---|---|---|
| Time | 400 px | its timeline only, if the day doesn't fit |
| Needs you | flexible (≈ 800 px on the MacBook Pro at default scaling) | its own list |
| Later | 440 px | its own list |

- The sidebar defaults to the 60 px rail on this layout. The `[` key still toggles it, and the choice is kept.
- **Narrower windows:** between 1280 and 1599 px, Later folds into the footer row of today's design (Low priority, This week, Snoozed, Done as links). Below 1280 px, the time column becomes today's agenda strip. That lower layout is the current design, so nothing is lost on a small window.

**CK-3.2 The panel** slides over from the right as today, 640 px wide, below the top bar, covering Later and part of Needs you. The scrim covers the visible zones. The selected row keeps its accent wash and 3 px bar. A click on a row in any zone switches the item.

**CK-3.3 Keyboard.** `j`/`k` walk Now → Today → To file → This week, then any open footer list (Snoozed, Low priority, Done). New: `g n` goes to the first Needs you item, `g l` to the first Later item, and `t` toggles Today/Tomorrow in the time column. Update `shortcuts.md`.

### 6.2 Time column

**CK-3.4 Header:** the clock (`--text-glance-xl`, tabular figures), the date, and a Today / Tomorrow switch. 56 px, the height of the Needs you and Later headers, so the three end on one line. A button folds the column to a 56 px rail with the clock (the sidebar's Now/Next cues return while it's folded, CK-3.7), and its right edge drags it between 360 and 600 px, 400 by default. Later's left edge drags the same way, 360 to 600 px, 440 by default. These are kept in client prefs.

**CK-3.5 Next-meeting card.**
- **Which meeting:** the first timed meeting today that Frank accepted, accepted tentatively or organised, isn't shown as Free, and hasn't ended. These are the same rules as the R2.8 sidebar cues, which move here.
- **What it shows:**
  - "NEXT · IN 12 MIN" (amber in the last 2 minutes, from `meetingLeadMinutes`), or "NOW · UNTIL 14:30" while it's on;
  - the time and title;
  - **"Due before it:"** the Needs you items whose `next.dueAt` falls on or before the meeting's start, or "Nothing due before it".
- Clicking the card opens the event in Outlook. Overlapping meetings show "+1 at the same time", and a hover lists them.
- With no meeting left today, the card reads "No more meetings today" and shows the first meeting tomorrow.
- With the calendar off, the card is hidden and the timeline shows pins only.

**CK-3.6 Timeline.**
- **Range:** Frank's work hours from Settings › Schedule (default 08:00–18:00), widened to include the first and last meeting or pin. The scale is 72 px an hour; below 48 px an hour the column scrolls instead of shrinking further.
- **Meetings:** a block per timed meeting, in its column, with a 3 px bar in its Outlook category colour (R2.8 `categoryColors`). Past meetings are greyed (`--tray`, `--faint`). All-day events are a single line at the top. A click opens the event in Outlook.
- **The now-line:** a red 2 px line with the time in a tab. Everything above it is on `--past`. It moves every minute.
- **Deadline pins:** a pin for each Needs you item with `next.dueAt` today, in a lane to the right of the meetings, with its due time and a short title (≤ 28 characters, from `step` or the summary). Colours follow the chip rule:
  - orange within about 4 h;
  - blue later today;
  - red when overdue, pinned at the now-line and labelled "Overdue".
- Pins within 30 minutes of each other stack into one: "2 due 17:30", and a hover lists them. A click opens the item in the panel.
- **Tomorrow:** shows tomorrow's agenda and pins for This week items due tomorrow.

**CK-3.7 The sidebar Now/Next cues** (R2.8) are hidden while the time column is on screen. They return in the narrow layouts.

### 6.3 Needs you zone

**CK-3.8** Needs you holds Now (with the orange wash) and Today, sorted by priority. Failed triage sits at the top of Today with its red chip.
- **Rows are two lines:** the source mark, where, kind and age, the New dot, then the need and due chips on the right; below that, the summary at `--text-row`, on one line with an ellipsis.
- **Group headers:** "NOW · 3" and "TODAY · 6".
- **The footer** carries the auto-close line from CK-2.5.

**CK-3.9 Deadlines in triage.**
- Triage prompt v6 asks for `next.dueAt` whenever a time is stated or implied:
  - "by end of day" is 17:30 local;
  - "this week" is Friday 17:00;
  - "before the exec sync" is the matching meeting's start, when the calendar has it.
- `dueLabel` stays for display.
- Eval gate: S1 and S2 must not fall. Stage 0's deadline coverage is the baseline to beat.

### 6.4 Later zone

**CK-3.10 Lane rule for This week.** This is a view rule in `packages/shared/src/lanes.ts`, with no new attention level:
- An item with effective attention `today` whose `next.dueAt` is after the end of the local day (Europe/London, as R2.8) goes to **Later › This week**, not Needs you.
- Decisions from before v6 with no `dueAt` and a `dueLabel` matching `this week|next week|by friday` (case-insensitive) go there too.
- At midnight, items now due today move into Needs you. That's the only time rows move between zones without an event.
- A correction to Now always wins and puts the item back in Needs you.
- The eval is unaffected: attention labels don't change.
- *Considered and not chosen:* a new `week` attention level. It would change the labelled set and S1. Revisit if the view rule misplaces items often.

**CK-3.11 Later holds, top to bottom:**
0. **Waiting on others** (grey; PLAN FR-8.1, amended 11 Oct 2026), only when it holds something: summary, where and age, and "you handed it on" when Frank's reply did. `g l` lands on its first row.
1. **To file** (teal): one-line summary, source and age, and the target chip. **File in a batch** sits in its header (Stage 4; hidden until then).
2. **This week:** summary, where, need chip and due chip.
3. **Snoozed:** one link row, "2 snoozed · next back 15:00", which opens its list in the zone.
4. **At the foot:** "14 low priority · check triage" as an outlined button, and "12 done today" as a muted link. Each opens its list in the Later zone, one at a time, with `Esc` returning to the default view.

The header reads "Later 9 · Once a day".

**CK-3.12 Guide.** Rewrite `inbox.md` for the three zones, update `outlook.md` (the agenda strip becomes the time column; the strip remains in narrow windows), and add a section on keeping the cockpit open: full screen, display sleep in work hours, Safari's Add to Dock for a window without browser chrome. That last one is from memory of macOS 14 or later, so check it at build time.

> **Story 3.1** As Frank, I want to see what's due before my next meeting so that I can clear it in the gap.
>
> - Given it's 13:48, a renewal call at 14:00 and Matt's go/no-go due at 14:00, then the next-meeting card reads "NEXT · IN 12 MIN" and "Due before it: Matt M. · MVI V2 go/no-go".
> - Given a deadline passes with the item still open, then its pin turns red, says "Overdue" and sits at the now-line.

> **Story 3.2** As Frank, I want things due later this week out of my way today so that Needs you is only today's work.
>
> - Given Head of Sales asks for a walkthrough "this week", when triage sets `dueAt` to Friday 17:00, then the item is in Later › This week, not Needs you.
> - Given it's Friday morning, then the same item has moved to Needs you.

**Journeys:** J56 Cockpit at a glance (light and dark), J57 Due before the meeting, J58 This week rolls into today, J59 Narrow window fallback.

---

## 7. Stage 4: file in a batch (about 2–3 days)

**CK-4.1** "File in a batch" in the To file header opens the panel on the first To file item in filing mode, with its suggested draft started. It shows "Filing 1 of 4" in the panel header.

**CK-4.2** Drafts are prepared one item ahead: while Frank reviews item n, item n + 1's suggested draft runs in the background. Only one draft is ahead at a time, so a stopped batch wastes at most one draft. The drafts use the existing draft calls (E8, E9) and purposes.

**CK-4.3**
- **Approve** writes (with dry-run as set) and moves to the next item. **Skip** (`→`) leaves the item in To file and moves on. **Discard** works as today.
- At the end, the panel shows "4 filed · 1 skipped" and closes on `Esc`.

**CK-4.4** An item filed in a batch is marked done once all its suggested targets are written. This answers JOURNEYS open question 5 for the batch path only; single filing keeps today's behaviour until Frank decides.

> **Story 4.1** As Frank, I want to file the day's items in one sitting so that filing takes minutes, not a context switch per item.
>
> - Given 4 To file items, when I choose File in a batch and approve each, then each is written, marked done, and the next draft is ready when I get to it.
> - Given I press Esc after item 2, then items 3 and 4 stay in To file, and at most one extra draft was made.

**As built (9 Oct):**
- `action.approved` carries `{ markDoneWhenFiled: true }` from a batch; the outbox appends `item.done` (Frank's, "Done by you") with the `action.executed` that completes the item's suggested filings, in one append. A failed or refused write leaves the item in To file.
- An item that suggests both targets stays open in the batch for the second after the first is approved; "N filed" counts items, by approval.
- The batch takes the To file rows as they show when it starts. Esc, or opening another item, ends it. Skip is a header button and `→`.
- No artboard covers filing mode; DESIGN.md records the build. Journeys J60 and J61.

---

## 8. Stage 5: source views (about 2–3 days)

The Inbox shows a triaged slice: topic parts fold into their anchor, done items drop out after 7 days, excluded channels are left out, and lanes put most items behind Later. That's right for deciding what to do next, and wrong for looking something up. Stage 5 gives each source a view of its own history that triage doesn't shape. Meeting notes are the first use: "what did we say in last week's pricing call?"

**CK-5.1 Every stored item, unranked.** `GET /api/sources/:source/items` returns every item stored for the source, newest activity first:
- done items of any age;
- items from a Slack channel excluded after they were fetched, flagged `excluded`;
- items whose text retention has removed, flagged `expired` (metadata and link only);
- a topic's parts stay inside the topic, as in the Inbox, because its panel shows every piece.

Each row carries its people (Frank left out) and message count as well as the usual summary.

**CK-5.2 The same panel.** A row opens the Inbox's item panel beside the list, with the URL holding the item and the filing target (`/source/slack?item=…&file=vault`). Everything works as in the Inbox: Next step, Reply in…, File it with Confluence and the vault, Done, Snooze, Correct triage and `j`/`k`/`Esc`/`o`. Each row says where triage put the item (its lane, Done and by whom, Filed · Confluence or Vault, Excluded channel, text expired), so nothing is hidden but the state stays visible.

**CK-5.3 Slack** groups items by conversation (channel or DM). The conversation with the newest message comes first, and its items are newest first.

**CK-5.4 Outlook** is a mail list grouped by day (Today, Yesterday, then the date), newest first. Each row shows the people, the subject in bold and a one-line summary.

**CK-5.5 Wispr Flow** lists meeting notes grouped by week (This week, Last week, Week of …), newest first.

**CK-5.6 Outlook Calendar** is a week, Monday to Sunday, London time, with work hours widened to fit the meetings, an all-day row and a now-line. Previous week, next week and This week move it.
- Cancelled and declined meetings show, struck through and marked.
- A meeting opens its Wispr Flow notes in the panel; failing that, its invite item, whatever its state; failing that, a read-only card (time, organiser, invitees, your answer, categories, Open in Outlook).
- The calendar snapshot now starts at this week's Monday (or yesterday, on a Monday), so the days already gone this week show. Past meetings are never read. Weeks outside the snapshot say so.

**CK-5.8 Filter by state.** A row of chips under the top bar shows or hides each state, with its count: Needs you (Now, Today and failed triage), This week, Waiting on others, To file, Low priority, Waiting, Snoozed and Done. On the calendar the states are Going, Not answered, Declined and Cancelled. Done is hidden to begin with, as finished work is rarely what Frank comes looking for; every other state shows, and on the calendar all four do. One click on **Done** brings done items back. Once Frank changes the filter, his choice is kept per source in this browser. The header says "15 of 33 items" while anything is hidden, and **Show all** brings everything back. Hiding the open item's state leaves its panel open; `j`/`k` walk only the rows shown.

**CK-5.7 The sidebar.** A source in the sidebar opens its history at `/source/:id`. Its dot and label still show health; health itself is on Usage & health and one click away from the history's header ("Health ›").

> **Story 5.1** As Frank, I want to see everything a source has brought in, whatever triage made of it, so that I can find last week's meeting notes or a thread I marked done without searching Slack.
>
> - Given a thread I marked done ten days ago, when I open Slack in the sidebar and show Done, then it's there under its channel, marked Done by you.
> - Given a Wispr Flow meeting from last week, when I open it from Wispr Flow's history, then I can file it to the vault from the panel.
> - Given Thursday's 1:1 with no notes, when I click it in the calendar week, then a card shows who was invited and opens it in Outlook.

**Journeys:** J63, J64.

**As built (9 Oct):**
- `GET /api/sources/:source/items` (`sourceView`) and `GET /api/calendar/week?start=YYYY-MM-DD` (`weekView`) in `apps/server/src/api/views.ts`; the mock implements both.
- The panel's host (the URL state, the item query, the unsaved-edit guard, the click outside and the slide-out) moved out of `Inbox.tsx` into `usePanelHost` and `PanelSlide`, which the Inbox and `pages/Source.tsx` share.
- The calendar week reuses the time column's meeting layout (`placeMeetings`) and its past shading.
- The state filter (CK-5.8) keeps its choice in the browser's prefs (`sourceHidden`), like the Inbox's sort; `pages/source/filters.ts` maps lanes and answers to states.
- The mock seed adds the rest of the seed week to the calendar (including a cancelled and a declined meeting) for the week view only; the agenda is unchanged.

---

## 9. Stage 6: related items, filed together (specced, not built)

Notes about one subject arrive from several sources: a Slack thread, a reply by email, the meeting's Wispr Flow notes and its invite. Today each is filed on its own, which gives three short vault notes where one would do, and leaves the other items open.

**CK-6.1 Find related.** The item panel gets a **Related** section with a **Find related** button. It lists items from every source that are about the same thing, each with a one-line reason ("Same meeting", "Dana's reply to this thread"). A row opens that item.
- **Candidates (no model call).** Items from all sources within ±7 days of the open item, scored on:
  - shared people, using the name merge that `GET /api/people` already does;
  - title and summary words in common, using `words()` in `sources/calendar/match.ts`;
  - time, weighted as the Wispr ↔ calendar matcher weights it;
  - links already known: a meeting's notes and invite, a topic's parts.
- **Ranking (Haiku, on demand).** The top 15 candidates go to a new `related` purpose, which keeps the related ones and says why for each. The answer is cached per item revision and counted against the triage budget. Nothing runs until Frank presses the button.

**CK-6.2 File together.** Frank ticks related items and chooses **File together**. One action covers them all (`action.requested` gains `itemIds`). The vault and Confluence drafters read every item's text and write one entry that cites each source. Review, edit, approve and dry-run work as for a single item.

**CK-6.3 Mark all done.** Approving a joint filing offers **Mark all N done**. With it ticked, `item.done` for every included item goes in the same append as `action.executed`, as `markDoneWhenFiled` does for a batch (CK-4.4). Undo reopens them all.

**CK-6.4 From a source view.** Find related works the same from a source's history, so a past meeting's notes can be gathered with the threads around it after the fact.

> **Story 6.1** As Frank, I want to file a meeting's notes, the Slack thread before it and the email after it as one vault note, and close all three, so that the decision lives in one place and nothing is left open.
>
> - Given the pricing workshop's notes, when I press Find related, then the #pricing thread and the Head of Sales's email are listed, each with why.
> - Given I tick both and choose File together, then one draft cites all three; approving it with Mark all 3 done closes all three.

**Open questions:**
1. People in different sources don't share IDs: Slack has `U…` IDs, Outlook has addresses, Wispr Flow has names. Name matching is weak. Is a small people map in Settings worth it?
2. Should Related also search the vault and Confluence (read-only) for notes already filed on the subject, so the joint note appends rather than duplicates?
3. Does a joint filing replace each item's own suggested filing, or sit beside it?

---

## 10. Backlog (recorded, not in the first pass)

**B1 Free time and what fits** (the "Free 90 min · 3 items fit" block in the first design, taken out of this pass).
- **Free gaps:** the time column marks gaps of 30 minutes or more between meetings in work hours as dashed "Free 90 min" blocks. This part needs only the calendar snapshot.
- **What fits:** each gap says how many open items fit, by deadline order. This needs an effort estimate per ask: `next.effortMinutes` (or S/M/L) from triage, plus an eval of how good the estimates are against how long items actually stay open in the panel.
- **Optional:** "Plan this gap", which snoozes the rest until the gap ends.
- **Prerequisites:** Stage 3 shipped, and C4 data to check estimates against.
- **Risk:** estimates that are wrong are worse than none, because they invite overcommitting a gap.

**B2 Slack reaction as a close signal.** A ✅ reaction from Frank on the ask message settles it. It needs `reactions:read` and a fetch path for reactions. Search results may not include them; this is a guess to check in a spike.

**B3 Idle dimming.** After 10 minutes without input, the cockpit dims everything but the time column and the Now group, and wakes on a new Now item or on input.

**B4 Teams chats** join auto-close once the Teams source exists (Phase 2).

---

## 11. Amendments to PLAN.md and DESIGN.md

Apply these in the commit that ships each stage.

| Where | Change | Stage |
|---|---|---|
| PLAN §2 | Add C1–C5 for the cockpit; note that S4 is superseded by C3/C4 once Stage 3 ships | 2–3 |
| PLAN §5.1 model map | Add the `settle` purpose (Haiku) | 2 |
| PLAN §5.3 | "Frank's own messages don't re-triage" becomes "…don't re-triage; an open item in Needs you or This week gets a settle check (CK-2.2)" | 2 |
| PLAN FR-8.1 | Default sort Priority, Group by channel off; Later › This week view rule (CK-3.10) | 1, 3 |
| PLAN FR-8.3 | Done list attribution; auto-close via `item.done { by: 'reply' }` | 2 |
| PLAN R2.5 / Outlook adapter comment | "Sent Items is context only; lanes don't move on their own" becomes "…except a reply that settles an item's asks (CK-2.1)" | 2 |
| PLAN R2.8 | Sidebar Now/Next cues hidden while the time column shows (CK-3.7) | 3 |
| PLAN §4.3 | New files: `labels/settle.jsonl`, `config/prompts/settle.md` | 2 |
| PLAN events | `item.done` reply variant, `settle.checked`, `settle.failed`, `ask.settled` | 2 |
| DESIGN.md Inbox | Replace with the three-zone layout; keep the item panel and action panel sections | 3 |
| DESIGN.md principles | Add the glance type tokens to the type scale table, scoped to the cockpit | 1 |
| JOURNEYS.md | J50–J59; resolve open question 5 for batch filing | 1–4 |
| DESIGN.md Sidebar | A source row opens its history; health is on Usage & health and the history's header (CK-5.7) | 5 |
| DESIGN.md | New "Source views" section | 5 |
| PLAN R2.8 | The calendar snapshot runs from this week's Monday, not yesterday (CK-5.6) | 5 |
| JOURNEYS.md | J63, J64 | 5 |

---

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A wrong auto-close hides something Frank still owes | Medium | High | Model settle check rather than a rule; Undo; labels and eval; C2 kill criterion; Done list attribution |
| Settle checks add Claude usage | Low | Low | Batched, one call a poll, only for items Frank replied to; budgeted as `settle` |
| Few items carry deadlines, so the time column is empty | Medium | Medium | Stage 0 measures it; prompt v6; fallback is the next-meeting card alone |
| Layout too dense at default scaling on the 16" screen | Low | Medium | Fixed widths tuned for 1728 px; narrow-window fallback; glance tokens only where named |
| The screen sleeps or the window is covered, so the cockpit isn't seen | Medium | Medium | Guide section on display sleep and Add to Dock; notifications for Now are unchanged |
| Rows reshuffling under Frank's cursor | Low | Medium | CK-1.2 scroll anchoring and frozen order while the panel is open |

---

## 13. Open questions for Frank

1. **C1 target.** Keep 40%, or set it once Stage 0 reports auto-close potential?
2. **Settle check for reply-need items.** The model check is the default (CK-2.2). Would you accept a no-model close for plain reply items once C2 has stayed under 1% for two weeks?
3. ~~**End of day.**~~ Decided 9 Oct: 17:30, fixed. It doesn't follow Settings › Schedule.
4. ~~**This week window.**~~ Decided 9 Oct: This week stops at Friday 17:00. Assumption to confirm: a Today item due after this Friday also sits in Later › This week, sorted last, with its date on the chip.

### Decided 9 Oct

- **Deadline colours follow time, not lane.** Orange within about 4 h, blue later today, red when overdue, for chips and pins alike. The artboards colour by lane; the build follows this rule instead.
- **Sequencing.** The cockpit is built on the `cockpit` branch off `outlook-source`. Muninn (MUNINN-IDENTITY.md) follows on top of it.
- **Triage prompt.** The current prompt is already v6 (invites), so CK-3.9's deadline change ships as **v7**.
- **Ask identity.** Asks are identified by the existing `askId` (a hash of the step), not an index. `ask.settled` is the existing `topic.askDone { askId }` event with an optional `by: 'user' | 'reply'`.
