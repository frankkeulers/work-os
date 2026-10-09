# Muninn identity: implementation spec

Owner: Frank Keulers
Status: Ready to build, v1.0, 8 Oct 2026
Implements: the rename from Work OS to Muninn, the mark, the favicon, eye states and motion
Design source: `specs/brand/` (see its README). Live canvas: https://claude.ai/artifact/BzeJ17Aw7sp79xzeD2aLEP

---

## 0. Before you start

1. The working tree has uncommitted changes (`apps/web/src/api`, `mock/`, `lib/next*`, `packages/shared/src/api.ts`). Ask Frank whether to commit or stash them. Don't mix them into this work.
2. Work on the branch `brand/muninn`. Give each milestone (§9) its own commit or commits, and reference `BR-*` IDs in commit messages.
3. Read `specs/brand/README.md`, then open `specs/brand/motion/motion-preview.html` in a browser.
4. Follow `app/DESIGN.md` and `specs/CLAUDE.md`. Nothing here overrides the non-negotiables.

## 1. Summary

Work OS becomes **Muninn**. Every name the user sees changes. Internal identifiers stay the same (§8).

The app gets two marks:

- **The head (A2).** Used everywhere small. Its eye is a status light: quiet (the eye matches the body), attention (orange: something is in the Now lane) and filed (teal, briefly: something was just written to the vault or Confluence).
- **The perched raven (A3).** Used for the empty Inbox and the first-run screen. It plays a "checking sources" animation while a poll runs.

## 2. Decisions (locked)

| ID | Decision |
|---|---|
| BR-1 | Product name: **Muninn**. In prose and titles, write "Muninn". The lowercase "muninn" is used only in the sidebar wordmark. |
| BR-2 | The A2 head is the primary mark. The A3 perched raven is the illustration. Directions B and C are rejected. |
| BR-3 | The eye has three states: `quiet`, `attention` and `filed`. There are no other badges on the mark. |
| BR-4 | Marks are drawn in `currentColor` (the `--ink` token). Only the eye uses brand colour. |
| BR-5 | The eye ring and the cut lines are holes in the path (`fill-rule="evenodd"`), not white fills, so the mark works on any background. |
| BR-6 | There are three animations: needs you, checking sources and filed. They use only CSS keyframes, with no animation library and no Lottie. |
| BR-7 | With reduced motion, nothing moves. The states show as a static eye colour. |
| BR-8 | Wordmark: IBM Plex Sans, semibold, lowercase, `tracking-tight`. Keep the sidebar's current 17px size. |
| BR-9 | The palette doesn't change in this spec. The proposed "Sheen" accent (§10) is a separate decision for Frank. |

## 3. Geometry (source of truth)

All marks use `viewBox="0 0 64 64"`. Copy the path data exactly. The same data is in `specs/brand/marks/*.svg`.

```text
HEAD (A2 body)
M4 58 C10 44 18 30 27 22 C32 17.5 38 16 42 17.5 C49.5 19.5 55.5 23 60 28.5 C60.5 29.5 59.6 30.3 58.6 29.9 C53.5 29.2 48.5 30 43.5 31.8 C42.3 34.5 41 37.5 41 41.5 C41 48 43.5 53.5 46 58 Z

HEAD_EYE_HOLE (append to HEAD, evenodd)
M39.6 22.8 A3.1 3.1 0 1 0 33.4 22.8 A3.1 3.1 0 1 0 39.6 22.8 Z

HEAD_PUPIL: circle cx=36.5 cy=22.8 r=1.95
  (favicon-attention only: r=3.1, which fills the socket so the colour reads at 16px)

HEAD_HACKLE_CUTS (large variant only, size >= 64; append to HEAD, evenodd)
M39.6 40.7 C38.2 43.1 37.2 44.5 35.3 45.9 C35.2 46.4 35.5 46.9 36 46.9 C38 45.5 39.1 44 40.5 41.4 C40.5 40.9 40 40.6 39.6 40.7 Z M40.6 46.2 C39.2 48.1 38.2 49.5 36.3 50.9 C36.2 51.4 36.5 51.9 37 51.9 C39 50.5 40 49.1 41.4 47 C41.4 46.4 41 46.1 40.6 46.2 Z

PERCHED (A3 body)
M62 20.5 C58 16 53 12.5 48 12 C43 11.5 39 13.5 37 17 C32 22 24 30 17 40 L6 58 L9.5 59.5 L18 51 C24 48 31 46 36 43 C42 39 45.5 33 46.5 27.5 L46 25.5 C51 24 57 22.5 62 20.5 Z

PERCHED_EYE_HOLE (append, evenodd)
M45.8 17.6 A2.8 2.8 0 1 0 40.2 17.6 A2.8 2.8 0 1 0 45.8 17.6 Z

PERCHED_WING_CUT (append, evenodd)
M35.1 23.6 C30.6 29.7 24.4 37.7 18.5 45.5 C18.6 46.1 19.1 46.5 19.5 46.4 C25.5 38.5 31.6 30.5 36.1 24.3 C36 23.7 35.5 23.4 35.1 23.6 Z

PERCHED_PUPIL: circle cx=43 cy=17.6 r=1.75
PERCHED_LEGS: path "M30.5 46 L31.5 54 M36 43 L37 54", stroke currentColor, width 2.4, round caps
PERCH: rect x=20 y=53.5 w=32 h=3.4 rx=1.7 (the motion version widens it to x=18, w=34)
```

