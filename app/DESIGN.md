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
   - **Lane colours:** Now, Today and File.
   - **Amber and red:** only for something that needs attention.
   - **Everything else:** greys.
6. **One primary action per view.** Secondary actions are outline or ghost buttons; rare ones go in overflow menus.
7. **Navigation is quiet.** Group labels are small and muted. The selected item has a subtle neutral fill; the app's main nav keeps the accent.
8. **Calm, reversible feedback.** Changes save on their own and confirm with a toast that has a title, an optional line of detail, and Undo. Confirmation dialogs are kept for things that can't be undone or that write outside Work OS.
9. **Progressive disclosure.** Rare or expert settings go behind a disclosure row that shows the current values, such as Batching limits.
10. **Status small and inline.** A dot and a few words, such as "● Connected", or a badge on a nav item. A full-width banner is for something you need to act on.

## Settings (applied)

- Each section is its own view at `/settings/<section>`, with grouped navigation:
  - **Inbox:** Triage rules, Slack, Notifications
  - **Actions:** Write targets
  - **Claude:** Models, Budgets
  - **System:** Storage & data, Appearance
- **Nav badges:**
  - Write targets shows "Dry-run" while dry-run is on.
  - A section with an unsaved invalid field shows a red dot.
- Rows sit directly on the page surface with hairline dividers; there are no boxed cards.

## Inbox (applied, from `specs/Inbox Redesign Options.html`)

- **Layout:** one list and an item panel. The list is grouped into Now, Today and To file. Each group has a coloured dot, a title and a count, and its rows are separated by hairlines. There are no trays and no cards. Now rows have a faint orange wash; the selected row has an accent wash and a 3px accent bar.
- **Rows:** read left to right. Source mark → where and kind · age → summary → chips. There are three chips:
  - a grey need tag;
  - a deadline chip coloured by urgency: orange if within about 4 h or overdue, blue if later today, grey otherwise;
  - in To file, a teal target chip.
- **Item panel:** has one primary action, in the Next step card. Everything else is secondary (outline) or ghost. Done, Snooze and Done and next sit in a fixed footer with their shortcuts shown.
- **Lower groups:** Failed, Waiting, Everything else, Snoozed and Done are collapsible headings in the same list. They are not separate boxes.
- **Status:** dry-run is a small amber "Dry-run on" link in the header. Banners are only for things you need to act on (budgets, Slack failing, FileVault).
- **Brand marks:** sources show their real marks, never a recoloured glyph:
  - **Slack:** the Slack logo.
  - **Outlook and Teams:** Microsoft's Fluent product icons.
  - **Write targets:** the Confluence and Obsidian marks.
  - All of them live in `components/BrandIcon.tsx`.

## Impact on the other pages (proposed, not yet applied)

**Shell**
- Add group labels to the nav once P2–P4 items exist: Work (Inbox, Commitments, Briefs) and System (Usage, Settings).
- Move the Scope control into the scenarios drawer. It's a prototype aid, not a product setting.

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
