# Work OS design principles: clean UI

Work OS is a tool you glance at many times a day. Each screen should show what needs you and stay quiet about everything else. These principles apply to every page. The tokens (colours, lane palette, IBM Plex) still come from the Claude Design bundle in `specs/`; this file covers how they're used.

## Principles

1. **One surface per view.** Use whitespace and hairline dividers for structure, not boxes. Avoid a card inside a tray inside a panel. A card is for something you act on as a unit, such as an inbox item or a draft.
2. **A small type scale, used the same way everywhere.**

   | Role | Size / weight | Use |
   |---|---|---|
   | Page title | 22px / 600 | One per page |
   | Section title | 18px / 600 | Sections within a page |
   | Group title | 13px / 600 | Groups of rows within a section |
   | Label | 14px / 500 | Row and field labels, card titles |
   | Body | 14px / 400 | Running text |
   | Help | 13px / 400, muted | One line under a label that says what the setting does |
   | Meta | 12px / 400, muted | Counts, times, IDs |

   Mono is only for things you'd copy: IDs, paths, model names, prompt versions, regexes.
3. **A 4px spacing grid.** The page gutter is 32px. Rows have 20px vertical padding, groups are 32px apart and sections 40px apart. The root font size stays at 16px so Tailwind sizes are what they say (body copy is set to 14px on `body`).
4. **Label left, control right.** Small controls (switches, selects, short numbers, segmented controls) sit at the right edge of the row. Wide controls (chip lists, allow-lists, rule lists) go under the label at full width.
5. **Colour carries meaning, nothing else.**
   - **Accent:** the one primary action, the selected state, links.
   - **Lane colours:** Now (orange) and To file (teal).
   - **Amber and red:** only for something that needs attention.
   - **Everything else:** greys.
6. **One primary action per view.** Secondary actions are outline or ghost buttons; rare ones go in overflow menus.
   - **Buttons carry an icon** that says what they do: ✓ approve or save, ✎ edit, ↻ re-draft or retry, × cancel, a bin for discard.
   - **Colour follows the kind of action** (`Button` variants in `components/ui.tsx`):
     - `solid` (accent) is the one commit action;
     - `secondary` (outline) is anything neutral or reversible;
     - `danger` is red text with a soft red edge, for actions that throw work away. It sits apart from the primary, at the far end of the row, and turns solid red (`dangerSolid`) only on the confirm button in its dialog.
7. **Navigation is quiet.** Group labels are small and muted. The selected item has a subtle neutral fill; the app's main nav keeps the accent.
8. **Calm, reversible feedback.** Changes save on their own and confirm with a toast that has a title, an optional line of detail, and Undo. Confirmation dialogs are kept for things that can't be undone or that write outside Work OS.
9. **Progressive disclosure.** Rare or expert settings go behind a disclosure row that shows the current values, such as Batching limits.
10. **Status small and inline.** A dot and a few words, such as "● Connected", or a badge on a nav item. A full-width banner is for something you need to act on.

## Sidebar (applied)

- **Collapsing:** the sidebar folds to a 60px icon rail and back (200 ms width transition; with reduced motion it just snaps). Use the button in its header or the `[` key. The choice is a per-browser preference, like theme and scope, so it survives a reload.
- **Rail contents:** the same items in the same order, as icons only. Each label moves to a tooltip and stays available to screen readers. The Inbox count becomes a small badge on the icon. Slack's health shows as a dot on its mark. The account button shows only the avatar. Placeholders keep their dashed style.
- **Header:** 64px tall in both states, so it stays level with the page top bars. Collapsing hides the brand and leaves only the toggle.
- **Fixed height:** the app is one screen high. The sidebar never scrolls with the page, and pages with a 64px top bar (Inbox, Settings, Usage, Guide) keep the bar fixed and scroll only their body.
- **Account menu:** the foot of the sidebar is an account button: the avatar, your display name ("Account" until a name is set) and a small MVP / Full chip, since scope changes what every page shows. It opens a menu above the button (beside the rail when collapsed) with a Light / Dark / System theme switch, the Scope switch, and an Edit profile link to Settings › Profile.
- **Avatar:** the profile picture from Settings › Profile. Without one it shows your initials from the first and last name (or the display name), and a person icon when no name is set. The picture is cropped to a centred square, scaled down and kept in this browser, like the theme. It never goes to the server.
- **Profile:** first name, last name, display name and the profile picture, in Settings › Profile. The display name is what the account button shows; when it's empty, the first and last name are used instead. Like the picture, the names stay in this browser and aren't part of `settings.json`.
- **Icons:** Settings & rules uses a gear. The old sun-like glyph read as a light-mode control.