## 4. Tokens

Add these to `apps/web/src/styles/tokens.css` in all three theme blocks (`:root[data-theme="light"]`, `:root[data-theme="dark"]`, and `:root[data-theme="system"]` inside `@media (prefers-color-scheme: dark)`), and map them in the `@theme inline` block the way the others are mapped:

| Token | Light | Dark |
|---|---|---|
| `--mark-attention` | `#C2410C` | `#F97316` |
| `--mark-filed` | `#0F766E` | `#2DD4BF` |

The body of each mark uses `currentColor`. Where a mark sits on a solid tile (the toast tile, the app icon), set `color` to `var(--on-solid)`.

## 5. Components

Put them in `apps/web/src/components/brand/`.

### 5.1 `MuninnMark`

```ts
type MarkState = 'quiet' | 'attention' | 'filed';

interface MuninnMarkProps {
  size?: number;          // px, default 24
  state?: MarkState;      // resting eye colour, default 'quiet'
  playKey?: number;       // changing it plays the animation for `state` once (attention or filed); quiet never animates
  detail?: 'auto' | 'small' | 'large'; // auto = large at size >= 64
  title?: string;         // set it, and the mark is role="img" with <title>; leave it out, and it is aria-hidden
  className?: string;
}
```

- **Rendering.** One `<path fill="currentColor" fill-rule="evenodd">` (HEAD + HEAD_EYE_HOLE, plus HEAD_HACKLE_CUTS when large), then the pupil `<circle>`.
- **Pupil fill.**
  - `quiet`: `currentColor`
  - `attention`: `var(--mark-attention)`
  - `filed`: `var(--mark-filed)`
- **Animation.** When `playKey` changes, add the animation class for the current state. Remove it on `animationend`. A new `playKey` during a run restarts the animation.
- **Small sizes.** Below 32px, the needs-you animation drops the head rotation and keeps only the eye pop and one ring. The rings may overflow the box; use `overflow: visible`.
- **Priority.** If both are queued, attention wins over filed.

### 5.2 `MuninnPerched`

```ts
interface MuninnPerchedProps {
  size?: number;       // px, default 96; don't use below 64
  checking?: boolean;  // loops the checking animation while true
  title?: string;
}
```

- When `checking` turns false, let the current 4.8s cycle finish. Listen for `animationiteration`, then remove the class, so the bird never snaps back mid-hop.
- The viewBox for the animated version is `-6 -8 80 76`, which leaves room for the hop. The static version uses `0 0 64 64`.

### 5.3 `Wordmark`

A `MuninnMark` (28px) followed by `<span>muninn</span>` at 17px, semibold, `tracking-tight`, with a 10px gap. The mark is decorative here, because the text names it.

### 5.4 `useBrandFavicon(state: 'quiet' | 'attention')`

- Swaps the `href` of `<link rel="icon" type="image/svg+xml">` between `/favicon.svg` and `/favicon-attention.svg`.
- The filed state never shows in the favicon.
- Call it once, in `Shell`.

## 6. Motion

`specs/brand/motion/motion-preview.html` is the source of truth. Port its CSS to `apps/web/src/styles/brand.css`, imported from `main.tsx`, and keep the keyframe names (`ndHead`, `ndEye`, `ndRing`, `ckHop`, `ckPerch`, `ckBlink`, `flEye`, `flRing`). Replace the preview's `--ink` reference with `currentColor` where it's the mark body.

| Animation | Mark | Duration | Plays | Trigger |
|---|---|---|---|---|
| Needs you | A2 | 3.6s | once | The Now-lane count rises (n → n+1 or more). It doesn't play on first load. On load, show the static attention state. |
| Checking sources | A3 | 4.8s per cycle | loops | `inbox.poll.phase !== 'idle'` while the perched raven is on screen |
| Filed to memory | A2 | 4s | once | An action moves to `status === 'done'`, meaning it was written to the vault or Confluence (see the "Written" heading in `ActionPanel.tsx`). This includes dry-run writes to the sandbox. |

**What each one does** (summary only; the keyframes are authoritative):

