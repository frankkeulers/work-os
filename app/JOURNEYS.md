# Work OS prototype: UX test journeys

This is the script for the UX round on the frontend prototype. It runs on mock data in the browser with no backend, so nothing is read from Slack and nothing is written to the vault or to Confluence.

## How to run it

```sh
cd app
npm install
npm run dev        # http://127.0.0.1:5173
npm run e2e        # Playwright against a production build on http://127.0.0.1:4391
```

- **Scenarios drawer.** Open it with the button at the bottom left or the `` ` `` key. Every journey below has a **Start** link in the drawer. The link resets the demo data, sets up the scenario, opens the right page and closes the drawer. Press `` ` `` to reopen it.
- **Mock clock.** The clock starts at **Mon 5 Oct 2026, 09:45 (London)** and runs in real time. The drawer moves it forward.
- **State.** State survives a reload. **Reset demo data** in the drawer starts again.
- **Event log.** The drawer's Event log tab shows the events each action emits. Check them against PLAN.md §4.4.

For each journey, write what you notice in the **Notes** column: confusion, missing information, too many clicks, wrong wording.

## Journeys

### Inbox basics

| ID | Journey | Steps | Watch for | FR | Notes |
|---|---|---|---|---|---|
| J01 | Morning scan | Open the Inbox. The item panel opens on the first item. Scan Needs you and To file, then click a few rows. Open Low priority from the footer. | Do the need tag and deadline on each row tell you what to do before you open it? Is the panel's Next step the obvious next step? | FR-3.1, FR-8.1 | |
| J02 | Done and Undo | In the panel, click Done. Click Undo in the toast. Then try Done and next. | Does the row leave cleanly? Is it clear the panel still shows the done item until you move on? | FR-8.2, FR-8.3 | |
| J03 | Snooze and return | Use the Next step's suggested snooze (for #mvi-launch it's "Snooze until 11:30"). Then Snooze → 1 hour on a Today item. Open the Snoozed group. In the drawer, add 1 h. | Is the suggested snooze time right? Does the item come back, marked "Back from snooze"? | FR-8.3 | |
| J04 | Correct triage in the panel | Open Low priority from the footer, select a row, click Correct triage, set Today and save. Then on a To file item clear Confluence. | Does the item move straight away? Is the labelled-set toast clear? Check `triage.corrected` in the log. | FR-6.2 | |
| J05 | Correct triage in detail | Open the Labs graduation item. Click Correct triage and change the attention. | Does the triage band recolour and its headline change? | FR-6.2 | |
| J06 | Keyboard triage | On the Inbox, use `j`/`k` to move the panel, `e` for Done, `⇧E` for Done and next, `s` for Snooze, `c` for Correct triage, `o` to open the full page, `Esc` to close the panel. | Are the shortcuts worth having? After Done, does `j` carry on from where you were? | (new) | |
| J40 | Outlook and Teams (P2) | Switch Scope to Full. The [Customer] email (Outlook) joins the top of Needs you, the readiness review (Teams) joins further down and the roadmap review (Teams) joins To file. Open each. | Are the source marks recognisable at a glance? Do "Reply in Outlook" and "Open transcript in Teams" read right? Are the meeting's action items useful as checkboxes? | P2 | |

### Filing to the vault

| ID | Journey | Steps | Watch for | FR | Notes |
|---|---|---|---|---|---|
| J07 | New vault note | Open the Claude Code how-to item (File). Click Draft vault note. Wait for the draft and read it. Approve. | Is the drafting progress reassuring? Can you judge the path and frontmatter at a glance? | FR-9.1–9.3 | |
| J08 | Append with edit | Open the Meridia IQ beta feedback item (Today). Draft a vault note. Click the note path (it opens Obsidian). Click Edit text, change a line in the rich-text editor, try bold or a list, look at the Markdown view, save, then approve. | Is the diff readable? Does editing in place feel natural? Is "Edited" visible? Does the done banner say where the text went? | FR-9.2, FR-9.3 | |
| J09 | Vault conflict | Start J09 from the drawer. On the imo_str item, open the Vault note tab and approve. | The note changed after drafting. Is "re-drafting instead of writing" understood? Does a new draft follow? | FR-9.4 | |

### Filing to Confluence

