# Work OS identity: implementation spec

Owner: Frank Keulers
Status: Ready to build, v1.0, 9 Oct 2026
Implements: the Work OS mark (the status tile), the favicon, the status-light states and motion. The name doesn't change.
Design source: `specs/brand-workos/` (see its README). Live canvas: https://claude.ai/artifact/BzeJ17Aw7sp79xzeD2aLEP, "Work OS" page.

> **Build this or `MUNINN-IDENTITY.md`, not both.** The two specs share tokens, state logic, motion rules and the component API. If Muninn is chosen later, swap the geometry (§3), add the perched illustration, and run Muninn's rename milestone (its B4).

---

## 0. Before you start

1. The working tree may have uncommitted changes. Ask Frank whether to commit or stash them, and don't mix them into this work.
2. Work on the branch `brand/workos-mark`. Give each milestone (§9) its own commit or commits, and reference `WO-*` IDs in commit messages.
3. Read `specs/brand-workos/README.md`, then open `specs/brand-workos/motion/motion-preview.html` in a browser.
4. Follow `app/DESIGN.md` and `specs/CLAUDE.md`. Nothing here overrides the non-negotiables.

## 1. Summary

The app keeps the name **Work OS** and gets one mark: the **status tile**. It's a rounded tile, like a work item, with two text lines and a status light in the top-right socket. The light shows the app's state:

- **Quiet:** the light matches the tile. Nothing needs you.
- **Needs you:** the light is orange. Something is in the Now lane.
- **Filed:** the light is teal, briefly, after a write to the vault or Confluence.

The same mark is the empty-state illustration. While a poll runs, it plays "checking sources".

## 2. Decisions (locked)

| ID | Decision |
|---|---|
| WO-1 | The name stays **Work OS** everywhere. There are no string changes. |
| WO-2 | The status tile is the only mark, and it's also the illustration. The orbit and W directions are rejected. |
| WO-3 | The light has three states: `quiet`, `attention` and `filed`. There are no other badges on the mark. |
| WO-4 | The tile is drawn in `currentColor` (`--ink`). Only the light uses brand colour. |
| WO-5 | The socket and the text lines are holes in the path (`fill-rule="evenodd"`), so the mark works on any background. |
| WO-6 | There are three animations: checking sources, needs you and filed. They use only CSS keyframes. |
| WO-7 | With reduced motion, nothing moves. The states show as a static light colour. |
| WO-8 | The sidebar text stays as it is: "Work OS", 17px, semibold, `tracking-tight`. |
| WO-9 | The palette doesn't change. The Sheen accent is a separate decision (§10). |

## 3. Geometry (source of truth)

The full mark uses `viewBox="0 0 64 64"`. At 32px and below, use the tight crop `viewBox="6 6 52 52"` so the tile fills the space. Copy the path data exactly; the same data is in `specs/brand-workos/marks/`.

```text
TILE (body, with the socket and two text-line holes; fill-rule evenodd)
M22 8 H42 C50 8 56 14 56 22 V42 C56 50 50 56 42 56 H22 C14 56 8 50 8 42 V22 C8 14 14 8 22 8 Z
M50.5 20 A6.5 6.5 0 1 0 37.5 20 A6.5 6.5 0 1 0 50.5 20 Z
M18 34 H36 A2 2 0 0 1 36 38 H18 A2 2 0 0 1 18 34 Z
M18 43 H29 A2 2 0 0 1 29 47 H18 A2 2 0 0 1 18 43 Z

LIGHT: circle cx=44 cy=20 r=4
  at 16px or less, in the attention and filed states: r=6.5 (it fills the socket, so the colour reads)

APP ICON (64 grid): rect 64×64 rx=14.4 fill #14171C;
  socket circle cx=48 cy=16 r=8.67 and lines rect(10.67,34.67,26.67×5.33,rx 2.67), rect(10.67,46.67,17.33×5.33,rx 2.67) in #F3F4F6;
  light circle cx=48 cy=16 r=5.33 fill #F97316
```

## 4. Tokens

Add these to `apps/web/src/styles/tokens.css` in all three theme blocks (`:root[data-theme="light"]`, `:root[data-theme="dark"]`, and `:root[data-theme="system"]` inside `@media (prefers-color-scheme: dark)`), and map them in `@theme inline`:

| Token | Light | Dark |
|---|---|---|
| `--mark-attention` | `#C2410C` | `#F97316` |
| `--mark-filed` | `#0F766E` | `#2DD4BF` |

The tile uses `currentColor`. On a solid tile (the toast), set `color: var(--on-solid)`.

## 5. Components

Put them in `apps/web/src/components/brand/`.

### 5.1 `BrandMark`