- **Needs you:** the head snaps up by -11°, wobbles and holds at -8°. The eye pops to 1.9× in orange. Two orange rings ripple out to 6×, the second 0.28s behind. Then the head settles, but the eye **stays orange** while the Now count is above zero. In the preview the eye goes back to ink because the preview loops; in the app the resting state stays `attention`.
- **Checking sources:** the raven looks right, then crouches, jumps 10 units and turns in mid-air with `scaleX` going from 1 to -1. It lands with a squash, looks left and hops back. The perch dips 1.6 units on each landing. It blinks twice per cycle: the pupil grows to fill the socket, so the eye reads as closed.
- **Filed:** the eye pops to 1.9× in teal, one teal ring ripples out, the eye holds teal for about 1.2s and then goes back to the resting state. There is no head movement.

**Rules:**

- Animate only `transform`, `opacity` and `fill`, never layout properties.
- With `prefers-reduced-motion: reduce`, there are no animations. The pupil shows the resting colour straight away, and filed shows teal for 1.5s and then returns to rest.
- One animation at a time per mark instance.
- The same rules apply in dark mode, because the colours come from the tokens.

## 7. Placements

| ID | Where | Change |
|---|---|---|
| BR-10 | `apps/web/index.html` | `<title>Muninn</title>`. Add `<link rel="icon" type="image/svg+xml" href="/favicon.svg">`, `<link rel="alternate icon" type="image/png" href="/favicon-32.png">` and `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`. |
| BR-11 | `apps/web/public/` (new; Vite serves it at `/`) | Copy `favicon.svg` and `favicon-attention.svg` from `specs/brand/marks/`, `favicon-32.png` from `png/`, and `png/apple-touch-icon-180.png` as `apple-touch-icon.png`. Check that `dist/` and `dist-mock/` both contain them. |
| BR-12 | `Shell.tsx`, sidebar header (around line 259) | **Expanded:** `Wordmark`, then the toggle. **Collapsed:** the toggle is replaced by a 28px `MuninnMark` inside the existing `IconButton`, with `label="Expand sidebar"` and `title="Expand sidebar ([)"`. Keep the header at 64px in both states. |
| BR-13 | `Shell.tsx`, the mark's state | `attention` when the count of items with `lane === 'now'` (using the same live-source filter as `count` on line 225) is above 0; otherwise `quiet`. Bump `playKey` when that count goes up. Feed the same state to `useBrandFavicon`. Note that the existing `count` includes `today` and `file`; don't reuse it as it is. |
| BR-14 | `Shell.tsx`, filed | Subscribe to a small in-memory brand event (`emitFiled()`, from a new `lib/brandEvents.ts`). Fire it where an action becomes `done`. On it, play `filed`. |
| BR-15 | `Toasts.tsx` (around line 73), OS-notification card | Replace the "W" letter tile with a `MuninnMark` (22px, `color: var(--on-solid)`) on the existing `bg-solid` tile. Change the title text from "Work OS · Now" to "Muninn · Now". |
| BR-16 | `pages/Inbox.tsx`, `InboxZero` | Replace the teal check badge with `MuninnPerched` (size 96, `checking={inbox.poll.phase !== 'idle'}`, decorative). Keep the heading, the copy and `data-testid="inbox-zero"` as they are. |
| BR-17 | `pages/Inbox.tsx`, `FirstRun` | Replace the inbox icon tile with `MuninnPerched` (size 72, `checking={busy}`). Change the heading to "Muninn hasn’t polled Slack yet". |
| BR-18 | `pages/SystemScreens.tsx` | Only the strings change (§8). Keep the existing icons. |

## 8. Rename scope

**Change** every *user-facing* "Work OS" to "Muninn":

- **Web:** all `document.title` strings (`· Work OS` becomes `· Muninn`), the sidebar, toasts, system screens, the Inbox, Settings help text, `ui.tsx` phase tooltips, and any mock seed text that shows in the UI.
- **Server:** user-visible messages in `notify/alerts.ts`, `net/health.ts`, `runtime/refuse.ts` and the `main.ts` log line, plus any other string that reaches the UI, a notification or stderr.
- **Docs:** every page in `app/docs/guide/*.md`, about 39 mentions. Bump each page's `updated` date, as `specs/CLAUDE.md` requires.
- **Tests:** e2e specs that assert on the name (`shell.spec.ts`, `drawer.spec.ts`, `guide.spec.ts`, `e2e-server/server.spec.ts`) and server tests that assert message text.
- **Project docs:**
  - `app/DESIGN.md`: the title, and a new "Brand" section that summarises §2–§6 and links here.
  - `specs/PLAN.md`: "Working name: Muninn (was Work OS)".
  - `specs/CLAUDE.md`: the heading, and a pointer to this spec.