| ID | Journey | Steps | Watch for | FR | Notes |
|---|---|---|---|---|---|
| J10 | Happy path | Open the imo_str decision item. Click the page title (it opens Confluence in a new tab). Review the ready Confluence draft and approve. Then try the same from the Inbox panel: select the item and click Review Confluence entry. | Are the target page, section and base version obvious? Is the dry-run wording clear? Is Discard noticeable without shouting? | FR-10.2, FR-10.3, FR-10.5 | The seed page IDs are made up, so pole-star.atlassian.net will say the page doesn't exist. |
| J11 | Blocked: people observations | Open the overloaded-engineers item (Today). | The Confluence button is disabled. Is the reason clear? Is the vault the obvious alternative? | FR-10.1, NF-2 | |
| J12 | Blocked: people check | Start J12. Draft a Confluence entry on the Labs graduation item. | The draft is blocked at the people-check step. Is "Draft vault note instead" helpful? | FR-10.4 | |
| J13 | Version conflict | Start J13. Draft and approve a Confluence entry on the Labs graduation item. | Page v42 changed to v44. Does the re-draft explain what happened? | FR-10.5 | |
| J14 | Allow-list refusal | Open the roadmap ownership item (File). Draft a Confluence entry; the target is not on the allow-list. Approve anyway. | Is the red chip noticed before approving? Does the refusal point to Settings › Write targets? | FR-10.6 | |
| J15 | Discard and re-draft | On a ready draft, edit the text, then click Re-draft, then Discard. Try to leave the page with unsaved edits. | Are the confirmations proportionate? | FR-9.3 | |
| J16 | Draft ready while away | On a To file item, click the draft button in the panel's File it section, then move to another item at once. | Does the "Draft ready" toast bring you back? Does the File it row show the state? | FR-9.1 | |

### Polling, triage and notifications

