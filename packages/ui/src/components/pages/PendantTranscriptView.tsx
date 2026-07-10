/**
 * Server-authoritative transcript surface for the omi pendant.
 *
 * BLE capture is local, but rendered transcript state converges through the
 * pendant session API. localStorage is only an explicit offline optimistic cache
 * so followers never mistake stale local rows for committed server history.
 */

import {
  type PendantSegment,
  type PendantSessionSnapshot,
  pendantSegmentId,
} from "@elizaos/shared/contracts";
import {
  ArrowDown,
  BatteryLow,
  BatteryMedium,
  Bluetooth,
  BluetoothConnected,
  Loader2,
  Mic,
  Pause,
  Play,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { client as elizaClient } from "../../api/client";
import { useThreadAutoScroll } from "../../hooks/useThreadAutoScroll";
import { cn } from "../../lib/utils";
import { HttpInsightsClient } from "../../pendant/insights-client";
import { PendantInsightsScheduler } from "../../pendant/insights-scheduler";
import {
  dispatchPendantVoiceTranscript,
  type PendantState,
} from "../../pendant/pendant-connection";
import {
  loadPendantTranscriptSession,
  type PendantTranscriptSegment,
  pendantTranscriptSessionReducer,
  savePendantTranscriptSession,
} from "../../pendant/pendant-transcript-session";
import {
  createPendantSessionSyncClient,
  type PendantSessionSyncClient,
  PendantSessionSyncError,
} from "../../pendant/session-sync-client";
import { usePendant } from "../../pendant/usePendant";
import { Button } from "../ui/button";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";

const CLOCK_FORMATTER = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const PENDANT_CAPTURE_HOLDER = "pendant-transcript";
const PENDANT_ACTIVE_SESSION_ID_KEY = "eliza:pendant-active-session-id:v1";

function formatClock(ms: number): string {
  return CLOCK_FORMATTER.format(ms);
}

function isLiveStatus(status: string): boolean {
  return (
    status === "connected" ||
    status === "listening" ||
    status === "hearing" ||
    status === "transcribing" ||
    status === "paused"
  );
}

function SegmentRow({
  segment,
  showWords,
}: {
  segment: PendantTranscriptSegment;
  showWords: boolean;
}): React.ReactElement {
  const pending = segment.status === "pending";
  const dropped = segment.status === "dropped";
  return (
    <article
      className={cn(
        "border-b border-border px-4 py-4",
        pending && "text-muted",
        dropped && "text-muted/70",
      )}
      data-testid={`pendant-segment-${segment.status}`}
    >
      <div className="mb-2 flex items-center justify-between gap-3 text-2xs uppercase text-muted">
        <span>{formatClock(segment.startedAt)}</span>
        <span>{Math.max(0, segment.durationMs / 1_000).toFixed(1)}s</span>
      </div>
      {pending ? (
        <p className="text-sm leading-6">Transcribing...</p>
      ) : dropped ? (
        <p className="text-sm leading-6">Dropped before transcript</p>
      ) : (
        <p className="text-base leading-7 text-txt">{segment.text}</p>
      )}
      {showWords && segment.words.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {segment.words.map((word) => (
            <span
              key={`${segment.id}-${word.startMs}-${word.endMs}-${word.text}`}
              className="rounded-xs bg-bg-muted px-1.5 py-1 text-2xs text-muted-strong"
              title={`${word.startMs}-${word.endMs}ms`}
            >
              {word.text}
            </span>
          ))}
        </div>
      ) : null}
    </article>
  );
}

function segmentFromServer(segment: PendantSegment): PendantTranscriptSegment {
  const startedAt = Date.parse(segment.startedAt);
  const endedAt = segment.endedAt ? Date.parse(segment.endedAt) : startedAt;
  return {
    id: segment.id,
    status:
      segment.status === "resolved"
        ? "resolved"
        : segment.status === "asr-error"
          ? "dropped"
          : "pending",
    text: segment.text,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    words: segment.words.map((word) => ({
      text: word.word,
      startMs: word.startMs,
      endMs: word.endMs,
    })),
  };
}

