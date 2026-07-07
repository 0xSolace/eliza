// Self-contained fixture for the docked-chat idiom e2e (CHAT_DOCK_UX.md).
// Replicates the App shell's dock frame — the real ContinuousChatOverlay
// pinned inside the transform-contained left pane, the routed content as the
// right pane inset by the shared --eliza-chat-dock-x var, and the real
// ChatDockDivider — over a fake launcher background, so a headless browser can
// drive the tap/drag/keyboard continuum and the agent auto-split against the
// REAL store + components. Paired with run-chat-dock-e2e.mjs.

import * as React from "react";
import { createRoot } from "react-dom/client";

import {
  ensureChatDockSplitForView,
  getChatDockState,
  setChatDockIdiomActive,
  useChatDock,
} from "../../../state/chat-dock-store";
import { MockAppProvider } from "../../../storybook/mock-providers";
import {
  CHAT_DOCK_X_VAR,
  ChatDockDivider,
  chatDockWidthFor,
} from "../ChatDockDivider";
import { ContinuousChatOverlay } from "../ContinuousChatOverlay";
import type { ShellMessage } from "../shell-state";
import type { ShellController } from "../useShellController";

declare global {
  interface Window {
    __ensureDockSplitForView?: () => void;
    __dockState?: () => { detent: string; splitRatio: number };
  }
}

let nextId = 100;
const uid = () => `m${nextId++}`;

const SEED: ShellMessage[] = [
  { id: "d1", role: "user", content: "open the dock, please", createdAt: 1 },
  {
    id: "d2",
    role: "assistant",
    content:
      "You're in the docked chat — full-height on the left. Tap the vertical pill on the right edge to split the window, or drag it to set the ratio.",
    createdAt: 2,
  },
  { id: "d3", role: "user", content: "and when you open a view?", createdAt: 3 },
  {
    id: "d4",
    role: "assistant",
    content:
      "If the chat is maximized I auto-split so the view lands beside our conversation; if you collapsed me I stay out of the way.",
    createdAt: 4,
  },
];

function Harness(): React.JSX.Element {
  const [messages, setMessages] = React.useState<ShellMessage[]>(SEED);
  const [phase, setPhase] = React.useState<ShellController["phase"]>(
    "summoned",
  );
  const dock = useChatDock();

  React.useEffect(() => {
    setChatDockIdiomActive(true);
    window.__ensureDockSplitForView = () => ensureChatDockSplitForView();
    window.__dockState = () => {
      const s = getChatDockState();
      return { detent: s.detent, splitRatio: s.splitRatio };
    };
    return () => {
      setChatDockIdiomActive(false);
      window.__ensureDockSplitForView = undefined;
      window.__dockState = undefined;
    };
  }, []);

  // Mirror App's committed-geometry effect: the divider writes the same var
  // live during a drag; this re-derives it from the committed store state.
  React.useEffect(() => {
    document.documentElement.style.setProperty(
      CHAT_DOCK_X_VAR,
      chatDockWidthFor(dock.detent, dock.splitRatio),
    );
  }, [dock.detent, dock.splitRatio]);

  const send = React.useCallback<ShellController["send"]>((text) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    console.log(`[fixture] send: ${JSON.stringify(trimmed)}`);
    setMessages((m) => [
      ...m,
      { id: uid(), role: "user", content: trimmed, createdAt: nextId },
    ]);
    setPhase("responding");
    window.setTimeout(() => {
      setMessages((m) => [
        ...m,
        {
          id: uid(),
          role: "assistant",
          content: `On it — “${trimmed}”.`,
          createdAt: nextId,
        },
      ]);
      setPhase("summoned");
    }, 300);
  }, []);

  const noop = (label: string) => () => console.log(`[fixture] ${label}`);

  const controller: ShellController = {
    phase,
    responding: phase === "responding",
    turnStatus: phase === "responding" ? { kind: "thinking" as const } : null,
    messages,
    noProviderConfigured: false,
    canSend: true,
    waveformMode: phase === "responding" ? "responding" : "idle",
    analyser: null,
    open: noop("open"),
    close: noop("close"),
    isOpen: true,
    recording: false,
    handsFree: false,
    transcript: "",
    speaking: false,
    agentVoiceMuted: false,
    needsAudioUnlock: false,
    micPermission: "unknown",
    recheckMicPermission: async () => "unknown",
    transcriptionMode: false,
    toggleTranscriptionMode: noop("toggleTranscriptionMode"),
    stopTranscriptionAndMic: noop("stopTranscriptionAndMic"),
    modelStatus: {
      kind: "ready",
      blocksSend: false,
      percent: null,
      etaMs: null,
      modelName: null,
      errors: [],
    },
    send,
    captureVision: noop("captureVision"),
    visionCapturing: false,
    toggleRecording: noop("toggleRecording"),
    toggleHandsFree: noop("toggleHandsFree"),
    setDictationSink: () => {},
    setTranscriptSessionSink: () => {},
    setComposerHasDraft: () => {},
    startRecording: noop("startRecording"),
    stopRecording: noop("stopRecording"),
    speak: noop("speak"),
    stopSpeaking: noop("stopSpeaking"),
    toggleAgentVoiceMute: noop("toggleAgentVoiceMute"),
    unlockAudio: noop("unlockAudio"),
    openSettings: noop("openSettings"),
    currentTab: undefined,
    navigateHome: noop("navigateHome"),
    clearConversation: noop("clearConversation"),
    stop: noop("stop"),
    conversationNav: {
      hasPrev: false,
      hasNext: false,
      goPrev: noop("conversationNav.goPrev"),
      goNext: noop("conversationNav.goNext"),
      activeId: "fixture-thread",
      index: 0,
    },
  };

  return (
    <div
      data-testid="dock-root"
      style={{
        position: "fixed",
        inset: 0,
        background: "#ef5a1f",
        color: "rgba(255,255,255,0.9)",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      {/* RIGHT pane — routed content, inset by the chat pane's live width. */}
      <div
        data-testid="dock-right-pane"
        style={{
          position: "absolute",
          top: 0,
          bottom: 0,
          right: 0,
          marginLeft: `var(${CHAT_DOCK_X_VAR}, 0%)`,
          width: `calc(100% - var(${CHAT_DOCK_X_VAR}, 0%))`,
          padding: "48px 28px",
        }}
      >
        <h1 style={{ fontSize: 30, fontWeight: 600, margin: 0 }}>Launcher</h1>
        <p style={{ opacity: 0.7, marginTop: 12 }}>
          The launcher / active view lives here — the right pane of the dock.
        </p>
      </div>
      {/* LEFT pane — the dock frame from App.tsx: transform makes it the
          containing block for the overlay's fixed positioning. */}
      {dock.detent !== "collapsed" ? (
        <div
          data-testid="chat-dock-pane"
          style={{
            position: "fixed",
            top: 0,
            bottom: 0,
            left: 0,
            overflow: "hidden",
            width: `var(${CHAT_DOCK_X_VAR}, 100%)`,
            transform: "translateZ(0)",
            zIndex: 9000,
          }}
        >
          <ContinuousChatOverlay controller={controller} dockPinned />
        </div>
      ) : null}
      <ChatDockDivider zIndex={9001} />
    </div>
  );
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <MockAppProvider>
      <Harness />
    </MockAppProvider>,
  );