```ts
type MarkState = 'quiet' | 'attention' | 'filed';

interface BrandMarkProps {
  size?: number;        // px, default 24
  state?: MarkState;    // resting light colour, default 'quiet'
  playKey?: number;     // changing it plays the animation for `state` once (attention or filed); quiet never animates
  checking?: boolean;   // loops the checking animation while true (only at size >= 48)
  title?: string;       // set it, and the mark is role="img" with <title>; leave it out, and it is aria-hidden
  className?: string;
}
```

- **Rendering.** One `<path fill="currentColor" fill-rule="evenodd">` (TILE), then the light `<circle>`.
- **Light fill.**
  - `quiet`: `currentColor`
  - `attention`: `var(--mark-attention)`
  - `filed`: `var(--mark-filed)`
- **ViewBox.**
  - Size 32 or less: `6 6 52 52`.
  - Size above 32 with no animation: `0 0 64 64`.
  - While animating: `-4 -8 72 72`, which leaves room for the hop and the tilt.
- **Size behaviour.**
  - Below 32px, needs you and filed only change the light's colour and play one ring. The tile doesn't tilt.
  - At 16px or less, attention and filed use the socket-filling light (r=6.5).
- **Replays.** When `playKey` changes, add the animation class, and remove it on `animationend`. A new `playKey` during a run restarts the animation.
- **Priority.** Attention wins over filed.
- **Stopping the checking loop.** When `checking` turns false, let the current 4.8s cycle finish (listen for `animationiteration`), then stop, so the tile never snaps mid-hop.

### 5.2 `useBrandFavicon(state: 'quiet' | 'attention')`

- Swaps the `href` of `<link rel="icon" type="image/svg+xml">` between `/favicon.svg` and `/favicon-attention.svg`.
- The filed state never shows in the favicon.
- Call it once, in `Shell`.

## 6. Motion

`specs/brand-workos/motion/motion-preview.html` is the source of truth. Port its CSS to `apps/web/src/styles/brand.css`, imported from `main.tsx`, and keep the keyframe names (`ckHop`, `ckLook`, `ndTilt`, `ndLight`, `ndRing`, `flLight`, `flRing`).

| Animation | Duration | Plays | Trigger |
|---|---|---|---|
| Checking sources | 4.8s per cycle | loops | `inbox.poll.phase !== 'idle'`, on the empty-state mark |
| Needs you | 3.6s | once | The count of `lane === 'now'` items rises. It doesn't play on first load; on load, show the static attention state. |
| Filed | 4s | once | An action moves to `status === 'done'` (see "Written" in `ActionPanel.tsx`). This includes dry-run writes to the sandbox. |

**What each one does** (summary only; the keyframes are authoritative):

- **Checking sources:** the tile rests, crouches, hops 8 units and lands with a squash. The light then looks left, looks right, recentres and blinks (it grows to fill the socket, so it reads as closed).
- **Needs you:** the tile tilts up by -8° from its bottom-left corner, wobbles and holds at -5°. The light pops to 1.7× in orange, and two rings ripple out to 4.5×, the second 0.28s behind. The tile settles, and the light **stays orange** while the Now count is above zero. In the preview it goes back to ink only because the preview loops.
- **Filed:** the light pops to 1.7× in teal, one ring ripples out, the light holds teal for about 1.2s and then goes back to the resting state. The tile doesn't move.

**Rules:**

- Animate only `transform`, `opacity` and `fill`.
- With reduced motion, there are no animations. The light shows the resting colour straight away, and filed shows teal for 1.5s and then returns to rest.
- One animation at a time per mark instance.
- The sidebar header stays 64px tall throughout.

## 7. Placements