function segmentToServerInput(
  detail: PendantTranscriptSegment,
  ordinal: number,
  revision: number,
): Omit<PendantSegment, "id" | "sessionId" | "createdAt" | "updatedAt"> {
  return {
    ordinal,
    status:
      detail.status === "resolved"
        ? "resolved"
        : detail.status === "dropped"
          ? "asr-error"
          : "pending",
    text: detail.text,
    words: detail.words.map((word) => ({
      word: word.text,
      startMs: word.startMs,
      endMs: word.endMs,
      confidence: null,
    })),
    speakerCluster: null,
    speakerAlias: null,
    confidence: detail.status === "resolved" ? null : null,
    error: detail.status === "dropped" ? "No usable ASR transcript" : null,
    startedAt: new Date(detail.startedAt).toISOString(),
    endedAt:
      detail.status === "pending"
        ? null
        : new Date(detail.endedAt).toISOString(),
    revision,
  };
}

function nextLocalOrdinal(
  snapshot: PendantSessionSnapshot,
  localToOrdinal: ReadonlyMap<string, number>,
): number {
  let next = snapshot.segments.length;
  for (const segment of snapshot.segments) {
    next = Math.max(next, segment.ordinal + 1);
  }
  for (const ordinal of localToOrdinal.values()) {
    next = Math.max(next, ordinal + 1);
  }
  return next;
}

function useHideWordChipsOnSmallTouch(): boolean {
  const [hide, setHide] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(max-width: 480px) and (pointer: coarse)");
    const update = () => setHide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return hide;
}

function statusText(state: PendantState, unsyncedCount: number): string {
  if (unsyncedCount > 0) return `${unsyncedCount} unsynced`;
  if (state.paused) return "Paused";
  if (state.status === "transcribing") return "Transcribing";
  if (state.status === "hearing") return "Hearing";
  if (isLiveStatus(state.status)) return "Recording";
  return "Idle";
}

function readRequestedSessionId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const query = new URLSearchParams(window.location.search);
  const fromUrl =
    query.get("pendantSessionId")?.trim() ?? query.get("sessionId")?.trim();
  if (fromUrl) return fromUrl;
  try {
    return (
      window.localStorage.getItem(PENDANT_ACTIVE_SESSION_ID_KEY) ?? undefined
    );
  } catch {
    return undefined;
  }
}

function rememberSessionId(sessionId: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PENDANT_ACTIVE_SESSION_ID_KEY, sessionId);
  } catch {
    return;
  }
}

function forgetSessionId(sessionId?: string): void {
  if (typeof window === "undefined") return;
  try {
    if (
      !sessionId ||
      window.localStorage.getItem(PENDANT_ACTIVE_SESSION_ID_KEY) === sessionId
    ) {
      window.localStorage.removeItem(PENDANT_ACTIVE_SESSION_ID_KEY);
    }
  } catch {
    return;
  }
}

function BatteryDisplay({
  percent,
}: {
  percent: number | null;
}): React.ReactElement {
  const Icon = percent !== null && percent <= 20 ? BatteryLow : BatteryMedium;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted">
      <Icon className="size-4" aria-hidden />
      {percent === null ? "Battery --" : `${percent}%`}
    </span>
  );
}

