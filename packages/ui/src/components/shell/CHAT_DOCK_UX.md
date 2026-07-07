# Chat Dock UX — maximized-chat-first shell with the vertical divider pill

Status: design doc (pre-implementation). Owner: shell lane. Companion to
[`__e2e__/CHAT_SHEET_STATE_MATRIX.md`](./__e2e__/CHAT_SHEET_STATE_MATRIX.md),
which stays authoritative for the touch bottom-sheet; this doc defines the
**desktop/web docked idiom** and the shared state that keeps both honest.

## 1. The idea in one paragraph

Chat is the primary surface. On a wide pointer display the app boots into a
**maximized chat** that fills the window. On its right edge sits a **vertical
pill** — the same capsule as the floating chat pill, rotated 90° — which is the
handle of a movable divider. Tap it to split the window (chat left, launcher or
active view right); drag it to set the split; drag it all the way left to
collapse chat to a thin edge pill (view/launcher full screen); drag it all the
way right to re-maximize chat. When the **agent** navigates to a view while chat
is maximized, the shell auto-splits so the view appears beside the conversation
instead of underneath it. One control, one continuum, no modes to learn: the
divider's position *is* the state.

## 2. Two idioms, one logical state

| | **Sheet idiom** (touch / narrow) | **Dock idiom** (pointer + wide) |
|---|---|---|
| Axis | vertical, bottom-anchored | horizontal, left-anchored |
| Chat geometry | sheet grows UP over the view | pane full-height, grows RIGHT |
| Handle | horizontal grabber / floating pill | vertical divider pill |
| View placement | underneath the sheet | beside the chat pane |
| Detents | `pill · input · half · full(+maximized)` | `collapsed · split · maximized` |

**Idiom selection** (runtime, reactive):
`dock = pointer is fine AND hover is available AND innerWidth ≥ 900px`.
Everything else — phones, tablets in portrait, short-landscape phones, narrow
desktop windows — keeps the existing bottom sheet untouched. A window resized
across the boundary re-projects the same logical state (mapping in §6).

## 3. Dock idiom — states and geometry

Three detents on a single horizontal continuum. `splitX` = chat pane width as a
fraction of the shell width.

```
COLLAPSED                     SPLIT                        MAXIMIZED
┌─┬─────────────────┐   ┌─────────┬─┬─────────┐   ┌─────────────────┬─┐
│▐│                 │   │         │▐│         │   │                 │▐│
│▐│  view/launcher  │   │  chat   │▐│  view/  │   │      chat       │▐│
│▐│                 │   │         │▐│launcher │   │                 │▐│
└─┴─────────────────┘   └─────────┴─┴─────────┘   └─────────────────┴─┘
 splitX = 0              splitX ∈ [0.28, 0.72]     splitX = 1
```

- **MAXIMIZED** (boot default on web): chat pane fills the shell. The vertical
  pill hugs the right edge. The right pane is fully off-stage (`inert`,
  `aria-hidden`), not unmounted — same warm-mount discipline as
  `HomeLauncherSurface`'s offscreen half.
- **SPLIT**: chat left, full height; right pane hosts the **launcher** when no
  view is active, or the **active view** (including the existing
  `ViewLayoutSurface` view↔view tiles, which nest inside the right pane
  unchanged). Ratio is continuous within `[0.28, 0.72]`, magnetized to 0.5
  (`SHEET_DETENT_MAGNET`-style, ±64px), remembered per session.
- **COLLAPSED**: chat shrinks to the left-edge pill; view/launcher takes the
  full width. The composer is gone — the pill is the summon affordance, exactly
  like the floating pill's CLOSED state today. Unread activity in the collapsed
  chat shows the same badge treatment as the floating pill.

The right pane always has content: **launcher is the fallback**. There is no
"empty gray pane" state — collapsing a view reveals the launcher, never a void.

### The vertical pill (the minimal control)

Deliberately the same object the user already knows, rotated:

- Same capsule material (liquid-glass, `WALLPAPER_GLASS` treatment on
  wallpaper), ~6px visual width × ~128px tall, vertically centered on the
  divider, `border-radius: 999px`.
- Hit area ≥ 44px wide (invisible padding), full pane height is *not* draggable
  — only the pill region, so view content beside it keeps its pointer events.
- Cursor `col-resize` on hover; hover swells the capsule slightly (scale, not
  color — orange stays accent-only per the color rules).
- Renders `data-dock-detent="collapsed|split|maximized"` and
  `data-dock-ratio` for tests, mirroring `data-chat-state`/`data-detent`.

### Gestures & clicks — the transition matrix

| From | Tap pill | Drag pill | Keyboard |
|---|---|---|---|
| MAXIMIZED | → SPLIT (last ratio) | left past magnet → SPLIT; long haul past `0.28` → COLLAPSED (mid-drag commit, same `maxPullRawRef`-style intent) | `Esc` in composer → SPLIT if a view is pending |
| SPLIT | → MAXIMIZED | right edge zone → MAXIMIZED; left edge zone → COLLAPSED; otherwise rests free (free-ratio ≙ `freeH`) | `⌘⇧L` toggle split |
| COLLAPSED | → SPLIT (last ratio) | right → SPLIT, long haul ≥80% width → MAXIMIZED (the "long-haul" rule transposed) | `⌘K`/focus composer → SPLIT |

