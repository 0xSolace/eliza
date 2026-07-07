/**
 * Docked-chat idiom e2e (CHAT_DOCK_UX.md): boots the chat-dock fixture in
 * headless Chromium and drives the REAL divider pill + store through the whole
 * continuum — boot-maximized, tap toggle (split ↔ maximized ↔ back from
 * collapsed), 1:1 drag with edge-zone commits and the center magnet, keyboard
 * operation of the separator, localStorage persistence across a reload, and
 * the agent auto-split hook. Screenshots land in output-dock/.
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

import {
  stubElizaCore,
  stubNodeBuiltins,
  writeFixturePage,
} from "../../../testing/e2e-runner/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "output-dock");
await mkdir(outDir, { recursive: true });

let failures = 0;
function assert(cond, msg) {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures += 1;
  return cond;
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const url = await writeFixturePage({
  entry: join(here, "chat-dock-fixture.tsx"),
  outDir,
  htmlName: "chat-dock.html",
  title: "chat dock e2e",
  plugins: [stubElizaCore(), stubNodeBuiltins()],
  processShim: true,
  background: "#0a0d16",
  headHtml: "<style>.bg-bg{background-color:#0a0d16}</style>",
});

const W = 1440;
const H = 900;

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  reducedMotion: "reduce",
});
const p = await ctx.newPage();
p.on("console", (m) => {
  if (m.type() === "error") console.log(`[pageerror] ${m.text()}`);
});
await p.goto(url, { waitUntil: "domcontentloaded" });

const dockState = () => p.evaluate(() => window.__dockState?.());
const paneWidth = () =>
  p.evaluate(
    () =>
      document
        .querySelector('[data-testid="chat-dock-pane"]')
        ?.getBoundingClientRect().width ?? 0,
  );
const dividerX = () =>
  p.evaluate(() => {
    const el = document.querySelector('[data-testid="chat-dock-divider"]');
    const r = el?.getBoundingClientRect();
    return r ? r.left + r.width / 2 : -1;
  });
const snap = (name) =>
  p.screenshot({ path: join(outDir, `${name}.png`), fullPage: false });

// ===== 1. Boot: maximized-chat-first =====
await p.waitForSelector('[data-testid="chat-dock-pane"]');
await p.waitForSelector('[data-testid="chat-sheet"]');
let s = await dockState();
assert(s?.detent === "maximized", `boots MAXIMIZED (got ${s?.detent})`);
assert(near(await paneWidth(), W, 2), "chat pane fills the shell at boot");
assert(
  (await p
    .getByTestId("chat-sheet")
    .getAttribute("data-chat-state")) === "MAXIMIZED",
  "overlay is pinned MAXIMIZED inside the dock pane",
);
assert(near(await dividerX(), W, 24), "divider pill hugs the right edge");
await snap("01-boot-maximized");

// ===== 2. Tap the pill → SPLIT at the remembered (centered) ratio =====
const divider = p.getByTestId("chat-dock-divider");
await divider.click();
s = await dockState();
assert(s?.detent === "split", `tap → SPLIT (got ${s?.detent})`);
assert(near(await paneWidth(), W * 0.5, 8), "split pane is half the shell");
assert(
  (await p.getByTestId("dock-right-pane").boundingBox())?.width > W * 0.45,
  "right pane hosts the launcher beside the chat",
);
await snap("02-tap-split");

// ===== 3. Tap again → back to MAXIMIZED (detent ↔ lastDetent) =====
await divider.click();
s = await dockState();
assert(s?.detent === "maximized", "second tap → MAXIMIZED again");

// ===== 4. Drag to ~62% → free split ratio (outside the magnet) =====
const dx = Math.min(W - 2, await dividerX());
await p.mouse.move(dx, H / 2);
await p.mouse.down();
for (let i = 1; i <= 8; i++) {
  await p.mouse.move(dx + ((W * 0.62 - dx) * i) / 8, H / 2);
}
await p.mouse.up();
s = await dockState();
assert(
  s?.detent === "split" && near(s.splitRatio, 0.62, 0.02),
  `drag rests at a free ratio (${s?.detent} @ ${s?.splitRatio})`,
);
await snap("03-drag-free-ratio");

// ===== 5. Drag near center → magnet snaps to 0.5 =====
await p.mouse.move(Math.min(W - 2, await dividerX()), H / 2);
await p.mouse.down();
await p.mouse.move(W * 0.52, H / 2, { steps: 6 });
await p.mouse.up();
s = await dockState();
assert(
  s?.detent === "split" && s.splitRatio === 0.5,
  `center magnet snaps to 0.5 (got ${s?.splitRatio})`,
);

// ===== 6. Drag to the left edge → COLLAPSED; pane unmounts =====
await p.mouse.move(Math.min(W - 2, await dividerX()), H / 2);
await p.mouse.down();
await p.mouse.move(W * 0.05, H / 2, { steps: 8 });
await p.mouse.up();
s = await dockState();
assert(s?.detent === "collapsed", `edge drag → COLLAPSED (got ${s?.detent})`);
assert(
  (await p.locator('[data-testid="chat-dock-pane"]').count()) === 0,
  "collapsed chat pane is off-stage",
);
assert(near(await dividerX(), 0, 24), "divider pill waits at the left edge");
await snap("04-collapsed");

// ===== 7. Tap from COLLAPSED → returns to the remembered SPLIT =====
await divider.click();
s = await dockState();
assert(
  s?.detent === "split" && s.splitRatio === 0.5,
  `tap from collapsed → remembered SPLIT (${s?.detent} @ ${s?.splitRatio})`,
);
await snap("05-collapsed-tap-restores-split");

// ===== 8. Keyboard: separator is operable =====
const pill = p.locator('[role="separator"]');
await pill.focus();
await p.keyboard.press("End");
s = await dockState();
assert(s?.detent === "maximized", "End key → MAXIMIZED");
await p.keyboard.press("ArrowLeft");
s = await dockState();
assert(s?.detent === "split", "ArrowLeft from maximized → SPLIT");
await p.keyboard.press("ArrowLeft");
s = await dockState();
assert(near(s?.splitRatio ?? 0, 0.46, 0.001), "ArrowLeft resizes by 4%");
await p.keyboard.press("Home");
s = await dockState();
assert(s?.detent === "collapsed", "Home key → COLLAPSED");
await p.keyboard.press("Enter");
s = await dockState();
assert(s?.detent === "split", "Enter toggles back open");

// ===== 9. Agent auto-split: maximized → view opens → split =====
await pill.focus();
await p.keyboard.press("End");
await p.evaluate(() => window.__ensureDockSplitForView?.());
s = await dockState();
assert(s?.detent === "split", "agent view-navigation auto-splits a maximized chat");
// ...but respects a user collapse.
await p.keyboard.press("Home");
await p.evaluate(() => window.__ensureDockSplitForView?.());
s = await dockState();
assert(s?.detent === "collapsed", "auto-split respects a collapsed chat");

// ===== 10. Persistence: reload restores the layout =====
await divider.click(); // collapsed -> split (persisted)
await p.reload({ waitUntil: "domcontentloaded" });
await p.waitForSelector('[data-testid="chat-dock-divider"]');
s = await dockState();
assert(
  s?.detent === "split",
  `reload restores the persisted detent (got ${s?.detent})`,
);
await snap("06-reload-persisted-split");

await browser.close();
if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\nchat-dock e2e: all assertions passed");