export function PendantTranscriptView(): React.ReactElement {
  const [session, dispatchSession] = React.useReducer(
    pendantTranscriptSessionReducer,
    undefined,
    () => loadPendantTranscriptSession(),
  );
  const [snapshot, setSnapshot] = React.useState<PendantSessionSnapshot | null>(
    null,
  );
  const [syncError, setSyncError] = React.useState<string | null>(null);
  const [unsyncedCount, setUnsyncedCount] = React.useState(0);
  const [syncReady, setSyncReady] = React.useState(false);
  const [captureMode, setCaptureMode] = React.useState<
    "starting" | "capturer" | "follower"
  >("starting");
  const [insightsEnabled, setInsightsEnabled] = React.useState(false);
  const [insightsStatus, setInsightsStatus] = React.useState("Insights off");
  const [deleting, setDeleting] = React.useState(false);
  const clientRef = React.useRef<PendantSessionSyncClient | null>(null);
  const insightsRef = React.useRef<PendantInsightsScheduler | null>(null);
  const leaseTokenRef = React.useRef<string | null>(null);
  const captureModeRef = React.useRef<"starting" | "capturer" | "follower">(
    "starting",
  );
  const localToOrdinalRef = React.useRef(new Map<string, number>());
  const dispatchedSegmentsRef = React.useRef(new Set<string>());
  const hydratedSnapshotRef = React.useRef(false);
  const activeSessionIdRef = React.useRef<string | null>(null);
  const commitChainRef = React.useRef<Promise<void>>(Promise.resolve());
  const sessionGenerationRef = React.useRef(0);
  const disconnectCaptureRef = React.useRef<() => void>(() => {});
  const transportStartedRef = React.useRef(false);
  const localPausedRef = React.useRef(false);
  const hideWordChips = useHideWordChipsOnSmallTouch();
  const activeSegments = React.useMemo(() => {
    const committed = snapshot?.segments.map(segmentFromServer) ?? [];
    if (unsyncedCount === 0) return committed;
    const committedKeys = new Set<string>();
    const committedOrdinals = new Set<number>();
    for (const segment of snapshot?.segments ?? []) {
      committedKeys.add(segment.id);
      committedKeys.add(pendantSegmentId(segment.sessionId, segment.ordinal));
      committedOrdinals.add(segment.ordinal);
    }
    const optimistic = session.segments.filter((segment) => {
      if (committedKeys.has(segment.id)) return false;
      const ordinal = localToOrdinalRef.current.get(segment.id);
      return ordinal === undefined || !committedOrdinals.has(ordinal);
    });
    return [...committed, ...optimistic];
  }, [snapshot, session.segments, unsyncedCount]);
  const { scrollRef, atBottom, jumpToLatest } =
    useThreadAutoScroll<HTMLDivElement>({
      growthKey: `${activeSegments.length}:${
        activeSegments.at(-1)?.status ?? "empty"
      }:${activeSegments.at(-1)?.text.length ?? 0}`,
    });

  const stopLocalCapture = React.useCallback(() => {
    disconnectCaptureRef.current();
    transportStartedRef.current = false;
    leaseTokenRef.current = null;
    captureModeRef.current = "starting";
    setCaptureMode("starting");
  }, []);

  const enterFollowerMode = React.useCallback(() => {
    disconnectCaptureRef.current();
    transportStartedRef.current = false;
    leaseTokenRef.current = null;
    captureModeRef.current = "follower";
    setCaptureMode("follower");
  }, []);

  const clearActiveSession = React.useCallback(
    (sessionId?: string) => {
      sessionGenerationRef.current += 1;
      stopLocalCapture();
      clientRef.current?.clearLocalSession(sessionId);
      if (!sessionId || activeSessionIdRef.current === sessionId) {
        activeSessionIdRef.current = null;
      }
      localToOrdinalRef.current.clear();
      dispatchedSegmentsRef.current.clear();
      hydratedSnapshotRef.current = false;
      commitChainRef.current = Promise.resolve();
      insightsRef.current?.setEnabled(false);
      setInsightsEnabled(false);
      setInsightsStatus("Insights off");
      setSnapshot(null);
      setUnsyncedCount(0);
      setSyncReady(false);
      dispatchSession({ type: "clear", at: Date.now() });
      savePendantTranscriptSession({
        segments: [],
        updatedAt: Date.now(),
        clearedThrough: Date.now(),
      });
      forgetSessionId(sessionId);
    },
    [stopLocalCapture],
  );

  const clearUnsyncedCache = React.useCallback(() => {
    sessionGenerationRef.current += 1;
    clientRef.current?.clearUnsyncedCache();
    localToOrdinalRef.current.clear();
    commitChainRef.current = Promise.resolve();
    setUnsyncedCount(0);
    dispatchSession({ type: "clear", at: Date.now() });
    savePendantTranscriptSession({
      segments: [],
      updatedAt: Date.now(),
      clearedThrough: Date.now(),
    });
  }, []);

  const acceptSnapshot = React.useCallback((next: PendantSessionSnapshot) => {
    activeSessionIdRef.current = next.session.id;
    setSnapshot(next);
    setSyncError(null);
    if (!hydratedSnapshotRef.current) {
      hydratedSnapshotRef.current = true;
      for (const segment of next.segments) {
        if (segment.status === "resolved") {
          dispatchedSegmentsRef.current.add(segment.id);
        }
      }
      return;
    }
    if (captureModeRef.current !== "capturer") return;
    for (const segment of next.segments) {
      if (
        segment.status === "resolved" &&
        segment.text.trim() &&
        !dispatchedSegmentsRef.current.has(segment.id)
      ) {
        dispatchedSegmentsRef.current.add(segment.id);
        dispatchPendantVoiceTranscript(segment.text, {
          sessionId: next.session.id,
          segmentId: segment.id,
          ownerId: next.session.ownerId,
          agentId: next.session.agentId,
        });
        const ingested = insightsRef.current?.addCommittedSegment({
          id: segment.id,
          ordinal: segment.ordinal,
          text: segment.text,
          atMs: Date.parse(segment.startedAt),
          ...(segment.speakerAlias
            ? { speakerLabel: segment.speakerAlias }
            : segment.speakerCluster
              ? { speakerLabel: segment.speakerCluster }
              : {}),
        });
        if (ingested) setInsightsStatus("Insights queued");
      }
    }
  }, []);

  const bootstrapAuthoritativeSession = React.useCallback(
    (
      client: PendantSessionSyncClient,
      options: { message?: string; useRequestedSessionId?: boolean } = {},
    ) => {
      const generation = sessionGenerationRef.current;
      const useRequestedSessionId = options.useRequestedSessionId ?? true;
      setSyncReady(false);
      void (async () => {
        try {
          const created = await client.createSession({
            sessionId: useRequestedSessionId
              ? readRequestedSessionId()
              : undefined,
          });
          if (generation !== sessionGenerationRef.current) return;
          activeSessionIdRef.current = created.session.id;
          rememberSessionId(created.session.id);
          if (options.message) setSyncError(options.message);
          setSyncReady(true);
          client.startPolling(created.session.id);
        } catch (error) {
          if (generation === sessionGenerationRef.current) {
            setSyncError(
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      })();
    },
    [],
  );

  const clearActiveSessionAndBootstrap = React.useCallback(
    (sessionId: string | undefined, message: string) => {
      clearActiveSession(sessionId);
      const client = clientRef.current;
      if (client) {
        bootstrapAuthoritativeSession(client, {
          message,
          useRequestedSessionId: false,
        });
      }
    },
    [bootstrapAuthoritativeSession, clearActiveSession],
  );

  React.useEffect(() => {
    captureModeRef.current = captureMode;
  }, [captureMode]);

  React.useEffect(() => {
    const client = createPendantSessionSyncClient({
      onSnapshot: acceptSnapshot,
      onQueueChange: setUnsyncedCount,
      onError: (error) => {
        setSyncError(error.message);
        setUnsyncedCount(client.unsyncedQueue.length);
      },
    });
    clientRef.current = client;
    bootstrapAuthoritativeSession(client);
    return () => {
      sessionGenerationRef.current += 1;
      client.stopPolling();
      clientRef.current = null;
    };
  }, [acceptSnapshot, bootstrapAuthoritativeSession]);

  React.useEffect(() => {
    const unbindUpdated = elizaClient.onWsEvent(
      "pendant-session:updated",
      (frame) => {
        const sessionId =
          typeof frame.sessionId === "string" ? frame.sessionId : null;
        const active = activeSessionIdRef.current;
        if (!sessionId || !active || sessionId !== active) return;
        void clientRef.current?.poll(active).catch((error: unknown) => {
          if (
            error instanceof PendantSessionSyncError &&
            error.response?.error.code === "not_found"
          ) {
            clearActiveSessionAndBootstrap(
              active,
              "Pendant session was deleted.",
            );
            return;
          }
          setSyncError(error instanceof Error ? error.message : String(error));
        });
      },
    );
    const unbindDeleted = elizaClient.onWsEvent(
      "pendant-session:deleted",
      (frame) => {
        const sessionId =
          typeof frame.sessionId === "string" ? frame.sessionId : null;
        const active = activeSessionIdRef.current;
        if (!sessionId || !active || sessionId !== active) return;
        clearActiveSessionAndBootstrap(active, "Pendant session was deleted.");
      },
    );
    return () => {
      unbindUpdated();
      unbindDeleted();
    };
  }, [clearActiveSessionAndBootstrap]);

  React.useEffect(() => {
    if (captureMode !== "capturer") return;
    const renew = async (): Promise<void> => {
      const client = clientRef.current;
      const current = client?.currentSnapshot;
      const leaseToken = leaseTokenRef.current;
      if (!client || !current || !leaseToken) return;
      try {
        const renewed = await client.acquireLease(current.session.id, {
          holder: PENDANT_CAPTURE_HOLDER,
          leaseToken,
          leaseMs: 30_000,
        });
        leaseTokenRef.current = renewed.leaseToken;
      } catch (error) {
        if (
          error instanceof PendantSessionSyncError &&
          error.response?.error.code === "lease_conflict"
        ) {
          enterFollowerMode();
          client.startPolling(current.session.id);
          return;
        }
        setSyncError(error instanceof Error ? error.message : String(error));
      }
    };
    const timer = window.setInterval(() => {
      void renew();
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [captureMode, enterFollowerMode]);

  const enqueueCommit = React.useCallback((work: () => Promise<void>) => {
    const next = commitChainRef.current.then(work, work);
    commitChainRef.current = next.catch(() => undefined);
    return next;
  }, []);

  const commitSegmentNow = React.useCallback(
    async (detail: PendantTranscriptSegment): Promise<void> => {
      const generation = sessionGenerationRef.current;
      const client = clientRef.current;
      const current = client?.currentSnapshot;
      const leaseToken = leaseTokenRef.current;
      if (!client || !current || !leaseToken) {
        dispatchSession({ type: "segment", detail });
        setUnsyncedCount((count) => count + 1);
        setSyncError("Server session is not ready; segment is cached locally.");
        return;
      }
      const existingOrdinal = localToOrdinalRef.current.get(detail.id);
      const ordinal =
        existingOrdinal ?? nextLocalOrdinal(current, localToOrdinalRef.current);
      localToOrdinalRef.current.set(detail.id, ordinal);
      try {
        await client.upsertSegmentLifecycle(current.session.id, {
          leaseToken,
          segment: segmentToServerInput(detail, ordinal, 0),
        });
        if (generation !== sessionGenerationRef.current) return;
        const pendingCount = client.unsyncedQueue.length;
        setUnsyncedCount(pendingCount);
        if (pendingCount > 0) {
          dispatchSession({ type: "segment", detail });
          setSyncError("Segment is cached locally until sync recovers.");
        }
      } catch (error) {
        if (generation !== sessionGenerationRef.current) return;
        dispatchSession({ type: "segment", detail });
        setUnsyncedCount(client.unsyncedQueue.length || 1);
        setSyncError(
          error instanceof PendantSessionSyncError
            ? error.message
            : "Segment is cached locally until sync recovers.",
        );
      }
    },
    [],
  );

  const commitSegment = React.useCallback(
    (detail: PendantTranscriptSegment): Promise<void> =>
      enqueueCommit(() => commitSegmentNow(detail)),
    [commitSegmentNow, enqueueCommit],
  );

  const { state, supported, connect, disconnect, pause, resume } = usePendant({
    onSegment: React.useCallback(
      (detail) => {
        if (!activeSessionIdRef.current) return;
        if (captureModeRef.current !== "capturer" || !leaseTokenRef.current) {
          return;
        }
        const normalized: PendantTranscriptSegment = {
          id: detail.id,
          status: detail.status,
          text: detail.text?.trim() ?? "",
          startedAt: detail.startedAt,
          endedAt: detail.endedAt,
          durationMs: detail.durationMs,
          words: detail.words ?? [],
        };
        void commitSegment(normalized);
      },
      [commitSegment],
    ),
  });

  disconnectCaptureRef.current = disconnect;

  const connectCapture = React.useCallback(() => {
    if (!syncReady || captureModeRef.current === "follower") return;
    const client = clientRef.current;
    const current = client?.currentSnapshot;
    if (!client || !current) {
      setSyncError("Server session is not ready.");
      return;
    }
    setSyncError(null);
    void (async () => {
      try {
        const lease = await client.acquireLease(current.session.id, {
          holder: PENDANT_CAPTURE_HOLDER,
          leaseMs: 30_000,
        });
        if (activeSessionIdRef.current !== current.session.id) return;
        leaseTokenRef.current = lease.leaseToken;
        captureModeRef.current = "capturer";
        setCaptureMode("capturer");
        transportStartedRef.current = true;
        connect();
      } catch (error) {
        if (
          error instanceof PendantSessionSyncError &&
          error.response?.error.code === "lease_conflict"
        ) {
          enterFollowerMode();
          client.startPolling(current.session.id);
          return;
        }
        stopLocalCapture();
        setSyncError(error instanceof Error ? error.message : String(error));
      }
    })();
  }, [connect, enterFollowerMode, stopLocalCapture, syncReady]);

  const disconnectCapture = React.useCallback(() => {
    stopLocalCapture();
  }, [stopLocalCapture]);

  React.useEffect(() => {
    if (captureModeRef.current !== "capturer" || !transportStartedRef.current) {
      return;
    }
    if (
      state.status === "requesting" ||
      state.status === "connecting" ||
      isLiveStatus(state.status)
    ) {
      return;
    }
    stopLocalCapture();
  }, [state.status, stopLocalCapture]);

  React.useEffect(() => {
    const scheduler = new PendantInsightsScheduler({
      client: new HttpInsightsClient(),
      minSegments: 6,
      onInsights: () => setInsightsStatus("Insights fresh"),
      onError: (message) => setInsightsStatus(`Insights error: ${message}`),
    });
    insightsRef.current = scheduler;
    return () => {
      scheduler.dispose();
      if (insightsRef.current === scheduler) insightsRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    insightsRef.current?.setEnabled(insightsEnabled);
    if (!insightsEnabled) setInsightsStatus("Insights off");
  }, [insightsEnabled]);

  React.useEffect(() => {
    insightsRef.current?.setPaused(state.paused);
  }, [state.paused]);

  React.useEffect(() => {
    localPausedRef.current = state.paused;
  }, [state.paused]);

  const applyServerPauseState = React.useCallback(
    (
      next: PendantSessionSnapshot | null | undefined,
      fallbackPaused: boolean,
    ) => {
      const paused =
        next?.session.state === "paused"
          ? true
          : next?.session.state === "active"
            ? false
            : fallbackPaused;
      if (paused) {
        pause();
      } else {
        resume();
      }
    },
    [pause, resume],
  );

  const reconcileFailedControl = React.useCallback(
    async (
      action: "pause" | "resume",
      sessionId: string,
      priorPaused: boolean,
      cause: unknown,
    ) => {
      const client = clientRef.current;
      const failure =
        cause instanceof Error
          ? cause.message
          : "Pendant session control failed";
      let fallbackMessage = "";
      if (client) {
        try {
          const refreshed = await client.poll(sessionId);
          applyServerPauseState(
            refreshed ?? client.currentSnapshot,
            priorPaused,
          );
          setUnsyncedCount(client.unsyncedQueue.length);
          setSyncError(
            `${action === "pause" ? "Pause" : "Resume"} failed; reconciled with server state: ${failure}`,
          );
          return;
        } catch (refreshError) {
          fallbackMessage = ` Refresh failed: ${
            refreshError instanceof Error
              ? refreshError.message
              : String(refreshError)
          }`;
        }
      }
      applyServerPauseState(undefined, priorPaused);
      setSyncError(
        `${action === "pause" ? "Pause" : "Resume"} failed; restored local state: ${failure}${fallbackMessage}`,
      );
    },
    [applyServerPauseState],
  );

  const pauseSession = React.useCallback(() => {
    const priorPaused = localPausedRef.current;
    pause();
    void enqueueCommit(async () => {
      const current = clientRef.current?.currentSnapshot;
      if (!current) return;
      try {
        await clientRef.current?.pause(
          current.session.id,
          current.session.revision,
        );
        const pendingCount = clientRef.current?.unsyncedQueue.length ?? 0;
        setUnsyncedCount(pendingCount);
        if (pendingCount > 0) {
          setSyncError("Pause is cached locally until sync recovers.");
        }
      } catch (error) {
        await reconcileFailedControl(
          "pause",
          current.session.id,
          priorPaused,
          error,
        );
      }
    });
  }, [enqueueCommit, pause, reconcileFailedControl]);

  const resumeSession = React.useCallback(() => {
    const priorPaused = localPausedRef.current;
    resume();
    void enqueueCommit(async () => {
      const current = clientRef.current?.currentSnapshot;
      if (!current) return;
      try {
        await clientRef.current?.resume(
          current.session.id,
          current.session.revision,
        );
        const pendingCount = clientRef.current?.unsyncedQueue.length ?? 0;
        setUnsyncedCount(pendingCount);
        if (pendingCount > 0) {
          setSyncError("Resume is cached locally until sync recovers.");
        }
      } catch (error) {
        await reconcileFailedControl(
          "resume",
          current.session.id,
          priorPaused,
          error,
        );
      }
    });
  }, [enqueueCommit, reconcileFailedControl, resume]);

  const deleteServerSession = React.useCallback(() => {
    const current = clientRef.current?.currentSnapshot;
    if (!current || deleting) return;
    setDeleting(true);
    setSyncError(null);
    stopLocalCapture();
    void (async () => {
      try {
        await commitChainRef.current;
        await clientRef.current?.deleteSession(current.session.id);
        clearActiveSessionAndBootstrap(
          current.session.id,
          "Pendant session deleted.",
        );
      } catch (error) {
        setSyncError(
          `Delete failed; server session was not cleared: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        setDeleting(false);
      }
    })();
  }, [clearActiveSessionAndBootstrap, deleting, stopLocalCapture]);

  React.useEffect(() => {
    if (unsyncedCount > 0) {
      savePendantTranscriptSession(session);
    } else {
      savePendantTranscriptSession({
        segments: [],
        updatedAt: Date.now(),
        clearedThrough: Date.now(),
      });
    }
  }, [session, unsyncedCount]);

  const live = isLiveStatus(state.status);
  const busy = state.status === "requesting" || state.status === "connecting";
  const pendingCount = activeSegments.filter(
    (segment) => segment.status === "pending",
  ).length;
  const resolvedCount = activeSegments.filter(
    (segment) => segment.status === "resolved",
  ).length;
  const errorMessage =
    state.status === "error"
      ? (state.error ?? "Pendant transcript connection failed.")
      : (state.error ?? syncError);
  const readOnly = captureMode === "follower";
  const processingLabel = snapshot
    ? snapshot.session.processingLocation === "on-device"
      ? "end-device ASR proven"
      : "cloud/remote ASR"
    : "ASR location pending";

  return (
    <ShellViewAgentSurface viewId="pendant-transcript">
      <div className="flex h-full min-h-0 w-full flex-col bg-bg text-txt">
        <header className="border-b border-border px-4 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-lg font-semibold text-txt-strong">
                Pendant Transcript
              </h1>
              <p className="mt-1 text-sm text-muted">
                {state.deviceName ?? "omi pendant"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-sm border border-border px-2.5 py-1.5 text-xs",
                  live && !state.paused && "border-accent text-accent",
                  state.paused && "text-muted",
                )}
                data-testid="pendant-recording-indicator"
              >
                {live ? (
                  <Mic
                    className={cn(
                      "size-4",
                      !state.paused &&
                        "animate-pulse motion-reduce:animate-none",
                    )}
                    aria-hidden
                  />
                ) : (
                  <Bluetooth className="size-4" aria-hidden />
                )}
                {statusText(state, unsyncedCount)}
              </span>
              <BatteryDisplay percent={state.batteryPercent} />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {!supported ? (
              <span className="text-sm text-muted">
                Bluetooth pendant is not available in this environment.
              </span>
            ) : live ? (
              <>
                <Button
                  variant="surface"
                  size="sm"
                  onClick={disconnectCapture}
                  data-testid="pendant-transcript-disconnect"
                >
                  <BluetoothConnected className="size-4" aria-hidden />
                  Disconnect
                </Button>
                {state.paused ? (
                  <Button
                    variant="surfaceAccent"
                    size="sm"
                    onClick={resumeSession}
                    data-testid="pendant-transcript-resume"
                  >
                    <Play className="size-4" aria-hidden />
                    Resume
                  </Button>
                ) : (
                  <Button
                    variant="surface"
                    size="sm"
                    onClick={pauseSession}
                    data-testid="pendant-transcript-pause"
                    disabled={!syncReady}
                  >
                    <Pause className="size-4" aria-hidden />
                    Pause
                  </Button>
                )}
              </>
            ) : (
              <Button
                variant="surfaceAccent"
                size="sm"
                onClick={connectCapture}
                disabled={busy || !syncReady || readOnly}
                data-testid="pendant-transcript-connect"
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Bluetooth className="size-4" aria-hidden />
                )}
                {readOnly ? "Following" : busy ? "Connecting..." : "Connect"}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={clearUnsyncedCache}
              disabled={unsyncedCount === 0}
              data-testid="pendant-transcript-clear"
              title="Clear cache only removes offline optimistic segments. It does not delete committed server records."
            >
              <Trash2 className="size-4" aria-hidden />
              Clear cache
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={deleteServerSession}
              disabled={!snapshot || deleting}
              data-testid="pendant-transcript-delete-session"
              title="Delete the committed server session after the authenticated request succeeds."
            >
              <Trash2 className="size-4" aria-hidden />
              {deleting ? "Deleting..." : "Delete session"}
            </Button>
            <Button
              variant={insightsEnabled ? "surfaceAccent" : "surface"}
              size="sm"
              onClick={() => setInsightsEnabled((enabled) => !enabled)}
              data-testid="pendant-insights-toggle"
            >
              Insights
            </Button>
            <span className="text-xs text-muted">
              {resolvedCount} resolved · {pendingCount} pending
              {snapshot ? ` · rev ${snapshot.session.revision}` : ""}
              {readOnly ? " · read-only" : ""}
              {` · ${processingLabel}`}
              {` · ${insightsStatus}`}
            </span>
          </div>
          {errorMessage ? (
            <div
              role="alert"
              className="mt-3 border-l-2 border-danger bg-danger/10 px-3 py-2 text-sm text-danger"
              data-testid="pendant-transcript-error"
            >
              {errorMessage}
            </div>
          ) : null}
        </header>

        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollRef}
            className="h-full overflow-y-auto"
            aria-live="polite"
            data-testid="pendant-transcript-feed"
          >
            {activeSegments.length === 0 ? (
              <div className="flex h-full items-center justify-center px-6 text-center">
                <div className="max-w-md">
                  <p className="text-sm font-medium text-txt-strong">
                    No transcript segments yet
                  </p>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    Connect the pendant and speak. Committed segments appear
                    after the server accepts them.
                  </p>
                </div>
              </div>
            ) : (
              activeSegments.map((segment) => (
                <SegmentRow
                  key={segment.id}
                  segment={segment}
                  showWords={!hideWordChips}
                />
              ))
            )}
          </div>
          {!atBottom ? (
            <Button
              variant="surfaceAccent"
              size="sm"
              onClick={jumpToLatest}
              className="absolute bottom-4 left-1/2 -translate-x-1/2"
              data-testid="pendant-transcript-jump"
            >
              <ArrowDown className="size-4" aria-hidden />
              Latest
            </Button>
          ) : null}
        </div>
      </div>
    </ShellViewAgentSurface>
  );
}
