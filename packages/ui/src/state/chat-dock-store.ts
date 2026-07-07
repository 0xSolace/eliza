/**
 * Chat-dock store — the single source of truth for the desktop/web docked-chat
 * idiom (see components/shell/CHAT_DOCK_UX.md).
 *
 * On a wide pointer display the chat is a real full-height LEFT pane (not the
 * floating bottom sheet) with three detents on one horizontal continuum:
 * `collapsed` (edge pill, view/launcher full width), `split` (chat left, view
 * right at `splitRatio`), and `maximized` (chat fills the shell — the web boot
 * default). The vertical divider pill (ChatDockDivider) and the agent's
 * view-navigation path both drive THIS store, so tap/drag and agent behavior
 * can never disagree.
 *
 * Module-level store shared via globalThis + useSyncExternalStore (same
 * pattern as shell-surface-store.ts), persisted to localStorage so a returning
 * user gets the layout they left. The touch bottom-sheet keeps its own
 * finger-physics state inside ContinuousChatOverlay; this store only governs
 * the dock idiom, and `setChatDockIdiomActive` gates the agent-driven
 * auto-split so narrow/touch layouts are never affected.
 */
import { logger } from "@elizaos/logger";
import * as React from "react";

export type ChatDockDetent = "collapsed" | "split" | "maximized";

export interface ChatDockState {
  readonly detent: ChatDockDetent;
  /** The tap-toggle target: the last *other* meaningful detent. */
  readonly lastDetent: "split" | "maximized";
  /** Last meaningful SPLIT ratio (chat-pane fraction of the shell width). */
  readonly splitRatio: number;
}

// Split ratio bounds: within SPLIT the chat pane stays a usable reading column
// and the view pane stays a usable canvas.
export const DOCK_MIN_RATIO = 0.28;
export const DOCK_MAX_RATIO = 0.72;
// Release zones outside the SPLIT band commit the adjacent detent.
export const DOCK_COLLAPSE_BELOW = 0.14;
export const DOCK_MAXIMIZE_ABOVE = 0.86;
// Center magnet (px), same feel as the sheet's SHEET_DETENT_MAGNET.
export const DOCK_CENTER_MAGNET_PX = 64;

const STORAGE_KEY = "eliza.chat-dock.v1";

const DEFAULT_STATE: ChatDockState = {
  // Web boots maximized-chat-first; persisted state (below) wins for returns.
  detent: "maximized",
  lastDetent: "split",
  splitRatio: 0.5,
};

interface DockStore {
  state: ChatDockState;
  listeners: Set<() => void>;
  /** True while the dock idiom is rendering (wide pointer display). */
  idiomActive: boolean;
}

function clampRatio(r: number): number {
  if (!Number.isFinite(r)) return DEFAULT_STATE.splitRatio;
  return Math.min(DOCK_MAX_RATIO, Math.max(DOCK_MIN_RATIO, r));
}

function readPersisted(): ChatDockState {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<ChatDockState>;
    const detent =
      parsed.detent === "collapsed" ||
      parsed.detent === "split" ||
      parsed.detent === "maximized"
        ? parsed.detent
        : DEFAULT_STATE.detent;
    const lastDetent =
      parsed.lastDetent === "split" || parsed.lastDetent === "maximized"
        ? parsed.lastDetent
        : detent === "maximized"
          ? "split"
          : "maximized";
    return {
      detent,
      lastDetent,
      splitRatio: clampRatio(Number(parsed.splitRatio)),
    };
  } catch {
    // error-policy:J3 untrusted-input sanitizing — a corrupt persisted blob
    // yields the explicit default layout, never a crash on boot.
    return DEFAULT_STATE;
  }
}

function store(): DockStore {
  const g = globalThis as Record<PropertyKey, unknown>;
  const k = Symbol.for("elizaos.ui.chat-dock-store");
  const existing = g[k] as DockStore | undefined;
  if (existing) return existing;
  const created: DockStore = {
    state: readPersisted(),
    listeners: new Set(),
    idiomActive: false,
  };
  g[k] = created;
  return created;
}