| ID | Where | Change |
|---|---|---|
| WO-10 | `apps/web/index.html` | Keep `<title>Work OS</title>`. Add `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`, `<link rel="alternate icon" type="image/png" href="/favicon-32.png">` and `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`. |
| WO-11 | `apps/web/public/` (new; Vite serves it at `/`) | Copy `favicon.svg` and `favicon-attention.svg` from `specs/brand-workos/marks/`, `favicon-32.png` from `png/`, and `png/apple-touch-icon-180.png` as `apple-touch-icon.png`. Check that `dist/` and `dist-mock/` both contain them. |
| WO-12 | `Shell.tsx`, sidebar header (around line 259) | **Expanded:** a 26px `BrandMark`, then the existing "Work OS" text, then the toggle, with a 10px gap. **Collapsed:** the toggle is replaced by a 26px `BrandMark` inside the existing `IconButton`, with `label="Expand sidebar"` and `title="Expand sidebar ([)"`. |
| WO-13 | `Shell.tsx`, the mark's state | `attention` when the count of items with `lane === 'now'` (using the same live-source filter as `count` on line 225) is above 0; otherwise `quiet`. Bump `playKey` when that count goes up. Feed the same state to `useBrandFavicon`. The existing `count` includes `today` and `file`, so don't reuse it as it is. |
| WO-14 | `Shell.tsx`, filed | Subscribe to `emitFiled()` from a new `lib/brandEvents.ts`. Fire it where an action becomes `done`, and play `filed` when it fires. |
| WO-15 | `Toasts.tsx` (around line 73) | Replace the "W" letter tile with a 22px `BrandMark` (`color: var(--on-solid)`) on the existing `bg-solid` tile, in the `attention` state. Keep the title text "Work OS · Now". |
| WO-16 | `pages/Inbox.tsx`, `InboxZero` | Replace the teal check badge with a `BrandMark` (size 88, `checking={inbox.poll.phase !== 'idle'}`, decorative). Keep the heading, the copy and `data-testid="inbox-zero"`. |
| WO-17 | `pages/Inbox.tsx`, `FirstRun` | Replace the inbox icon tile with a `BrandMark` (size 72, `checking={busy}`). Keep the copy. |

## 8. Scope

**In scope:** everything in §7, the tokens, `brand.css`, the components, the tests, and a "Brand" section in `app/DESIGN.md` that summarises §2–§6 and links here.

**Out of scope:** any rename, package names, data directories and the launchd label (see §10), the palette, and the nav icons.

## 9. Milestones and acceptance

Build them in order, and don't start one until the previous one passes.

### W1 Assets, tokens and component (WO-1–WO-11)

> As Frank, I want the Work OS mark in the browser tab and available as a component, so that the app has its own icon.

- **Given** the built app in light or dark mode, **then** the tab shows the status tile, and the dark variant appears under `prefers-color-scheme: dark`.
- **Given** `<BrandMark state="attention" size={64} />`, **then** the light is `--mark-attention`, the socket and text lines are transparent, and the element is `aria-hidden`.
- **Given** `size={16}` and `state="attention"`, **then** the light fills the socket (r=6.5) and the viewBox is `6 6 52 52`.
- **Unit tests:** state → fill mapping; viewBox by size; `title` gives `role="img"`; `playKey` adds and then removes the animation class; `checking` stops at the end of a cycle.

### W2 Placements and state wiring (WO-12–WO-17)

> As Frank, I want the status light to tell me at a glance whether anything needs me.

- **Given** no Now items, **then** the sidebar light and the favicon are quiet.
- **Given** a new Now item arrives (Scenarios drawer), **then** the sidebar mark plays "needs you" once, the light stays orange, and the favicon switches to `favicon-attention.svg`.
- **Given** the last Now item is done or snoozed, **then** the light and the favicon go back to quiet.
- **Given** a vault or Confluence draft is approved and written (including dry-run), **then** the sidebar mark plays "filed" once.
- **Given** the collapsed sidebar, **then** the header shows only the mark, and clicking it or pressing `[` expands the sidebar.
- **Given** Inbox zero during a poll, **then** the empty-state mark plays "checking sources". When the poll ends, it finishes its cycle and stops.
- **e2e:** add these to `shell.spec.ts` and the Inbox specs: the favicon `href` switches; `inbox-zero` contains an `svg[aria-hidden]`; the existing "Work OS" sidebar assertion still passes.

### W3 Motion polish and reduced motion (WO-6, WO-7)

- **Given** `reducedMotion: 'reduce'`, **when** a Now item arrives, **then** there's no transform animation and the light is orange straight away.
- Side by side, the timings match `motion-preview.html`. Frank signs this off by eye.
- There's no layout shift during any animation.

### W4 Docs and screenshots

- Add the "Brand" section to `app/DESIGN.md`.
- Regenerate the screenshots in `app/screenshots/` that show the sidebar or Inbox zero.
- `npm test`, `npm run e2e`, `npm run e2e:server` and `npm run lint` all pass.

## 10. Follow-ups (not in this spec)

| ID | Item | Note |
|---|---|---|
| WO-F1 | **Sheen accent.** Ink for primary actions, and `#3F3A9E` (dark `#A5A0F0`) for links and selection. | It touches about 80 `accent` uses. **Needs Frank's go-ahead.** |
| WO-F2 | **launchd label.** Rename `com.polestar.workos` to an employer-neutral label. | This is for portability between jobs. It needs the agent uninstalled and reinstalled. |
| WO-F3 | **macOS notification icon.** `terminal-notifier -appIcon` or `-contentImage` with `app-icon-512.png`. | Check that the flag still works on the current macOS first. |
| WO-F4 | **Nav icon refresh.** Move to a 1.5px stroke so the icons match the mark's weight. | Only after W4. |
