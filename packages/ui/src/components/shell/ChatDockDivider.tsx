/**
 * The vertical divider pill for the docked-chat idiom (CHAT_DOCK_UX.md §3) —
 * the floating chat pill rotated 90°, sitting on the chat↔view boundary.
 *
 * It is the ONE control of the dock continuum: tap toggles split/unsplit
 * (detent ↔ lastDetent via toggleChatDockSplit — never jumping two detents),
 * drag moves the boundary with 1:1 pointer tracking, and release commits
 * through the store's pure physics (collapse/maximize edge zones + center
 * magnet). During a drag it writes the live x straight to the
 * `--eliza-chat-dock-x` CSS var on <html> (no React re-render per frame);
 * App's dock effect re-derives the var from the committed store state on
 * release, so the var has exactly two writers that can never overlap.
 *
 * Accessibility: a real focusable separator — Enter/Space toggle, arrow keys
 * resize by 4%, Home/End collapse/maximize. Hit area 44px wide around a ~6px
 * visual capsule.
 */
import * as React from "react";

import { cn } from "../../lib/utils";
import {
  getChatDockState,
  releaseChatDockDrag,
  setChatDockDetent,
  setChatDockSplitRatio,
  toggleChatDockSplit,
  useChatDock,
} from "../../state/chat-dock-store";

/** Pointer travel (px) under which a press-release reads as a tap. */
const TAP_SLOP_PX = 5;
/** Arrow-key resize step as a fraction of the shell width. */
const KEY_STEP = 0.04;

export const CHAT_DOCK_X_VAR = "--eliza-chat-dock-x";

/** The chat pane width expression for a committed dock state. */
export function chatDockWidthFor(detent: string, splitRatio: number): string {
  if (detent === "maximized") return "100%";
  if (detent === "collapsed") return "0%";
  return `${(splitRatio * 100).toFixed(2)}%`;
}

export function ChatDockDivider({
  zIndex,
}: {
  zIndex: number;
}): React.JSX.Element {
  const { detent, splitRatio } = useChatDock();
  const [dragging, setDragging] = React.useState(false);
  const dragStateRef = React.useRef<{
    pointerId: number;
    startX: number;
    moved: boolean;
  } | null>(null);

  const onPointerDown = React.useCallback((e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStateRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      moved: false,
    };
  }, []);

  const onPointerMove = React.useCallback((e: React.PointerEvent) => {
    const drag = dragStateRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.moved && Math.abs(e.clientX - drag.startX) < TAP_SLOP_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      setDragging(true);
    }
    const width = window.innerWidth || 1;
    const raw = Math.min(1, Math.max(0, e.clientX / width));
    // Live 1:1 tracking straight to the CSS var — no store write, no render.
    document.documentElement.style.setProperty(
      CHAT_DOCK_X_VAR,
      `${(raw * 100).toFixed(2)}%`,
    );
  }, []);

  const endDrag = React.useCallback((e: React.PointerEvent) => {
    const drag = dragStateRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragStateRef.current = null;
    setDragging(false);
    if (!drag.moved) {
      toggleChatDockSplit();
      return;
    }
    const width = window.innerWidth || 1;
    const raw = Math.min(1, Math.max(0, e.clientX / width));
    releaseChatDockDrag(raw, width);
  }, []);

  const onKeyDown = React.useCallback((e: React.KeyboardEvent) => {
    const { detent: d, splitRatio: r, lastDetent } = getChatDockState();
    switch (e.key) {
      case "Enter":
      case " ":
        e.preventDefault();
        toggleChatDockSplit();
        return;
      case "ArrowLeft":
      case "ArrowRight": {
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        if (d === "collapsed") {
          if (dir > 0) setChatDockDetent(lastDetent);
          return;
        }
        if (d === "maximized") {
          if (dir < 0) setChatDockDetent("split");
          return;
        }
        setChatDockSplitRatio(r + dir * KEY_STEP);
        return;
      }
      case "Home":
        e.preventDefault();
        setChatDockDetent("collapsed");
        return;
      case "End":
        e.preventDefault();
        setChatDockDetent("maximized");
        return;
    }
  }, []);

  return (
    <div
      data-testid="chat-dock-divider"
      data-dock-detent={detent}
      data-dock-ratio={splitRatio.toFixed(2)}
      data-dock-dragging={dragging || undefined}
      className="fixed inset-y-0 flex w-11 -translate-x-1/2 touch-none select-none items-center justify-center"
      style={{
        left: `var(${CHAT_DOCK_X_VAR}, ${chatDockWidthFor(detent, splitRatio)})`,
        zIndex,
        cursor: "col-resize",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a draggable divider is a separator by ARIA semantics but must stay a real focusable button for the tap-toggle */}
      <button
        type="button"
        role="separator"
        data-aesthetic-overlay-ignore="true"
        aria-orientation="vertical"
        aria-label="Toggle chat split"
        aria-valuenow={
          detent === "maximized"
            ? 100
            : detent === "collapsed"
              ? 0
              : Math.round(splitRatio * 100)
        }
        aria-valuemin={0}
        aria-valuemax={100}
        onKeyDown={onKeyDown}
        className={cn(
          "h-32 w-1.5 rounded-full transition-transform duration-150",
          "hover:scale-x-[1.8] focus-visible:scale-x-[1.8] focus-visible:outline-none",
          dragging && "scale-x-[1.8]",
          // Same capsule material as the floating chat pill: translucent
          // white glass with a soft shadow, legible over wallpaper and views.
          "border border-white/40 bg-white/70 shadow-[0_1px_6px_rgba(0,0,0,0.35)] backdrop-blur-md dark:border-white/25 dark:bg-white/30",
        )}
        style={{ cursor: "col-resize" }}
      />
    </div>
  );
}
