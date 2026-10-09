# Muninn brand collateral

Muninn is the new name for Work OS. It is named after one of Odin's two ravens: they fly out over the world each day and come back to report what they have seen. Muninn is the "memory" raven. The app does the same job: it goes out to your sources, reports what needs you and remembers the rest.

The implementation spec is [`../MUNINN-IDENTITY.md`](../MUNINN-IDENTITY.md). This folder holds the design source it points to.

- Design canvas (all rounds, live): https://claude.ai/artifact/BzeJ17Aw7sp79xzeD2aLEP (private to Frank)
- Decided: 8 Oct 2026

## Folders

| Folder | What's in it | Use |
|---|---|---|
| `marks/` | Final SVG marks. Each is a single path with `fill-rule="evenodd"`, so the eye ring and the cut lines are real holes and show whatever is behind them. | Source of truth for geometry. Copy the path data into the React components; don't import these files at runtime. |
| `png/` | PNG renders: favicons (16, 32, 48), `apple-touch-icon` (180), app icon (512, 1024), large head and perched raven (1024). | `favicon-32.png` and `apple-touch-icon-180.png` ship in `apps/web/public/`. The rest are for docs, slides and the README. |
| `motion/motion-preview.html` | A standalone reference for the three animations. Open it in a browser. It has a dark-theme toggle and a reduced-motion toggle. | Source of truth for timings, easings and keyframes. |
| `canvas/` | A copy of the design canvas source (`.dc.html` artboards and `canvas.json`). It needs the canvas runtime to render, so use the live link above to view it. | An archive of the exploration, including rejected directions B (flight) and C (monogram). |
| `explorations/` | Render sheets from each round of review. | Shows why the final marks look the way they do. |

## The marks

| Mark | File | Where it's used |
|---|---|---|
| **A2 head** | `muninn-head-{quiet,attention,filed}[-dark].svg` | Favicon, sidebar, collapsed rail, toast and notification tile, app icon. The eye shows the app's state. |
| **A2 head, large** | `muninn-head-large[-dark].svg` | 64px and up. It adds two cut lines on the throat that hint at a raven's shaggy throat feathers. |
| **A3 perched** | `muninn-perched[-dark].svg` | The empty Inbox, the first-run screen and the checking animation. Use it at 64px or larger, because the legs and wing line disappear below 32px. |
| **Favicon** | `favicon.svg`, `favicon-attention.svg` | Browser tab. Both carry a `prefers-color-scheme` dark variant. In the attention version, the orange fills the whole eye socket so it still reads at 16px. |
| **App icon** | `app-icon.svg` | A light head on an ink tile, with an orange eye. |

## The eye states

| State | Light | Dark | Meaning |
|---|---|---|---|
| quiet | eye matches the body (`--ink`) | eye matches the body (`--ink`) | Nothing needs you |
| attention | `#C2410C` | `#F97316` | At least one item is in the Now lane |
| filed | `#0F766E` | `#2DD4BF` | Something was just written to the vault or Confluence. This is brief, then the eye goes back to quiet. |

## Rejected, and why

- **A (first profile):** stood upright with a bulbous head, so it read as a man with a big nose.
- **A2 with a jagged throat:** the notches read as a mouth. Now replaced by a smooth curve, with cut lines on the large mark only.
- **B (flight):** at 16px it reads as any bird of prey.
- **C (monogram "m" with a beak):** the beak is lost at 16px.
- **Motion with call lines, signal arcs, a flying note and a tick:** too busy. Frank dropped them all, along with the head nod on "filed".