function commit(s: DockStore, next: ChatDockState): void {
  const prev = s.state;
  if (
    prev.detent === next.detent &&
    prev.lastDetent === next.lastDetent &&
    prev.splitRatio === next.splitRatio
  ) {
    return;
  }
  s.state = next;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (error) {
    // error-policy:J6 best-effort persistence — private mode / quota denial
    // must not break the live layout; the session state stays authoritative.
    logger.debug({ error }, "Chat dock persistence failed");
  }
  for (const l of s.listeners) l();
}

// ── Imperative actions (callable from gesture handlers + the navigate path) ──

export function setChatDockDetent(detent: ChatDockDetent): void {
  const s = store();
  const prev = s.state;
  const lastDetent =
    prev.detent !== detent &&
    (prev.detent === "split" || prev.detent === "maximized")
      ? prev.detent
      : prev.lastDetent;
  commit(s, { ...prev, detent, lastDetent });
}

/**
 * Tap on the divider pill: toggle between the current detent and the last
 * *other* meaningful state. Never jumps two detents — from COLLAPSED it
 * returns to the remembered SPLIT/MAXIMIZED, from SPLIT/MAXIMIZED it swaps to
 * the other one.
 */
export function toggleChatDockSplit(): void {
  const s = store();
  const { detent, lastDetent } = s.state;
  if (detent === "collapsed") {
    setChatDockDetent(lastDetent);
    return;
  }
  setChatDockDetent(detent === "maximized" ? "split" : "maximized");
}

export function setChatDockSplitRatio(ratio: number): void {
  const s = store();
  commit(s, { ...s.state, splitRatio: clampRatio(ratio) });
}

/**
 * Resolve a divider release: raw ratio + shell width → the detent (and, for
 * SPLIT, the rest ratio with the center magnet applied). Pure so the release
 * physics are unit-testable without a DOM.
 */
export function resolveDockRelease(
  rawRatio: number,
  shellWidthPx: number,
): { detent: ChatDockDetent; ratio: number } {
  if (rawRatio <= DOCK_COLLAPSE_BELOW) {
    return { detent: "collapsed", ratio: clampRatio(rawRatio) };
  }
  if (rawRatio >= DOCK_MAXIMIZE_ABOVE) {
    return { detent: "maximized", ratio: clampRatio(rawRatio) };
  }
  const clamped = clampRatio(rawRatio);
  const magnetR = shellWidthPx > 0 ? DOCK_CENTER_MAGNET_PX / shellWidthPx : 0;
  const ratio = Math.abs(clamped - 0.5) <= magnetR ? 0.5 : clamped;
  return { detent: "split", ratio };
}

/** Commit a divider release into the store. */
export function releaseChatDockDrag(
  rawRatio: number,
  shellWidthPx: number,
): void {
  const { detent, ratio } = resolveDockRelease(rawRatio, shellWidthPx);
  if (detent === "split") setChatDockSplitRatio(ratio);
  setChatDockDetent(detent);
}

/**
 * Agent/tile view navigation hook: a MAXIMIZED chat auto-splits so the view
 * appears BESIDE the conversation instead of underneath it. SPLIT swaps the
 * right pane in place; COLLAPSED respects the user's choice and stays
 * collapsed. No-op when the dock idiom is not rendering (touch/narrow).
 */
export function ensureChatDockSplitForView(): void {
  const s = store();
  if (!s.idiomActive) return;
  if (s.state.detent === "maximized") setChatDockDetent("split");
}

/** The dock layout marks itself live so navigation hooks only act in-idiom. */
export function setChatDockIdiomActive(active: boolean): void {
  store().idiomActive = active;
}

export function getChatDockState(): ChatDockState {
  return store().state;
}

/** Test-only: reset to defaults and clear persistence. */
export function resetChatDockForTests(): void {
  const s = store();
  s.idiomActive = false;
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch (error) {
    // error-policy:J6 best-effort teardown in tests.
    logger.debug({ error }, "Chat dock test persistence reset failed");
  }
  s.state = DEFAULT_STATE;
  for (const l of s.listeners) l();
}

function subscribe(cb: () => void): () => void {
  const s = store();
  s.listeners.add(cb);
  return () => s.listeners.delete(cb);
}

/** Reactive dock state for React surfaces. */
export function useChatDock(): ChatDockState {
  return React.useSyncExternalStore(
    subscribe,
    getChatDockState,
    getChatDockState,
  );
}
