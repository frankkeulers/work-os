# Work OS identity (alternative to Muninn)

Status: **A (the status tile) chosen**, 9 Oct 2026. The implementation spec is [`../WORKOS-IDENTITY.md`](../WORKOS-IDENTITY.md).

## Final files

| File | Use |
|---|---|
| `marks/workos-mark-{quiet,attention,filed}[-dark].svg` | The final mark in each state. The geometry source of truth. |
| `marks/favicon.svg`, `marks/favicon-attention.svg` | Browser tab. A tight crop drawn as a self-contained badge: an ink tile with the socket and lines filled light, like the app icon, so it reads on light and dark tab strips without a `prefers-color-scheme` variant (Chrome doesn't reliably apply one to tab icons). Quiet shows a light ring with an ink centre; in the attention version the orange fills the socket so it reads at 16px. |
| `marks/app-icon.svg` | An ink squircle with the socket and text lines in paper and an orange light. |
| `png/` | Favicons at 16, 32 and 48 (plus attention at 32), the Apple touch icon at 180, the app icon at 512 and 1024, and the mark at 1024. |
| `motion/motion-preview.html` | Reference for the three animations, with dark-theme and reduced-motion toggles. |
| `marks/explorations/` | The round-1 SVGs for all three directions. |

---

The notes below are from round 1, before the choice was made.

This is a second identity running in parallel with Muninn (`../brand/`, `../MUNINN-IDENTITY.md`). The name stays **Work OS** and there's no character or theme. It keeps everything that worked in the Muninn system:

- A status light in the mark acts as the "eye".
- The same three states: quiet, needs you (orange) and filed (teal).
- The same colour tokens (`--mark-attention`, `--mark-filed`), timings and reduced-motion rules.
- A "checking sources" animation that runs while a poll is in progress.

The Muninn work is untouched. On the design canvas, the Muninn boards are on the "Muninn" page and this work is on the "Work OS" page.

- Canvas: https://claude.ai/artifact/BzeJ17Aw7sp79xzeD2aLEP (open the "Work OS" page)

## Folders

| Folder | What's in it |
|---|---|
| `marks/explorations/` | `workos-{a-tile,b-orbit,c-w}-{quiet,attention,filed}[-dark].svg`: every direction in every state, light and dark. Each is drawn on a 64×64 grid. |
| `explorations/` | A render sheet of all three directions in light and dark, at 96, 32 and 16px. |
| `canvas/` | A snapshot of the design canvas source. It includes both pages; the Work OS boards are `WosDirections.dc.html` and `WosMotion.dc.html`. |

## The three directions

| | A · Status tile | B · Orbit | C · W mark |
|---|---|---|---|
| Idea | A work item (a card with two text lines) with a status light in the corner | A ring with a gap, and the status dot in the gap | A geometric W with the status dot above the middle |
| Status light | A dot in a punched socket, the same mechanics as the Muninn eye | A dot at the end of the ring | A dot above the W |
| Checking sources | The tile hops, and the light looks left, then right, then blinks | The ring spins once, then pauses | The dot hops from peak to peak |
| Needs you | The tile tilts up, and the light pops orange with two ripples | The ring wiggles, and the dot pops orange with two ripples | The dot jumps, the W squashes, and the dot pops orange with two ripples |
| Filed | The light pops teal with one ripple | The same | The same |
| 16px | Strongest: a solid shape | Thin, and looks like a spinner | Readable, but the dot can read as an "i" |
| Risk | Could read as a chat bubble or a robot face | When it's static, people may think it's loading | Generic; "Wi" can suggest Wi-Fi |

**Recommendation: A, the status tile.** It is literally what the app does: one work item, with its status shown on it. It's the most legible favicon of the three. It carries the Muninn eye mechanics across directly, so the state logic, tokens and motion rules in `MUNINN-IDENTITY.md` §4–§6 transfer almost unchanged.

## About the name

- "WorkOS", written as one word, is the brand of an existing developer-tools company.
- "Work OS" is also the term monday.com uses to market its platform.

Neither matters for a personal tool. If you ever show it publicly, or take it to another employer as a product, "Work OS" is generic and you can't own it.

## Next steps

1. Frank picks a direction. Refine it the way A2 was refined for Muninn.
2. Add an in-app board (tab, sidebar, rail, toast and empty Inbox) and a standalone `motion-preview.html`.
3. Write `specs/WORKOS-IDENTITY.md` as a variant of `MUNINN-IDENTITY.md`: the same milestones, but no rename, and the mark and illustration swapped.