| ID | Journey | Steps | Watch for | FR | Notes |
|---|---|---|---|---|---|
| J17 | New Now item | Start J17, or Poll outcome → VIP DM. | A macOS-style notification appears. Clicking it opens the item. Is one notification per item enough? | FR-11.1, FR-11.2, FR-4.3 | |
| J18 | Quiet hours | Start J18 (clock set to 19:30), then send a VIP DM. | No notification, but the item is in Now. | FR-11.2 | |
| J19 | Quiet window and batch | Click Poll now. Watch the header and the "Waiting for quiet window" row. Add 10 min. | Is it clear why new threads aren't triaged yet? Does the header say "1 call" for the batch? | FR-5.1, §5.3 | |
| J20 | Nothing eligible | Poll outcome → Nothing eligible. | The header says no Claude call was made. Usage does not move. | Story 5.1 | |
| J21 | Revision collisions | Poll outcome → New reply on: a done item, a snoozed item, a corrected item, a drafted item. Then Clock → +10 min: replies wait out the 10-minute quiet window like any thread, and the next scheduled poll re-triages all four in one call. | Each case follows the defaults under Open questions. Are they right? | FR-5.4 | |
| J22 | Wake from sleep | Clock → Wake from 3 h sleep. | Is the catch-up poll visible straight away? | FR-2.7, Story 2.1 | |
| J23 | Failed triage | Find the Triage failed row in Needs you (#data-products-ops). Click Retry. | Does the item land in a lane? Is the failure wording clear? | CL-7 | |

### Budgets, health and usage

| ID | Journey | Steps | Watch for | FR | Notes |
|---|---|---|---|---|---|
| J24 | Triage budget hit | Start J24, then Poll now. | Banner; rules still triage; model-bound threads show "paused". | CL-6 | |
| J25 | Drafts budget hit | Start J25. Try to draft anything. | Draft buttons are disabled, with a reason. | CL-6 | |
| J26 | Slack failing | States → Slack 429, then Slack auth failure. | Banner, nav health dot and Usage › Source health all agree. | FR-2.9 | |
| J27 | Usage check | Open the $ popover in the Inbox header, then Usage & health. | Is the popover enough on most days? | FR-7.2 | |
| J28 | No baseline | Start J28. | The usage page explains that P0-3 hasn't run yet. | S3 | |
| J29 | Run eval | Usage & health → Run eval. Open the report. | Is the comparison with the last report useful? | FR-6.1, FR-6.3 | |

### Settings

| ID | Journey | Steps | Watch for | FR | Notes |
|---|---|---|---|---|---|
| J30 | Edit rules | Add a rule (keyword `/invoice/i` → Today). Drag it to the top. Disable `customer-channels`. Enter a bad regex. Save. | Is the rule editor readable as a sentence? Is the regex error clear? | FR-4.1–4.3, FR-1.5 | |
| J31 | Edit settings | In Slack, change the poll intervals and add a VIP: each saves on its own, with a toast. Remove a VIP, then click Undo in the toast. Set the work-hours interval to 0, switch to Notifications and back (the Slack nav item shows a red dot), try to leave Settings, then fix it. | Is it obvious that changes save on their own? Is Undo enough of a safety net? Is the inline error clear? | FR-1.3, FR-1.5 | |
| J32 | Dry-run | Write targets → turn dry-run off (it asks first; the nav badge goes away), then approve a draft. Turn it back on. | Is the difference between dry-run and real writes always visible? | FR-1.6 | |
| J33 | Rebuild state | Storage & data → Rebuild. | Is it clear that nothing is lost? | §4.3 | |
| J41 | Edit a prompt | Prompts → Edit Vault conventions, change a line, try to leave (it asks), Save. The row shows the new version and Edited. Open it again and Reset to default. Models links each call's prompt version here. Open Confluence routing (Source changed), read the banner, Mark reviewed. | Is it clear the change applies to the next call? Is Reset safe enough? Is it clear what to do when a source changed? | FR-1.7 | |
| J34 | Theme and scope | Switch System/Light/Dark. Switch Scope to Full and click a P3 placeholder. | Do placeholders read as "later", not "broken"? | — | |

### Failure and empty states

| ID | Journey | Steps | Watch for | FR | Notes |
|---|---|---|---|---|---|
| J35 | Unreachable | States → Server down, then Reconnecting. | Is the recovery path clear? | FR-3.3 | |
| J36 | Startup failures | States → API key set / Slack token missing / Claude login failed / FileVault off. | Blocking versus warning. Do the fix instructions make sense? | CL-2, FR-12.2 | |
| J37 | First run | Start J37. Click Run first poll. | Does the first experience make sense? | FR-1.1 | |
| J38 | Inbox zero | Start J38. | Does the empty state feel finished? | — | |
| J39 | Retention-expired item | Start J39. | Is "content removed, permalink kept" clear? | FR-12.1 | |

## Open product questions

The prototype shows one default for each question. Decide each one in the UX round.

1. **New reply on a done item.** Default: it comes back after re-triage, with a "New replies" marker. Should it come back only if the re-triage says Now or Today?
2. **New reply on a snoozed item.** Default: it stays snoozed unless the re-triage says Now.
3. **New reply on an item you corrected.** Default: your correction stands until the next revision, then the model re-triages it and shows what you had set. Should corrections be sticky?
4. **New reply after a draft.** Default: a stale-draft banner appears, and you can still approve.
5. **After a write.** Default: the item stays open, with a "Mark done and next item" button. Should filing an item that only needed filing mark it done automatically?
6. **Keyboard shortcuts.** Are they worth building in M1?
7. **Allow-list warning before approval.** The prototype warns before you approve. PLAN.md only requires the executor to refuse at write time.

## Proposed PLAN.md amendments

These came out of the prototype. They are not yet applied to PLAN.md.

- **New events:**
  - `settings.changed` and `rules.changed` (FR-1.5 says changes are logged as events but doesn't name them);
  - `item.reopened` (Undo, Reopen);
  - `action.edited` (text edited before approval).
- **New fields:**
  - `Action.failureReason`: `conflict | people_check | allow_list | model_error`;
  - `Item.contentExpired`, for items past retention.
- **Success criteria:** the usage page shows S6, which the design leaves out.
- **Item view:** the item endpoint returns `meId`, your Slack user ID, so the thread can label your own messages "You".
- **Next step (Inbox redesign):** `TriageDecision.next` (optional): `need` (reply, approve, decide, prepare, review, actions, file), `step`, `why`, `dueAt`, `dueLabel`, `blocks` and `actionItems`. Model triage returns it; rule decisions don't (no model call), so the Inbox falls back to a default from the lane. The item summary carries `source` and `next`.
- **Item kinds:** `chat` joins `ItemKind`, for Teams chats.
- **Confluence site URL:** `Settings.confluence.siteUrl` (https only, e.g. `https://pole-star.atlassian.net`), so drafts can link to the target page. The executor needs it anyway. The item view returns `targets` (site, space key, vault path) for the links.
- **Client preferences:** theme, scope and whether the Inbox item panel is open are client-side preferences, not part of `settings.json`.

## Deviations from the designs

**Added:**
- the Snoozed, Done and "Waiting for quiet window" rows (Done offers Reopen);
- the Undo toast;
- the "N new" pill;
- the poll-in-flight header states;
- keyboard shortcuts;
- Reopen and "Mark done and next item" in Item detail;
- a stale-draft banner;
- S6 in the success criteria;
- a cost baseline field in Settings › Budgets, so P0-3's measurement has somewhere to go;
- the item page keeps its draft tab in the URL (`?tab=`), so it doesn't jump when a draft finishes.
- links from the action panel to the Confluence page and the Obsidian note;
- a rich-text draft editor with a Markdown view, in place of the plain text box.

**Changed:**
- **Inbox grouping** (FR-8.1). Now and Today merge into one Needs you group, sorted by deadline, with To file at equal weight. Failed triage shows inline in Needs you. Low priority (was Everything else), Snoozed and Done are a footer line of links that open one list at a time. Waiting is a "still active" link in the header. The designs show five headings.
- **Inbox redesign** (`specs/Inbox Redesign Options.html`). One list grouped into Now, Today and To file, with an item panel on the right. It replaces the Board/List lanes and the cards.
  - **Rows:** source mark, where and kind, the summary, a need tag (Approve, Decide, Reply, 2 actions…), a deadline chip coloured by urgency and, in To file, the target.
  - **Panel:** previous/next with position, open as a full page, more actions, close; the summary with its lane and reason; Correct triage inline; a Next step card with the primary action and a snooze timed to the deadline; action items; the latest messages with Show all; File it; the triage meta line; and a Done / Snooze / Done and next footer.
  - **Kept from before, restyled to match:** Failed, Waiting for quiet window, Everything else, Snoozed and Done are collapsible groups below the three main groups (Failed starts open). The "N new" pill, poll states, banners and the P3 Commitments group stay.
  - **Also changed:** dry-run is a small "Dry-run on" link in the header instead of a banner. Filing review and approval happen in the panel (`?item=…&file=confluence`), with Item detail one click away. The top bar is one 64px line, level with the sidebar's header: the title, then the poll status (only while polling, or briefly after with what the poll found), Dry-run on, Poll and Usage. Last and next poll are in the Poll button's tooltip. The date and time, the next deadline and the keyboard hint are gone: the clock is in the scenario drawer, deadlines are on the rows, and the keys are in the panel's tooltips and footer. The selection lives in the URL (`?item=`), and leaving with unsaved draft edits asks first. The sidebar collapses to an icon rail (header button or `[`). It is remembered per browser, and its labels move to tooltips. The designs have no collapsed state.
  - **Not from the design:** `o` opens the full page, `c` toggles Correct triage, and Done keeps the panel on the item (marked done, with Reopen) until you move on. The panel slides in over the list with a faint backdrop. A click outside it closes it, except on rows, links and the header and sidebar buttons.
- **Brand marks.** Sources use their real marks: Slack's logo, and Microsoft's own Outlook and Teams product icons from its Fluent brand-icon CDN. Confluence and Obsidian marks appear in File it. Gong and Plaud have no published mark, so they keep neutral glyphs.
- **Outlook and Teams items** appear in Full scope only, tagged P2. MVP scope stays Slack-only, as in PLAN.md. The Inbox count follows the scope.
- Dry-run defaults to on (FR-1.6). The Settings artboard shows it off.
- The Usage page has the left nav. The artboard only has "Back to inbox".
- **Settings autosave.** Each change saves on its own with a "Changes saved · Undo" toast; typing saves after a short pause or on blur. The artboard's sticky Save/Discard bar is gone. An invalid field shows its error inline and is held back while the other changes save. Leaving the page asks first only if an invalid field would be lost. The one exception is Prompts: prompt and guidance files save on an explicit Save, because every Claude call reads its file fresh, and leaving with an unsaved prompt edit asks first.
- **Settings layout.** Each section is its own view at `/settings/<section>`, with grouped navigation: Inbox (Triage rules, Slack, Notifications), Actions (Write targets), Claude (Models, Prompts, Budgets) and System (Storage & data, Appearance). Rows sit directly on the page surface with hairline dividers. Dry-run leads Write targets, and its nav item shows a Dry-run badge. Batching limits sit behind a disclosure, the theme lives under Appearance, and MVP tags show only in Full scope. Old `/settings#…` links redirect to the right view. See DESIGN.md.
- **Toasts.** A light card at the bottom right with an icon, a title, an optional description and an action, instead of the dark pill at the bottom centre.
- **Type and spacing.** The root font size is back to 16px (body text stays 14px), so Tailwind's rem-based sizes are what they say. Before, every `text-xs` was 10.5px and all spacing was 12.5% tight.
- The default channel exclude list is `#random`, `#alerts-prod`, `#social`. The artboard also excludes `#general`, but the seed data has `#general` threads you need to see.

**Not designed, built from the design tokens:**
- the Eval report page;
- the Unreachable, startup and first-run screens;
- action-panel states other than "ready" and "written";
- the rule editor dialog;
- the snooze and overflow popovers;
- Next step fallbacks for rule-decided items, and the panel states for done, snoozed, waiting and failed items;
- the scenarios drawer.