- **Code comments:** update them when you're in the file anyway. There's no need to hunt for them.

**Don't change** these in this spec. Each needs a migration, and they're tracked as follow-ups (§10):

- Package names `work-os` and `@work-os/*`, and `package-lock.json`
- The data directories `~/WorkOS-data` and `~/WorkOS-data-dev`, the env var `WORKOS_DATA_DIR`, and `~/Library/Application Support/WorkOS`
- The launchd label `com.polestar.workos` and its plist template
- Keychain service and account names
- Notification group IDs `work-os-health-*`
- The repo folder `WORK_OS`

**Check:** `rg -n "Work OS" app specs --glob '!**/node_modules/**' --glob '!**/dist*/**'` returns only code comments, this spec's own references to the old name, and `PLAN.md` history.

## 9. Milestones and acceptance

Build them in order, and don't start one until the previous one passes.

### B1 Assets, tokens and components (BR-1–BR-11)

> As Frank, I want Muninn's mark in the browser tab and available as components, so that the app looks like itself everywhere.

- **Given** the built app, **when** I open it in light or dark mode, **then** the tab shows the A2 favicon, and the dark variant appears under `prefers-color-scheme: dark`.
- **Given** `<MuninnMark state="attention" />`, **when** it renders, **then** the eye is `--mark-attention`, the eye ring is transparent (the page background shows through), and the element is `aria-hidden`.
- **Given** a size of 64 or more with `detail="auto"`, **then** the throat cut lines appear; below 64 they don't.
- **Unit tests:** state → fill mapping; the `title` prop gives `role="img"`; `playKey` adds and then removes the animation class; the large and small path switch.

### B2 Placements and state wiring (BR-12–BR-17)

> As Frank, I want the raven's eye to tell me at a glance whether anything needs me.

- **Given** no Now items, **when** I look at the sidebar or the tab, **then** the eye is quiet.
- **Given** a new Now item arrives (Scenarios drawer), **then** the sidebar mark plays "needs you" once, the eye stays orange, and the favicon switches to `favicon-attention.svg`.
- **Given** the last Now item is done or snoozed, **then** the eye and the favicon go back to quiet.
- **Given** I approve a vault or Confluence draft and it's written (including dry-run), **then** the sidebar mark plays "filed" once and then returns to its resting state.
- **Given** the collapsed sidebar, **then** the header shows only the mark, and clicking it or pressing `[` expands the sidebar.
- **Given** Inbox zero during a poll, **then** the perched raven plays "checking sources". When the poll ends, it finishes its cycle and stops.
- **e2e:** add these to `shell.spec.ts` and the Inbox specs: the favicon `href` switches; `inbox-zero` contains an `svg[aria-hidden]`; the wordmark text is "muninn".

### B3 Motion polish and reduced motion (BR-6, BR-7)

- **Given** `prefers-reduced-motion: reduce` (Playwright `reducedMotion: 'reduce'`), **when** a Now item arrives, **then** there's no transform animation and the eye shows orange straight away.
- Side by side, the timings match `motion-preview.html`. Frank signs this off by eye.
- There's no layout shift: the sidebar header height stays at 64px during every animation.

### B4 Rename (BR-1, §8)

- **Given** any screen, notification, system screen or guide page, **then** the product is called "Muninn".
- The check command in §8 passes.
- `npm test`, `npm run e2e`, `npm run e2e:server` and `npm run lint` all pass.
- Regenerate the screenshots in `app/screenshots/` that show the sidebar, Inbox zero or the guide.

## 10. Follow-ups (not in this spec)

| ID | Item | Note |
|---|---|---|
| BR-F1 | **Sheen accent.** Replace the stock Tailwind blue (`--accent #1D4ED8`) with ink for primary actions and Sheen `#3F3A9E` (dark `#A5A0F0`) for links and selection. | It touches about 80 `accent` uses in `.tsx` files. **Needs Frank's go-ahead.** It's shown on the canvas Palette board. |
| BR-F2 | **Infrastructure rename.** Packages, data directory, env var, Application Support folder, Keychain. | Needs a one-off migration script and a dry run, under the existing single-instance and lock rules. |
| BR-F3 | **launchd label.** Rename `com.polestar.workos` to an employer-neutral label, such as `dev.muninn.agent`. | Muninn is meant to move with Frank between jobs. Uninstall and reinstall the agent as part of BR-F2. |
| BR-F4 | **macOS notification icon.** `terminal-notifier -appIcon` or `-contentImage` with `app-icon-512.png`. | Check that the flag still works on the current macOS before relying on it. |
| BR-F5 | **Nav icon refresh.** Move to one icon set on a 24px grid with a 1.5px stroke and round caps, to match the mark. | Only after B4. Today's icons use a 2px stroke. |