## Settings (applied)

- Each section is its own view at `/settings/<section>`, with grouped navigation:
  - **Account:** Profile, Appearance
  - **Inbox:** Triage rules, People, Schedule, Notifications. What applies to every source.
  - **Sources:** Slack, then More sources (Full scope only). One page per source: what's read, how often it polls, where its links open.
  - **Actions:** Write targets
  - **Claude:** Models, Prompts, Budgets
  - **System:** Storage & data
- Plain `/settings` still opens Triage rules, the section used most.
- **Adding a source** (Outlook, say) adds a page to Sources and the source to `RULE_SOURCES`. Rules, People and Schedule stay where they are: a rule can be scoped to sources, VIPs are matched by name on any source, and work hours and the quiet window hold for all of them.
- **Nav badges:**
  - Write targets shows "Dry-run" while dry-run is on.
  - A section with an unsaved invalid field shows a red dot.
- Rows sit directly on the page surface with hairline dividers; there are no boxed cards.
- **Write targets › Confluence scope:** four stacked lists, one per rule:
  - **Root pages**, **Excluded pages** and **Single pages** are page rows (title, ID in mono, ×), each with an "Add … by ID or URL" form.
  - **Labels** are mono chips.

  **Preview catalogue** reads the scope live and lists the pages in a bordered, scrolling box. They are grouped by root under sticky headers, and pages with children carry an "index" chip. Each row links to the page.

## Guide (applied)

- **Way in:** a quiet **Guide** item (book icon) at the bottom of the sidebar, above the account button; an icon with a tooltip in the rail. `?` anywhere outside a text field opens Keyboard shortcuts.
- **Source:** Markdown files in `app/docs/guide/`, one page each. Front matter gives the title, nav group, order, summary and `updated` date. The build carries a copy, shown at once; the server then reads the folder (`GET /api/guide`) and its pages replace the copy, again whenever the window regains focus. So an edit shows without a deploy. Under the page list, a muted line says which it is: "Read live from docs/guide" or "Built-in copy from this build". A file that doesn't parse keeps its built-in copy, with a warning banner naming the problem. The page loads lazily, so it costs nothing until opened.
- **Layout:** like Settings, so it feels native:
  - a 64px top bar with the title and a search box (`/` focuses it);
  - the pages on the left in groups (Start here, Inbox, Filing, Settings, Help);
  - the page as prose in the middle, at most 720px wide, with its group, title, summary and "Updated" date above, and Previous / Next below;
  - "On this page" on the right from 1280px, marking the section in view.
- **Search:** filters as you type over titles, headings and text, and shows the page, the heading and a snippet with the words marked. Arrow keys move, Enter opens, Esc clears.
- **Links in the Markdown:** another page (`rules.md#tips`) and app routes (`/settings/writing`) navigate in the app; `https:` opens a new tab; anything else renders as text. Raw HTML shows escaped. Code blocks have a Copy button.
- **Contextual links:** a small "Guide" link with the book icon in the headers of Settings › Triage rules, Write targets and Prompts, in the health banner ("Help"), and on the Confluence "Nothing to file" and "Write refused" banners. Each lands on the right section.

## Inbox (applied, from `specs/Inbox Redesign Options.html`)

- **Layout:** one list and an item panel. The list has two groups of equal weight, Needs you and To file. Each group has a coloured dot, a title and a count, and its rows are separated by hairlines. There are no trays and no cards. Needs you lists Now rows first, with a faint orange wash and a darker hairline under the last one, then failed triage, then Today rows by deadline. The selected row has an accent wash and a 3px accent bar.
- **Rows:** read left to right. Source mark → where and kind · age → summary → chips. There are three chips:
  - a grey need tag;
  - a deadline chip coloured by urgency: orange if within about 4 h or overdue, blue if later today, grey otherwise;
  - in To file, a teal target chip.
