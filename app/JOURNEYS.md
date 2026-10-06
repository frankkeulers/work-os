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
| J01 | Morning scan | Open the Inbox. Scan Now, Today and File. Switch to List and back to Board. Expand Everything else. | Is the primary action on each card the obvious next step? Is it clear why each item is in its lane? | FR-3.1, FR-8.1 | |
| J02 | Done and Undo | Click ✓ on a Now card. Click Undo in the toast. Mark it done again. | Does the card leave cleanly, and is Undo easy to find? | FR-8.2, FR-8.3 | |
| J03 | Snooze and return | Snooze a Today card for 1 hour. Open the Snoozed row. In the drawer, add 1 h. | Does the item come back, and is it clear that it came back from a snooze? | FR-8.3 | |
| J04 | Correct triage from a card | On an Everything else row, click Correct triage and set Today. Then on a File card use ⋯ → Correct triage and clear Confluence. | Does the item move straight away? Is the labelled-set toast clear? Check `triage.corrected` in the log. | FR-6.2 | |
| J05 | Correct triage in detail | Open the Labs graduation item. Click Correct triage and change the attention. | Does the triage band recolour and its headline change? | FR-6.2 | |
| J06 | Keyboard triage | On the Inbox, use `j`/`k` to move, `Enter` to open, `e` for Done, `s` for Snooze, `c` for Correct, `Esc` to close. The cursor starts on the last card you touched. | Are the shortcuts worth having? Is the focus ring visible? | (new) | |

### Filing to the vault

| ID | Journey | Steps | Watch for | FR | Notes |
|---|---|---|---|---|---|
| J07 | New vault note | Open the Claude Code how-to item (File). Click Draft vault note. Wait for the draft and read it. Approve. | Is the drafting progress reassuring? Can you judge the path and frontmatter at a glance? | FR-9.1–9.3 | |
| J08 | Append with edit | Open the Meridia IQ beta feedback item (Today). Draft a vault note. Click Edit text, change a line, save, then approve. | Is the diff readable? Is "Edited" visible? Does the done banner say where the text went? | FR-9.2, FR-9.3 | |
| J09 | Vault conflict | Start J09 from the drawer. On the imo_str item, open the Vault note tab and approve. | The note changed after drafting. Is "re-drafting instead of writing" understood? Does a new draft follow? | FR-9.4 | |

### Filing to Confluence

| ID | Journey | Steps | Watch for | FR | Notes |
|---|---|---|---|---|---|
| J10 | Happy path | Open the imo_str decision item. Review the ready Confluence draft and approve. | Are the target page, section and base version obvious? Is the dry-run wording clear? | FR-10.2, FR-10.3, FR-10.5 | |
| J11 | Blocked: people observations | Open the overloaded-engineers item (Today). | The Confluence button is disabled. Is the reason clear? Is the vault the obvious alternative? | FR-10.1, NF-2 | |
| J12 | Blocked: people check | Start J12. Draft a Confluence entry on the Labs graduation item. | The draft is blocked at the people-check step. Is "Draft vault note instead" helpful? | FR-10.4 | |
| J13 | Version conflict | Start J13. Draft and approve a Confluence entry on the Labs graduation item. | Page v42 changed to v44. Does the re-draft explain what happened? | FR-10.5 | |
| J14 | Allow-list refusal | Open the roadmap ownership item (File). Draft a Confluence entry; the target is not on the allow-list. Approve anyway. | Is the red chip noticed before approving? Does the refusal point to Settings › Write targets? | FR-10.6 | |
| J15 | Discard and re-draft | On a ready draft, edit the text, then click Re-draft, then Discard. Try to leave the page with unsaved edits. | Are the confirmations proportionate? | FR-9.3 | |
| J16 | Draft ready while away | From a File card, click the draft button, then go back to the Inbox at once. | Does the "Draft ready" toast bring you back? Does the card button show the state? | FR-9.1 | |

### Polling, triage and notifications

| ID | Journey | Steps | Watch for | FR | Notes |
|---|---|---|---|---|---|
| J17 | New Now item | Start J17, or Poll outcome → VIP DM. | A macOS-style notification appears. Clicking it opens the item. Is one notification per item enough? | FR-11.1, FR-11.2, FR-4.3 | |
| J18 | Quiet hours | Start J18 (clock set to 19:30), then send a VIP DM. | No notification, but the item is in Now. | FR-11.2 | |
| J19 | Quiet window and batch | Click Poll now. Watch the header and the "Waiting for quiet window" row. Add 10 min. | Is it clear why new threads aren't triaged yet? Does the header say "1 call" for the batch? | FR-5.1, §5.3 | |
| J20 | Nothing eligible | Poll outcome → Nothing eligible. | The header says no Claude call was made. Usage does not move. | Story 5.1 | |
| J21 | Revision collisions | Poll outcome → New reply on: a done item, a snoozed item, a corrected item, a drafted item. Then Clock → +10 min: replies wait out the 10-minute quiet window like any thread, and the next scheduled poll re-triages all four in one call. | Each case follows the defaults under Open questions. Are they right? | FR-5.4 | |
| J22 | Wake from sleep | Clock → Wake from 3 h sleep. | Is the catch-up poll visible straight away? | FR-2.7, Story 2.1 | |
| J23 | Failed triage | Find the Failed row (#data-products-ops). Click Retry. | Does the item land in a lane? Is the failure wording clear? | CL-7 | |

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
- **Client preferences:** theme, board/list view and scope are client-side preferences, not part of `settings.json`.

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

**Changed:**
- Dry-run defaults to on (FR-1.6). The Settings artboard shows it off.
- The Usage page has the left nav. The artboard only has "Back to inbox".
- **Settings autosave.** Each change saves on its own with a "Changes saved · Undo" toast; typing saves after a short pause or on blur. The artboard's sticky Save/Discard bar is gone. An invalid field shows its error inline and is held back while the other changes save. Leaving the page asks first only if an invalid field would be lost.
- **Settings layout.** Each section is its own view at `/settings/<section>`, with grouped navigation: Inbox (Triage rules, Slack, Notifications), Actions (Write targets), Claude (Models, Budgets) and System (Storage & data, Appearance). Rows sit directly on the page surface with hairline dividers. Dry-run leads Write targets, and its nav item shows a Dry-run badge. Batching limits sit behind a disclosure, the theme lives under Appearance, and MVP tags show only in Full scope. Old `/settings#…` links redirect to the right view. See DESIGN.md.
- **Toasts.** A light card at the bottom right with an icon, a title, an optional description and an action, instead of the dark pill at the bottom centre.
- **Type and spacing.** The root font size is back to 16px (body text stays 14px), so Tailwind's rem-based sizes are what they say. Before, every `text-xs` was 10.5px and all spacing was 12.5% tight.
- The default channel exclude list is `#random`, `#alerts-prod`, `#social`. The artboard also excludes `#general`, but the seed data has `#general` threads you need to see.

**Not designed, built from the design tokens:**
- the Eval report page;
- the Unreachable, startup and first-run screens;
- action-panel states other than "ready" and "written";
- the rule editor dialog;
- the snooze, correct-triage and overflow popovers;
- the scenarios drawer.