Tap therefore always toggles between the two *most recently meaningful* states
(`detent ↔ lastDetent`), which is what "clicking the | splits or unsplits"
means concretely: from MAXIMIZED it reveals the view; from SPLIT it gives chat
the room back; from COLLAPSED it brings chat back at the remembered ratio. Tap
never jumps two detents.

Drag physics are the transposed sheet physics — reuse `usePullGesture`'s core
(`resolvePull`/axis lock/rAF coalescing) with a horizontal axis, a MotionValue
for `splitX` (1:1 finger tracking, no React re-render per frame), detent
magnets on release, and the same mid-drag commit + hysteresis re-arm pattern
(`commitMaximizeMidDrag` / `dragMaxArmedRef`) so a decisive fling commits while
the pointer is still down.

## 4. Agent-driven view changes

When the agent (or a tile tap, deep link, `eliza:navigate:view`) activates a
view:

- **MAXIMIZED** → auto-**SPLIT** at the remembered ratio; the view slides in on
  the right. The conversation never disappears mid-answer.
- **SPLIT** → right pane swaps content in place.
- **COLLAPSED** → right pane swaps; chat stays collapsed (the user chose that).
- Closing the last view (existing `ViewLayoutSurface` close, or "go home")
  returns the right pane to the launcher — the detent does not change.

Symmetric rule for the sheet idiom (unchanged behavior today): view changes
render underneath; the sheet's detent is untouched.

## 5. Boot defaults

- **Dock idiom (web/desktop):** boot into **MAXIMIZED chat** with the composer
  focused. First-run keeps its pinned-open onboarding behavior.
- **Sheet idiom (mobile):** unchanged — boots to `input` (or first-run full).
- Detent + ratio persist across reloads (per §6); a returning user who left the
  app in SPLIT comes back to SPLIT.

## 6. Shared state — one store, two projections

New `state/chat-dock-store.ts` (external store, same pattern as
`shell-surface-store.ts`, but **persisted** via the `ui-preferences` /
localStorage pattern):

```ts
interface ChatDockState {
  detent: "collapsed" | "split" | "maximized";
  lastDetent: "split" | "maximized";   // tap-toggle target
  splitRatio: number;                   // last meaningful SPLIT ratio
}
```

- The dock idiom renders directly from this store; `splitX` MotionValue is the
  animated projection of it.
- The sheet idiom keeps `ChatMode` as-is (it is finger-physics state, heavily
  tuned — do not disturb), but **cross-maps at idiom switches only**:
  `maximized ↔ full+maximized`, `split ↔ half`, `collapsed ↔ pill`. No live
  two-way sync during a session in one idiom; the mapping runs when the idiom
  boundary is crossed (resize/rotate) so a maximized chat stays maximized.
- The auto-split-on-view-navigate hook lives in the navigate handler
  (`createNavigateViewHandler`), not in the overlay — the store is the seam, so
  the agent path and the UI path drive the same state.

Simplification opportunities this unlocks (do while implementing, not after):
- `HomePill.tsx` + `AssistantOverlay` are NOT vestigial — they are the chat
  surface of the desktop chat-overlay window (`ChatOverlayShell`) and the OS
  kiosk shell (`KioskShell`), both of which sit outside the dock idiom. They
  stay.
- The right pane reuses `HomeLauncherSurface`/`ViewRouter` mounts as-is; no new
  router. The dock is a *layout* around existing surfaces, not a new surface.
- Overlay z-9000 float becomes unnecessary in dock idiom: the chat pane is real
  layout. The overlay component stays the single implementation; it gains a
  `presentation: "sheet" | "dock"` wrapper rather than a fork.

## 7. Responsiveness & platforms

- **Resize across 900px**: re-project via the §6 mapping; animate nothing
  (idiom switches are teleports, transitions within an idiom are animated).
- **Short-landscape phones** keep the compact-corner sheet treatment (#14173).
- **Desktop (Electrobun)**: identical to web dock; the tray `TrayLauncher`
  popover is untouched.
- **Reduced motion**: detent changes become instant; the pill remains fully
  functional via tap + keyboard.
- **A11y**: divider pill is `role="separator"` with
  `aria-orientation="vertical"`, `aria-valuenow=ratio`, arrow-key resize
  (←/→ = 4%, Home/End = collapse/maximize), and it is a real focusable button
  for the tap-toggle. 44×44 tap floor certified via `widget-cert`.

## 8. Test plan

- Transposed e2e suite `run-chat-dock-e2e.mjs` + `chat-dock-fixture.tsx`
  mirroring the sheet suites: drag detents (mouse), tap-toggle matrix, mid-drag
  commit, agent-navigate auto-split, idiom-switch remapping, persistence
  reload.
- State matrix doc: extend `CHAT_SHEET_STATE_MATRIX.md` with the dock table
  from §3 once behavior lands (keep one authoritative matrix).
- `audit:app` desktop screenshots for all three detents; a11y keyboard pass.

## 9. Phasing

1. **P0 — store + layout**: `chat-dock-store`, dock wrapper in `App.tsx`
   (chat pane + right pane + static divider), boot-maximized on dock idiom,
   tap-toggle. Launcher as right-pane fallback.
2. **P1 — physics**: horizontal `usePullGesture` wiring, MotionValue ratio,
   magnets, mid-drag commits, collapsed edge pill.
3. **P2 — integration**: agent auto-split, idiom-switch remapping,
   persistence, legacy-pill cleanup, e2e + evidence loop (≥5 audit iterations).
