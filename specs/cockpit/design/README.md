# Cockpit design files

The source of the Claude Design canvas **Work OS Cockpit** (https://claude.ai/artifact/JEk8AcWkdhQvquwWTGBiHc, private to Frank). The canvas is the place to view and comment; these files are a copy for the repo, taken 9 Oct 2026. If the canvas changes, copy its files here again.

| File | Artboard |
|---|---|
| `Main.dc.html` | 1 · Cockpit at a glance at 13:48 (light). Takes a `theme` prop: `light` or `dark`. |
| `Main-dark.dc.html` | 1 · the same, dark (imports `Main` with `theme="dark"`) |
| `Panel.dc.html` | 2 · Item open: the panel over Later (light; `theme` prop) |
| `Panel-dark.dc.html` | 2 · the same, dark |
| `States.dc.html` | 3 · States: auto-close, health, New marker, time column, glance type (light; `theme` prop) |
| `States-dark.dc.html` | 3 · the same, dark |
| `canvas.json` | The canvas index: artboard positions and titles |

Notes for implementation:

- Each palette in `renderVals()` maps to `apps/web/src/styles/tokens.css`. New tokens are listed in SPEC.md CK-1.8.
- The lettered source squares (S, O, C, W) are placeholders for `BrandIcon.tsx`'s real marks.
- The `.dc.html` files need the Claude Design runtime (`support.js`), so they don't open on their own in a browser. View them on the canvas.
- The content is the mock seed's, at 13:48 on Fri 9 Oct, sized for a 1728 × 1000 viewport (a 16" MacBook Pro at default scaling, less browser chrome).
- "Free 90 min · N items fit" was removed from this pass. It is backlog item B1 in SPEC.md.