- **Item panel motion:** the panel slides in over the list from the right (240 ms) and back out (180 ms), below the page header so Poll and Usage stay in view. A faint backdrop (`--scrim`) fades in over the list. It is visual only: the list still scrolls, and a row click switches the item. With reduced motion it just appears. A click outside closes the panel, except on rows, links, header and sidebar buttons, toasts, dialogs, menus and the scenario drawer. Esc and × close it too.
- **Item panel:** has one primary action, in the Next step card. Everything else is secondary (outline) or ghost. Done, Snooze and Done and next sit in a fixed footer with their shortcuts shown.
- **One card for acting.** The Next step card (or the Status card, when there's nothing to do) also holds the filing, so the messages never sit between a step and its doing:
  - **Under the step:** the File it options, one row per target with its state. When the step's own action is a draft, that target is already the primary button, so the rows are headed Also file and list only the other one. Where it will go, or why the draft is out of date, shows under the primary button.
  - **Once a draft is opened:** the action panel takes the options' place in the same card. It shows the drafting progress, then the review, with Approve and Discard flush along the card's bottom edge. Its tabs switch target, so the step's own draft button steps aside. Back to filing options folds it away again.
- **Everything else is one click away.** A footer row sits under the groups. **Low priority** leads on the left as an outlined button with the inbox icon and a bold count ("14 low priority"), because it's the one most worth a look to correct triage. Snoozed (clock icon, "2 snoozed · next back 10:25") and Done (tick icon) are small muted links at the far right. Each one toggles its list open below, one at a time, and j/k walk it after To file. Snoozed and Done only show when they have items.
  - **Failed triage** sits in Needs you with a red Triage failed chip, so it isn't missed. Retry is in the panel.
  - **Waiting for the quiet window** is a quiet "N still active" link in the header, which opens its list in the same place.
- **Top bar:** one line, 64px high, the same as the sidebar's header, so their bottom edges line up. Settings uses the same height. It holds only:
  - the page title;
  - the poll status, shown only while it's happening or just after;
  - Dry-run on;
  - two 32px icon buttons, Poll and Usage.

  Details go in tooltips: last and next poll on Poll, and the shortcut keys on the panel's buttons.
- **Status:** dry-run is a small amber "Dry-run on" link in the header. Banners are only for things you need to act on (budgets, Slack failing, FileVault).
- **Brand marks:** sources show their real marks, never a recoloured glyph:
  - **Slack:** the Slack logo.
  - **Outlook and Teams:** Microsoft's Fluent product icons.
  - **Write targets:** the Confluence and Obsidian marks.
  - All of them live in `components/BrandIcon.tsx`.

## Action panel (applied)

- **Targets are links.** The Confluence page title opens the page (`<site>/wiki/spaces/<key>/pages/<id>`) in a new tab. The vault path opens the note in Obsidian (`obsidian://open?vault=…&file=…`). A new note has no link until it's written, because it doesn't exist yet. After a write, the done banner has Open page or Open note.
- **Drafts are rich text.** Drafts are stored as markdown. They're rendered as formatted text, and Edit text edits them in place, with a small toolbar (heading, bold, italic, code, bulleted list, numbered list). A Markdown view shows the raw text. Front matter shows as a properties block and is edited in the Markdown view. Obsidian `[[wiki links]]` survive edits.
- **Every action sits where it acts.**
  - **Edit** is part of the draft: an Edit button in the draft's corner, or click the text. Save and Cancel sit under the editor, and the footer steps aside while you edit.
  - **Re-draft** is a quiet button by the draft tabs, because it replaces the whole draft.
  - **The footer** holds only Approve and, at the far end, Discard.
- **Only what you need to decide.** The target line gives the page or note, then one "✓ Checks passed" toggle, which turns red when a check fails. The individual checks, page ID, base version, dry-run note and model, duration and tokens are behind that toggle. A failed check still raises its own banner. "Edited" is a small tag on the draft.

## Impact on the other pages (proposed, not yet applied)

**Shell**
- Add group labels to the nav once P2–P4 items exist: Work (Inbox, Commitments, Briefs) and System (Usage, Settings).
- Move the Scope control into the scenarios drawer. It's a prototype aid, not a product setting. (For now it sits in the account menu, with the theme.)

**Item detail**
- **Match the Inbox panel.** Item detail is now the "open as a full page" view of the panel, so it should use the same blocks: the source line, the summary with its lane chip, the Next step card, and the messages.
- **Triage band:** becomes a slim header line with the lane tag, headline and reason. Model, prompt version and revision go into a Meta line underneath, instead of a tinted block.
- **Action panel:** remove the grey box around the white preview box. One bordered preview is enough.
- **Thread:** sits directly on the page with dividers between messages, not in a card.

**Usage & health**
- **KPI cards:** keep them; they're the glanceable part.
- **Success criteria:** S1–S7 become a table (criterion, value, target, status) instead of a grid of boxes inside a box.
- **Source health:** becomes a row in that table area, not a nested box.

**Eval report**
- Already mostly tables. Just align it to the type scale.

**Toasts:** applied app-wide: a light card with an icon, a title and an optional description, at the bottom right.

**Scenarios drawer:** unchanged. It's a test tool and is meant to look different (dashed violet).
