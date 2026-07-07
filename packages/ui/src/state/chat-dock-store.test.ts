/**
 * Unit tests for the chat-dock store: detent transitions, tap-toggle memory,
 * release physics (collapse/maximize zones + center magnet), persistence, and
 * the idiom-gated agent auto-split.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DOCK_MAX_RATIO,
  DOCK_MIN_RATIO,
  ensureChatDockSplitForView,
  getChatDockState,
  releaseChatDockDrag,
  resetChatDockForTests,
  resolveDockRelease,
  setChatDockDetent,
  setChatDockIdiomActive,
  setChatDockSplitRatio,
  toggleChatDockSplit,
} from "./chat-dock-store";

// The store persists via localStorage; this suite may run in a node (non-DOM)
// vitest environment, so give it a real in-memory Storage shim.
const backing = new Map<string, string>();
if (typeof globalThis.localStorage === "undefined") {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => void backing.set(k, String(v)),
      removeItem: (k: string) => void backing.delete(k),
      clear: () => backing.clear(),
    },
  });
}

beforeEach(() => resetChatDockForTests());
afterEach(() => resetChatDockForTests());

describe("chat-dock store", () => {
  it("boots maximized-chat-first with a centered remembered split", () => {
    expect(getChatDockState()).toEqual({
      detent: "maximized",
      lastDetent: "split",
      splitRatio: 0.5,
    });
  });

  it("tap toggles maximized ↔ split and remembers the other side", () => {
    toggleChatDockSplit();
    expect(getChatDockState().detent).toBe("split");
    expect(getChatDockState().lastDetent).toBe("maximized");
    toggleChatDockSplit();
    expect(getChatDockState().detent).toBe("maximized");
    expect(getChatDockState().lastDetent).toBe("split");
  });

  it("tap from collapsed returns to the last meaningful detent, never jumping two", () => {
    setChatDockDetent("split");
    setChatDockDetent("collapsed");
    toggleChatDockSplit();
    expect(getChatDockState().detent).toBe("split");
    setChatDockDetent("maximized");
    setChatDockDetent("collapsed");
    toggleChatDockSplit();
    expect(getChatDockState().detent).toBe("maximized");
  });

  it("clamps the split ratio into the usable band", () => {
    setChatDockSplitRatio(0.05);
    expect(getChatDockState().splitRatio).toBe(DOCK_MIN_RATIO);
    setChatDockSplitRatio(0.95);
    expect(getChatDockState().splitRatio).toBe(DOCK_MAX_RATIO);
    setChatDockSplitRatio(Number.NaN);
    expect(getChatDockState().splitRatio).toBe(0.5);
  });

  it("release physics: edge zones commit collapse/maximize, magnet snaps center", () => {
    expect(resolveDockRelease(0.05, 1200).detent).toBe("collapsed");
    expect(resolveDockRelease(0.92, 1200).detent).toBe("maximized");
    // 64px magnet on a 1200px shell = ±0.0533 around 0.5.
    expect(resolveDockRelease(0.53, 1200)).toEqual({
      detent: "split",
      ratio: 0.5,
    });
    expect(resolveDockRelease(0.62, 1200)).toEqual({
      detent: "split",
      ratio: 0.62,
    });
  });

  it("releaseChatDockDrag commits detent + rest ratio", () => {
    releaseChatDockDrag(0.62, 1200);
    expect(getChatDockState().detent).toBe("split");
    expect(getChatDockState().splitRatio).toBe(0.62);
    releaseChatDockDrag(0.02, 1200);
    expect(getChatDockState().detent).toBe("collapsed");
    // The remembered split ratio survives a collapse.
    expect(getChatDockState().splitRatio).toBe(0.62);
  });

  it("agent auto-split only fires in-idiom and only from maximized", () => {
    ensureChatDockSplitForView();
    expect(getChatDockState().detent).toBe("maximized"); // idiom inactive
    setChatDockIdiomActive(true);
    ensureChatDockSplitForView();
    expect(getChatDockState().detent).toBe("split");
    setChatDockDetent("collapsed");
    ensureChatDockSplitForView();
    expect(getChatDockState().detent).toBe("collapsed"); // user's choice wins
  });

  it("persists across store resets via localStorage", () => {
    setChatDockDetent("split");
    setChatDockSplitRatio(0.62);
    // Simulate a reload: drop the globalThis store but keep localStorage.
    const g = globalThis as Record<PropertyKey, unknown>;
    delete g[Symbol.for("elizaos.ui.chat-dock-store")];
    expect(getChatDockState()).toMatchObject({
      detent: "split",
      splitRatio: 0.62,
    });
  });
});
