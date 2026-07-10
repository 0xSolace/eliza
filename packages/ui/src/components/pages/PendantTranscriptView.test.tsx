// @vitest-environment jsdom

/**
 * Pendant transcript view states are rendered against mocked pendant transport
 * and scrolling hooks so the component contract stays deterministic in jsdom.
 */

import type {
  PatchPendantSegmentRequest,
  PendantSegment,
  PendantSessionSnapshot,
  UpsertPendantSegmentRequest,
} from "@elizaos/shared/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PENDANT_TRANSCRIPT_STORAGE_KEY } from "../../pendant/pendant-transcript-session";
import { PendantSessionSyncError } from "../../pendant/session-sync-client";
import type {
  UsePendantOptions,
  UsePendantResult,
} from "../../pendant/usePendant";
import { PendantTranscriptView } from "./PendantTranscriptView";

const pendantMock = vi.hoisted(() => ({
  result: undefined as UsePendantResult | undefined,
  onSegment: undefined as UsePendantOptions["onSegment"] | undefined,
}));

interface TestSessionSyncClient {
  unsyncedQueue: unknown[];
  currentSnapshot: PendantSessionSnapshot | undefined;
  createSession: ReturnType<typeof vi.fn>;
  acquireLease: ReturnType<typeof vi.fn>;
  startPolling: ReturnType<typeof vi.fn>;
  stopPolling: ReturnType<typeof vi.fn>;
  appendSegment: ReturnType<typeof vi.fn>;
  patchSegment: ReturnType<typeof vi.fn>;
  upsertSegmentLifecycle: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  poll: ReturnType<typeof vi.fn>;
  deleteSession: ReturnType<typeof vi.fn>;
  clearLocalSession: ReturnType<typeof vi.fn>;
  clearUnsyncedCache: ReturnType<typeof vi.fn>;
}

const syncMock = vi.hoisted(() => ({
  snapshot: undefined as PendantSessionSnapshot | undefined,
  onSnapshot: undefined as
    | ((snapshot: PendantSessionSnapshot) => void)
    | undefined,
  onQueueChange: undefined as ((length: number) => void) | undefined,
  client: undefined as TestSessionSyncClient | undefined,
  offline: false,
  leaseConflict: false,
  deleteFails: false,
  pollNotFound: false,
  pollFails: false,
  pauseFails: false,
  resumeFails: false,
  createdSessions: 0,
}));

const wsMock = vi.hoisted(() => ({
  handlers: new Map<string, (frame: Record<string, unknown>) => void>(),
  onWsEvent: vi.fn(
    (type: string, handler: (frame: Record<string, unknown>) => void) => {
      wsMock.handlers.set(type, handler);
      return () => {
        if (wsMock.handlers.get(type) === handler) wsMock.handlers.delete(type);
      };
    },
  ),
}));

const schedulerMock = vi.hoisted(() => ({
  instances: [] as Array<{
    setEnabled: ReturnType<typeof vi.fn>;
    setPaused: ReturnType<typeof vi.fn>;
    addCommittedSegment: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../../api/client", () => ({
  client: {
    onWsEvent: wsMock.onWsEvent,
  },
}));

vi.mock("../../pendant/usePendant", () => ({
  usePendant: (options?: UsePendantOptions) => {
    pendantMock.onSegment = options?.onSegment;
    if (!pendantMock.result) {
      throw new Error("usePendant mock result was not configured");
    }
    return pendantMock.result;
  },
}));

vi.mock("../../hooks/useThreadAutoScroll", () => ({
  useThreadAutoScroll: () => ({
    scrollRef: vi.fn(),
    atBottom: true,
    jumpToLatest: vi.fn(),
  }),
}));

vi.mock("../../pendant/session-sync-client", () => {
  class PendantSessionSyncError extends Error {
    constructor(
      message: string,
      readonly response?: unknown,
    ) {
      super(message);
    }
  }
  return {
    PendantSessionSyncError,
    createPendantSessionSyncClient: (options?: {
      onSnapshot?: (snapshot: PendantSessionSnapshot) => void;
      onQueueChange?: (length: number) => void;
    }) => {
      syncMock.onSnapshot = options?.onSnapshot;
      syncMock.onQueueChange = options?.onQueueChange;
      const client = {
        unsyncedQueue: [],
        get currentSnapshot() {
          return syncMock.snapshot;
        },
        createSession: vi.fn(async () => {
          if (!syncMock.snapshot) {
            syncMock.createdSessions += 1;
            syncMock.snapshot = {
              schemaVersion: 1,
              session: {
                id: `server-session-${syncMock.createdSessions}`,
                ownerId: "owner",
                agentId: "agent",
                startedAt: "2026-01-01T00:00:00.000Z",
                endedAt: null,
                state: "active",
                captureLease: null,
                processingLocation: "cloud",
                revision: 0,
              },
              segments: [],
              insightRefs: [],
            };
          }
          options?.onSnapshot?.(syncMock.snapshot);
          return syncMock.snapshot;
        }),
        acquireLease: vi.fn(async () => {
          if (syncMock.leaseConflict) {
            throw new PendantSessionSyncError("Capture lease is already held", {
              ok: false,
              error: {
                code: "lease_conflict",
                message: "Capture lease is already held",
              },
            });
          }
          return { leaseToken: "lease" };
        }),
        startPolling: vi.fn(),
        stopPolling: vi.fn(),
        appendSegment: vi.fn(
          async (_sessionId: string, request: UpsertPendantSegmentRequest) => {
            if (!syncMock.snapshot) throw new Error("missing snapshot");
            if (syncMock.offline) throw new TypeError("Failed to fetch");
            const segment: PendantSegment = {
              ...request.segment,
              id: `${syncMock.snapshot.session.id}:segment:${request.segment.ordinal}`,
              sessionId: syncMock.snapshot.session.id,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            };
            syncMock.snapshot = {
              ...syncMock.snapshot,
              session: {
                ...syncMock.snapshot.session,
                revision: syncMock.snapshot.session.revision + 1,
              },
              segments: [...syncMock.snapshot.segments, segment],
            };
            options?.onSnapshot?.(syncMock.snapshot);
            return syncMock.snapshot;
          },
        ),
        patchSegment: vi.fn(
          async (
            _sessionId: string,
            segmentId: string,
            request: PatchPendantSegmentRequest,
          ) => {
            if (!syncMock.snapshot) throw new Error("missing snapshot");
            if (syncMock.offline) throw new TypeError("Failed to fetch");
            syncMock.snapshot = {
              ...syncMock.snapshot,
              session: {
                ...syncMock.snapshot.session,
                revision: syncMock.snapshot.session.revision + 1,
              },
              segments: syncMock.snapshot.segments.map((segment) =>
                segment.id === segmentId
                  ? {
                      ...segment,
                      ...request,
                      updatedAt: "2026-01-01T00:00:01.000Z",
                    }
                  : segment,
              ),
            };
            options?.onSnapshot?.(syncMock.snapshot);
            return syncMock.snapshot;
          },
        ),
        upsertSegmentLifecycle: vi.fn(
          async (sessionId: string, request: UpsertPendantSegmentRequest) => {
            if (!syncMock.snapshot) throw new Error("missing snapshot");
            const segmentId = `${sessionId}:segment:${request.segment.ordinal}`;
            const existing = syncMock.snapshot.segments.find(
              (segment) => segment.id === segmentId,
            );
            if (!existing) {
              return client.appendSegment(sessionId, request);
            }
            return client.patchSegment(sessionId, segmentId, {
              leaseToken: request.leaseToken,
              revision: existing.revision + 1,
              status: request.segment.status,
              text: request.segment.text,
              words: request.segment.words,
              speakerCluster: request.segment.speakerCluster,
              speakerAlias: request.segment.speakerAlias,
              confidence: request.segment.confidence,
              error: request.segment.error,
              startedAt: request.segment.startedAt,
              endedAt: request.segment.endedAt,
            });
          },
        ),
        poll: vi.fn(async () => {
          if (syncMock.pollFails) throw new TypeError("Failed to fetch");
          if (syncMock.pollNotFound) {
            throw new PendantSessionSyncError("Pendant session was not found", {
              ok: false,
              error: {
                code: "not_found",
                message: "Pendant session was not found",
              },
            });
          }
          if (syncMock.snapshot) options?.onSnapshot?.(syncMock.snapshot);
          return syncMock.snapshot ?? null;
        }),
        deleteSession: vi.fn(async () => {
          if (syncMock.deleteFails) {
            throw new Error("delete route failed");
          }
          return { ok: true, deleted: true };
        }),
        clearLocalSession: vi.fn((sessionId?: string) => {
          client.stopPolling();
          if (!sessionId || syncMock.snapshot?.session.id === sessionId) {
            syncMock.snapshot = undefined;
          }
          const previousLength = client.unsyncedQueue.length;
          client.unsyncedQueue.length = 0;
          if (previousLength !== client.unsyncedQueue.length) {
            options?.onQueueChange?.(client.unsyncedQueue.length);
          }
        }),
        clearUnsyncedCache: vi.fn(() => {
          const previousLength = client.unsyncedQueue.length;
          client.unsyncedQueue.length = 0;
          if (previousLength !== client.unsyncedQueue.length) {
            options?.onQueueChange?.(client.unsyncedQueue.length);
          }
        }),
        pause: vi.fn(async () => {
          if (syncMock.pauseFails) {
            throw new PendantSessionSyncError("Pause revision conflict", {
              ok: false,
              error: {
                code: "revision_conflict",
                message: "Pause revision conflict",
              },
            });
          }
          if (!syncMock.snapshot) throw new Error("missing snapshot");
          syncMock.snapshot = {
            ...syncMock.snapshot,
            session: {
              ...syncMock.snapshot.session,
              state: "paused",
              revision: syncMock.snapshot.session.revision + 1,
            },
          };
          options?.onSnapshot?.(syncMock.snapshot);
          return syncMock.snapshot;
        }),
        resume: vi.fn(async () => {
          if (syncMock.resumeFails) {
            throw new PendantSessionSyncError("Resume revision conflict", {
              ok: false,
              error: {
                code: "revision_conflict",
                message: "Resume revision conflict",
              },
            });
          }
          if (!syncMock.snapshot) throw new Error("missing snapshot");
          syncMock.snapshot = {
            ...syncMock.snapshot,
            session: {
              ...syncMock.snapshot.session,
              state: "active",
              revision: syncMock.snapshot.session.revision + 1,
            },
          };
          options?.onSnapshot?.(syncMock.snapshot);
          return syncMock.snapshot;
        }),
      };
      syncMock.client = client;
      return client;
    },
  };
});

vi.mock("../../pendant/insights-client", () => ({
  HttpInsightsClient: class HttpInsightsClient {},
}));

vi.mock("../../pendant/insights-scheduler", () => ({
  PendantInsightsScheduler: class PendantInsightsScheduler {
    setEnabled = vi.fn();
    setPaused = vi.fn();
    addCommittedSegment = vi.fn(() => null);
    dispose = vi.fn();
    constructor() {
      schedulerMock.instances.push(this);
    }
  },
}));

vi.mock("../views/ShellViewAgentSurface", () => ({
  ShellViewAgentSurface: ({ children }: { children?: ReactNode }) => children,
}));

const connect = vi.fn();
const disconnect = vi.fn();
const pause = vi.fn();
const resume = vi.fn();

function setPendantState(
  overrides: Partial<UsePendantResult["state"]> = {},
  supported = true,
): void {
  pendantMock.result = {
    state: {
      status: supported ? "idle" : "unsupported",
      connectStep: "idle",
      deviceName: null,
      batteryPercent: null,
      codecId: null,
      lastTranscript: null,
      droppedPackets: 0,
      error: null,
      paused: false,
      ...overrides,
    },
    supported,
    connect,
    disconnect,
    pause,
    resume,
  };
}

function setServerSnapshot(segments: PendantSegment[] = []): void {
  syncMock.snapshot = {
    schemaVersion: 1,
    session: {
      id: "server-session",
      ownerId: "owner",
      agentId: "agent",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      state: "active",
      captureLease: {
        holder: "pendant-transcript",
        expiresAt: "2026-01-01T00:10:00.000Z",
      },
      processingLocation: "cloud",
      revision: 0,
    },
    segments,
    insightRefs: [],
  };
}

async function connectAsCapturer(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: /Connect/ }));
  await waitFor(() =>
    expect(syncMock.client?.acquireLease).toHaveBeenCalledWith(
      "server-session",
      {
        holder: "pendant-transcript",
        leaseMs: 30_000,
      },
    ),
  );
  await waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
}

describe("PendantTranscriptView", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    setPendantState();
    setServerSnapshot();
    syncMock.offline = false;
    syncMock.leaseConflict = false;
    syncMock.deleteFails = false;
    syncMock.pollNotFound = false;
    syncMock.pollFails = false;
    syncMock.pauseFails = false;
    syncMock.resumeFails = false;
    syncMock.createdSessions = 0;
    syncMock.onQueueChange = undefined;
    wsMock.handlers.clear();
    wsMock.onWsEvent.mockClear();
    schedulerMock.instances = [];
    localStorage.removeItem("eliza:pendant-active-session-id:v1");
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("keeps unsupported distinct from idle", () => {
    setPendantState({}, false);

    render(<PendantTranscriptView />);

    expect(
      screen.getByText(
        "Bluetooth pendant is not available in this environment.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
    expect(screen.getByTestId("pendant-recording-indicator").textContent).toBe(
      "Idle",
    );
    expect(syncMock.client?.acquireLease).not.toHaveBeenCalled();
  });

  it("creates and polls the authoritative session on mount without acquiring a lease", async () => {
    render(<PendantTranscriptView />);

    await screen.findByRole("button", { name: /Connect/ });

    expect(syncMock.client?.createSession).toHaveBeenCalledTimes(1);
    expect(syncMock.client?.startPolling).toHaveBeenCalledWith(
      "server-session",
    );
    expect(syncMock.client?.acquireLease).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("acquires the capture lease before opening the transport on Connect", async () => {
    render(<PendantTranscriptView />);

    await connectAsCapturer();

    expect(syncMock.client?.acquireLease).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(
      syncMock.client?.acquireLease.mock.invocationCallOrder[0],
    ).toBeLessThan(connect.mock.invocationCallOrder[0] ?? 0);
  });

  it("renders an explicit pendant error as an alert row", async () => {
    setPendantState({
      status: "error",
      error: "Bluetooth permission was denied.",
    });

    render(<PendantTranscriptView />);

    expect(screen.getByRole("alert").textContent).toBe(
      "Bluetooth permission was denied.",
    );
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /Connect/ })
          .hasAttribute("disabled"),
      ).toBe(false),
    );
  });

  it("shows pause while connected and calls pause", async () => {
    setPendantState({
      status: "connected",
      paused: false,
      deviceName: "omi devkit",
    });

    render(<PendantTranscriptView />);
    const button = screen.getByRole("button", { name: /Pause/ });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);

    expect(pause).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
  });

  it("surfaces pause failure and reconciles local capture to the server snapshot", async () => {
    syncMock.pauseFails = true;
    setPendantState({
      status: "connected",
      paused: false,
      deviceName: "omi devkit",
    });

    render(<PendantTranscriptView />);
    const button = screen.getByRole("button", { name: /Pause/ });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);

    expect(pause).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(syncMock.client?.pause).toHaveBeenCalled());
    await waitFor(() => expect(syncMock.client?.poll).toHaveBeenCalled());
    expect(resume).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toBe(
      "Pause failed; reconciled with server state: Pause revision conflict",
    );
  });

  it("shows resume while paused and calls resume", () => {
    setPendantState({
      status: "paused",
      paused: true,
    });

    render(<PendantTranscriptView />);
    fireEvent.click(screen.getByRole("button", { name: /Resume/ }));

    expect(resume).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
  });

  it("surfaces resume failure and reconciles local capture to the server snapshot", async () => {
    syncMock.resumeFails = true;
    if (!syncMock.snapshot) throw new Error("missing snapshot");
    syncMock.snapshot = {
      ...syncMock.snapshot,
      session: { ...syncMock.snapshot.session, state: "paused" },
    };
    setPendantState({
      status: "paused",
      paused: true,
    });

    render(<PendantTranscriptView />);
    fireEvent.click(screen.getByRole("button", { name: /Resume/ }));

    expect(resume).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(syncMock.client?.resume).toHaveBeenCalled());
    await waitFor(() => expect(syncMock.client?.poll).toHaveBeenCalled());
    expect(pause).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toBe(
      "Resume failed; reconciled with server state: Resume revision conflict",
    );
  });

  it("keeps local resume active when failed resume refetch reports active", async () => {
    syncMock.resumeFails = true;
    if (!syncMock.snapshot) throw new Error("missing snapshot");
    syncMock.snapshot = {
      ...syncMock.snapshot,
      session: { ...syncMock.snapshot.session, state: "active" },
    };
    setPendantState({
      status: "paused",
      paused: true,
    });

    render(<PendantTranscriptView />);
    fireEvent.click(screen.getByRole("button", { name: /Resume/ }));

    expect(resume).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(syncMock.client?.resume).toHaveBeenCalled());
    await waitFor(() => expect(syncMock.client?.poll).toHaveBeenCalled());
    expect(pause).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "Resume failed; reconciled with server state: Resume revision conflict",
    );
  });

  it("restores the prior local pause state when failed control refetch also fails", async () => {
    syncMock.pauseFails = true;
    syncMock.pollFails = true;
    setPendantState({
      status: "connected",
      paused: false,
      deviceName: "omi devkit",
    });

    render(<PendantTranscriptView />);
    const button = screen.getByRole("button", { name: /Pause/ });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    fireEvent.click(button);

    expect(pause).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(syncMock.client?.pause).toHaveBeenCalled());
    await waitFor(() => expect(syncMock.client?.poll).toHaveBeenCalled());
    expect(resume).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toBe(
      "Pause failed; restored local state: Pause revision conflict Refresh failed: Failed to fetch",
    );
  });

  it("renders server resolved transcript text and word timing", async () => {
    const startedAt = Date.UTC(2026, 0, 1, 13, 14, 15);
    setServerSnapshot([
      {
        id: "server-session:segment:0",
        sessionId: "server-session",
        ordinal: 0,
        status: "resolved",
        text: "hello world",
        words: [
          { word: "hello", startMs: 0, endMs: 500, confidence: null },
          { word: "world", startMs: 550, endMs: 1_200, confidence: null },
        ],
        speakerCluster: null,
        speakerAlias: null,
        confidence: null,
        error: null,
        createdAt: new Date(startedAt).toISOString(),
        updatedAt: new Date(startedAt + 1_250).toISOString(),
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(startedAt + 1_250).toISOString(),
        revision: 0,
      },
    ]);

    render(<PendantTranscriptView />);

    expect(await screen.findByText("hello world")).toBeTruthy();
    expect(screen.getByText(/cloud\/remote ASR/)).toBeTruthy();
    expect(screen.getByText("hello").getAttribute("title")).toBe("0-500ms");
    expect(screen.getByText("world").getAttribute("title")).toBe("550-1200ms");
    expect(
      screen.getByText(
        new Intl.DateTimeFormat("en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
        }).format(startedAt),
      ),
    ).toBeTruthy();
  });

  it("uses localStorage only as explicit unsynced optimistic cache", async () => {
    localStorage.setItem(
      PENDANT_TRANSCRIPT_STORAGE_KEY,
      JSON.stringify({
        segments: [
          {
            id: "segment-before-clear",
            status: "pending",
            text: "",
            startedAt: 1_000,
            endedAt: 1_500,
            durationMs: 500,
            words: [],
          },
        ],
        updatedAt: 1_500,
        clearedThrough: null,
      }),
    );
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(2_000);
    syncMock.offline = true;

    try {
      render(<PendantTranscriptView />);
      expect(screen.queryByText("Transcribing...")).toBeNull();

      await screen.findByText("No transcript segments yet");
      await connectAsCapturer();

      act(() => {
        pendantMock.onSegment?.({
          id: "segment-before-clear",
          status: "resolved",
          text: "late stale text",
          startedAt: 1_000,
          endedAt: 1_500,
          durationMs: 500,
          words: [],
        });
      });
      expect(await screen.findByText("late stale text")).toBeTruthy();
      expect(localStorage.getItem(PENDANT_TRANSCRIPT_STORAGE_KEY)).toContain(
        "late stale text",
      );

      fireEvent.click(screen.getByRole("button", { name: /Clear cache/ }));
      expect(localStorage.getItem(PENDANT_TRANSCRIPT_STORAGE_KEY)).toBeNull();
      expect(syncMock.client?.clearUnsyncedCache).toHaveBeenCalled();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("suppresses only the replayed optimistic row during partial offline replay", async () => {
    syncMock.offline = true;

    render(<PendantTranscriptView />);
    await connectAsCapturer();

    act(() => {
      pendantMock.onSegment?.({
        id: "local-capture-0",
        status: "resolved",
        text: "offline zero",
        startedAt: 1_000,
        endedAt: 1_500,
        durationMs: 500,
        words: [],
      });
    });
    expect(await screen.findByText("offline zero")).toBeTruthy();

    act(() => {
      pendantMock.onSegment?.({
        id: "local-capture-1",
        status: "resolved",
        text: "offline one",
        startedAt: 2_000,
        endedAt: 2_500,
        durationMs: 500,
        words: [],
      });
    });
    expect(await screen.findByText("offline one")).toBeTruthy();

    act(() => {
      const current = syncMock.snapshot;
      if (!current) throw new Error("missing snapshot");
      syncMock.onSnapshot?.({
        ...current,
        session: {
          ...current.session,
          revision: current.session.revision + 1,
        },
        segments: [
          {
            id: "server-session:segment:0",
            sessionId: "server-session",
            ordinal: 0,
            status: "resolved",
            text: "canonical zero",
            words: [],
            speakerCluster: null,
            speakerAlias: null,
            confidence: null,
            error: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:01.000Z",
            endedAt: "2026-01-01T00:00:01.500Z",
            revision: 0,
          },
        ],
      });
      syncMock.onQueueChange?.(1);
    });

    expect(await screen.findByText("canonical zero")).toBeTruthy();
    expect(screen.queryByText("offline zero")).toBeNull();
    expect(screen.getAllByText("canonical zero")).toHaveLength(1);
    expect(screen.getAllByText("offline one")).toHaveLength(1);
  });

  it("removes the unsynced badge after replay drains the queue", async () => {
    syncMock.offline = true;

    render(<PendantTranscriptView />);
    await connectAsCapturer();

    act(() => {
      pendantMock.onSegment?.({
        id: "local-replay-badge",
        status: "resolved",
        text: "queued badge row",
        startedAt: 1_000,
        endedAt: 1_500,
        durationMs: 500,
        words: [],
      });
    });
    await waitFor(() => expect(screen.getByText(/1 unsynced/)).toBeTruthy());

    act(() => {
      const current = syncMock.snapshot;
      if (!current) throw new Error("missing snapshot");
      if (!syncMock.client) throw new Error("missing sync client");
      syncMock.client.unsyncedQueue.length = 1;
      syncMock.onSnapshot?.({
        ...current,
        session: {
          ...current.session,
          revision: current.session.revision + 1,
        },
        segments: [
          {
            id: "server-session:segment:0",
            sessionId: "server-session",
            ordinal: 0,
            status: "resolved",
            text: "queued badge row",
            words: [],
            speakerCluster: null,
            speakerAlias: null,
            confidence: null,
            error: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:01.000Z",
            endedAt: "2026-01-01T00:00:01.500Z",
            revision: 0,
          },
        ],
      });
    });
    expect(screen.getByText(/1 unsynced/)).toBeTruthy();

    act(() => {
      if (!syncMock.client) throw new Error("missing sync client");
      syncMock.client.unsyncedQueue.length = 0;
      syncMock.onQueueChange?.(0);
    });

    await waitFor(() => expect(screen.queryByText(/1 unsynced/)).toBeNull());
    expect(screen.getAllByText("queued badge row")).toHaveLength(1);
  });

  it("clear cache removes queued writes without deleting the authoritative snapshot", async () => {
    render(<PendantTranscriptView />);
    await connectAsCapturer();
    if (!syncMock.client) throw new Error("missing sync client");
    syncMock.client.unsyncedQueue.push({ id: "queued" });
    syncMock.offline = true;
    act(() => {
      pendantMock.onSegment?.({
        id: "local-cache",
        status: "resolved",
        text: "cached only",
        startedAt: 1_000,
        endedAt: 1_500,
        durationMs: 500,
        words: [],
      });
    });
    await waitFor(() => expect(screen.getByText(/1 unsynced/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Clear cache/ }));

    expect(syncMock.client.clearUnsyncedCache).toHaveBeenCalled();
    expect(syncMock.snapshot?.session.id).toBe("server-session");
    expect(syncMock.client.stopPolling).not.toHaveBeenCalled();
    expect(screen.queryByText("cached only")).toBeNull();
    expect(screen.getByText(/rev 0/)).toBeTruthy();
  });

  it("enters follower mode without opening transport on a Connect lease conflict", async () => {
    syncMock.leaseConflict = true;
    localStorage.setItem(
      "eliza:pendant-active-session-id:v1",
      "server-session",
    );

    render(<PendantTranscriptView />);
    fireEvent.click(await screen.findByRole("button", { name: /Connect/ }));

    expect(
      await screen.findByRole("button", { name: /Following/ }),
    ).toBeTruthy();
    expect(syncMock.client?.acquireLease).toHaveBeenCalledTimes(1);
    expect(syncMock.client?.startPolling).toHaveBeenCalledWith(
      "server-session",
    );
    expect(connect).not.toHaveBeenCalled();
    expect(screen.getByText(/read-only/)).toBeTruthy();
  });

  it("disconnects capture before follower polling after a deferred renewal lease conflict", async () => {
    let renewTick: (() => void) | undefined;
    const setIntervalSpy = vi
      .spyOn(window, "setInterval")
      .mockImplementation((handler: TimerHandler, timeout?: number) => {
        if (timeout === 15_000) {
          renewTick =
            typeof handler === "function" ? () => handler() : () => undefined;
        }
        return setTimeout(() => undefined, 0);
      });
    const clearIntervalSpy = vi
      .spyOn(window, "clearInterval")
      .mockImplementation(() => undefined);

    try {
      const { rerender } = render(<PendantTranscriptView />);
      await connectAsCapturer();
      setPendantState({ status: "connected" });
      rerender(<PendantTranscriptView />);
      await screen.findByRole("button", { name: /Disconnect/ });
      if (!syncMock.client) throw new Error("missing sync client");
      await waitFor(() => expect(renewTick).toBeDefined());

      syncMock.client.acquireLease.mockImplementationOnce(async () =>
        Promise.reject(
          new PendantSessionSyncError("Capture lease is already held", {
            ok: false,
            error: {
              code: "lease_conflict",
              message: "Capture lease is already held",
            },
          }),
        ),
      );

      await act(async () => {
        renewTick?.();
      });

      await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
      expect(screen.getByText(/read-only/)).toBeTruthy();
      expect(syncMock.client.startPolling).toHaveBeenCalledWith(
        "server-session",
      );

      act(() => {
        pendantMock.onSegment?.({
          id: "late-follower-segment",
          status: "resolved",
          text: "should not cache",
          startedAt: 1_000,
          endedAt: 1_500,
          durationMs: 500,
          words: [],
        });
      });

      expect(syncMock.client.upsertSegmentLifecycle).not.toHaveBeenCalled();
      expect(syncMock.client.appendSegment).not.toHaveBeenCalled();
      expect(screen.queryByText("should not cache")).toBeNull();
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("Disconnect stops renewal and clears capturer state", async () => {
    const { rerender } = render(<PendantTranscriptView />);
    await connectAsCapturer();
    setPendantState({ status: "connected" });
    rerender(<PendantTranscriptView />);

    fireEvent.click(await screen.findByRole("button", { name: /Disconnect/ }));
    setPendantState({ status: "idle" });
    rerender(<PendantTranscriptView />);

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: /Connect/ })).toBeTruthy();
    expect(screen.queryByText(/read-only/)).toBeNull();

    act(() => {
      pendantMock.onSegment?.({
        id: "after-disconnect",
        status: "resolved",
        text: "must not commit",
        startedAt: 1_000,
        endedAt: 1_500,
        durationMs: 500,
        words: [],
      });
    });

    expect(syncMock.client?.upsertSegmentLifecycle).not.toHaveBeenCalled();
    expect(screen.queryByText("must not commit")).toBeNull();

    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(syncMock.client?.acquireLease).toHaveBeenCalledTimes(1);
  });

  it("an idle ready tab cannot monopolize the capture lease", async () => {
    render(<PendantTranscriptView />);
    await screen.findByRole("button", { name: /Connect/ });

    vi.useFakeTimers();
    try {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(syncMock.client?.acquireLease).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  });

  it("does not fan out VOICE_DM events from follower snapshots", async () => {
    syncMock.leaseConflict = true;
    const voiceListener = vi.fn();
    window.addEventListener("eliza:pendant:voice-transcript", voiceListener);
    try {
      render(<PendantTranscriptView />);
      fireEvent.click(await screen.findByRole("button", { name: /Connect/ }));
      await screen.findByRole("button", { name: /Following/ });

      act(() => {
        const current = syncMock.snapshot;
        if (!current) throw new Error("missing snapshot");
        syncMock.onSnapshot?.({
          ...current,
          session: {
            ...current.session,
            revision: current.session.revision + 1,
          },
          segments: [
            {
              id: "server-session:segment:0",
              sessionId: "server-session",
              ordinal: 0,
              status: "resolved",
              text: "follower should not dispatch",
              words: [],
              speakerCluster: null,
              speakerAlias: null,
              confidence: null,
              error: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              startedAt: "2026-01-01T00:00:00.000Z",
              endedAt: "2026-01-01T00:00:01.000Z",
              revision: 0,
            },
          ],
        });
      });

      expect(
        await screen.findByText("follower should not dispatch"),
      ).toBeTruthy();
      expect(voiceListener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(
        "eliza:pendant:voice-transcript",
        voiceListener,
      );
    }
  });

  it("treats update websocket frames as invalidation and refetches the active session", async () => {
    render(<PendantTranscriptView />);
    await screen.findByRole("button", { name: /Connect/ });

    act(() => {
      wsMock.handlers.get("pendant-session:updated")?.({
        sessionId: "server-session",
        revision: 99,
        segments: [{ text: "untrusted payload" }],
      });
    });

    await waitFor(() =>
      expect(syncMock.client?.poll).toHaveBeenCalledWith("server-session"),
    );
    expect(screen.queryByText("untrusted payload")).toBeNull();
  });

  it("clears a follower tab when the active session is deleted elsewhere", async () => {
    syncMock.leaseConflict = true;
    setServerSnapshot([
      {
        id: "server-session:segment:0",
        sessionId: "server-session",
        ordinal: 0,
        status: "resolved",
        text: "old server transcript",
        words: [],
        speakerCluster: null,
        speakerAlias: null,
        confidence: null,
        error: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
        revision: 0,
      },
    ]);
    localStorage.setItem(
      "eliza:pendant-active-session-id:v1",
      "server-session",
    );
    localStorage.setItem(
      PENDANT_TRANSCRIPT_STORAGE_KEY,
      JSON.stringify({
        segments: [
          {
            id: "local",
            status: "resolved",
            text: "optimistic",
            startedAt: 1,
            endedAt: 2,
            durationMs: 1,
            words: [],
          },
        ],
        updatedAt: 2,
        clearedThrough: null,
      }),
    );

    render(<PendantTranscriptView />);
    expect(await screen.findByText("old server transcript")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /Connect/ }));
    await screen.findByRole("button", { name: /Following/ });
    const leaseAttemptsBeforeDelete =
      syncMock.client?.acquireLease.mock.calls.length ?? 0;

    act(() => {
      wsMock.handlers.get("pendant-session:deleted")?.({
        sessionId: "server-session",
        segments: [{ text: "ignored" }],
      });
    });

    await waitFor(() =>
      expect(syncMock.client?.clearLocalSession).toHaveBeenCalledWith(
        "server-session",
      ),
    );
    expect(syncMock.client?.stopPolling).toHaveBeenCalled();
    expect(localStorage.getItem("eliza:pendant-active-session-id:v1")).toBe(
      "server-session-1",
    );
    expect(localStorage.getItem(PENDANT_TRANSCRIPT_STORAGE_KEY)).toBeNull();
    expect(syncMock.client?.createSession).toHaveBeenCalledTimes(2);
    expect(syncMock.client?.startPolling).toHaveBeenCalledWith(
      "server-session-1",
    );
    expect(syncMock.client?.acquireLease).toHaveBeenCalledTimes(
      leaseAttemptsBeforeDelete,
    );
    const connectButton = await screen.findByRole("button", {
      name: /Connect/,
    });
    expect(connectButton.hasAttribute("disabled")).toBe(false);
    expect(screen.queryByText("old server transcript")).toBeNull();
    expect(screen.queryByText("optimistic")).toBeNull();
    expect(await screen.findByText("No transcript segments yet")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(
      "Pendant session was deleted.",
    );
    expect(disconnect).toHaveBeenCalled();
  });

  it("clears an active session when update invalidation refetch returns not found", async () => {
    render(<PendantTranscriptView />);
    await screen.findByRole("button", { name: /Connect/ });
    syncMock.pollNotFound = true;

    act(() => {
      wsMock.handlers.get("pendant-session:updated")?.({
        sessionId: "server-session",
      });
    });

    await waitFor(() =>
      expect(syncMock.client?.clearLocalSession).toHaveBeenCalledWith(
        "server-session",
      ),
    );
    expect(disconnect).toHaveBeenCalled();
    expect(syncMock.client?.createSession).toHaveBeenCalledTimes(2);
    expect(syncMock.client?.startPolling).toHaveBeenCalledWith(
      "server-session-1",
    );
    expect(syncMock.client?.acquireLease).not.toHaveBeenCalled();
    const connectButton = await screen.findByRole("button", {
      name: /Connect/,
    });
    expect(connectButton.hasAttribute("disabled")).toBe(false);
    expect(await screen.findByText("No transcript segments yet")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(
      "Pendant session was deleted.",
    );
  });

  it("clears local state only after authenticated delete succeeds", async () => {
    setServerSnapshot([
      {
        id: "server-session:segment:0",
        sessionId: "server-session",
        ordinal: 0,
        status: "resolved",
        text: "delete me from the view",
        words: [],
        speakerCluster: null,
        speakerAlias: null,
        confidence: null,
        error: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
        revision: 0,
      },
    ]);
    render(<PendantTranscriptView />);
    await screen.findByText("delete me from the view");
    localStorage.setItem(
      "eliza:pendant-active-session-id:v1",
      "server-session",
    );

    fireEvent.click(screen.getByRole("button", { name: /Delete session/ }));

    expect(disconnect).toHaveBeenCalled();
    await waitFor(() =>
      expect(syncMock.client?.deleteSession).toHaveBeenCalledWith(
        "server-session",
      ),
    );
    expect(syncMock.client?.clearLocalSession).toHaveBeenCalledWith(
      "server-session",
    );
    expect(syncMock.client?.createSession).toHaveBeenCalledTimes(2);
    expect(syncMock.client?.startPolling).toHaveBeenCalledWith(
      "server-session-1",
    );
    expect(syncMock.client?.acquireLease).not.toHaveBeenCalled();
    expect(localStorage.getItem("eliza:pendant-active-session-id:v1")).toBe(
      "server-session-1",
    );
    expect(screen.queryByText("delete me from the view")).toBeNull();
    const connectButton = await screen.findByRole("button", {
      name: /Connect/,
    });
    expect(connectButton.hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("alert").textContent).toBe(
      "Pendant session deleted.",
    );
  });

  it("keeps rendered state and reports partial failure when delete fails", async () => {
    syncMock.deleteFails = true;
    setServerSnapshot([
      {
        id: "server-session:segment:0",
        sessionId: "server-session",
        ordinal: 0,
        status: "resolved",
        text: "still here",
        words: [],
        speakerCluster: null,
        speakerAlias: null,
        confidence: null,
        error: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
        revision: 0,
      },
    ]);
    render(<PendantTranscriptView />);
    expect(await screen.findByText("still here")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Delete session/ }));

    expect(disconnect).toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Delete failed; server session was not cleared: delete route failed",
    );
    expect(syncMock.client?.clearLocalSession).not.toHaveBeenCalled();
    expect(screen.getByText("still here")).toBeTruthy();
  });

  it("serializes pending append before resolved patch when ASR wins the network race", async () => {
    let resolveAppend: ((snapshot: PendantSessionSnapshot) => void) | undefined;
    syncMock.client = undefined;
    render(<PendantTranscriptView />);
    await connectAsCapturer();
    if (!syncMock.client) throw new Error("missing sync client");
    const client: TestSessionSyncClient = syncMock.client;
    client.appendSegment.mockImplementationOnce(
      async (_sessionId: string, request: UpsertPendantSegmentRequest) =>
        new Promise<PendantSessionSnapshot>((resolve) => {
          resolveAppend = () => {
            if (!syncMock.snapshot) throw new Error("missing snapshot");
            const segment: PendantSegment = {
              ...request.segment,
              id: "server-session:segment:0",
              sessionId: "server-session",
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
            };
            syncMock.snapshot = {
              ...syncMock.snapshot,
              session: { ...syncMock.snapshot.session, revision: 1 },
              segments: [segment],
            };
            syncMock.onSnapshot?.(syncMock.snapshot);
            resolve(syncMock.snapshot);
          };
        }),
    );

    act(() => {
      pendantMock.onSegment?.({
        id: "local-race",
        status: "pending",
        startedAt: 1_000,
        endedAt: 1_500,
        durationMs: 500,
      });
      pendantMock.onSegment?.({
        id: "local-race",
        status: "resolved",
        text: "race won",
        startedAt: 1_000,
        endedAt: 1_500,
        durationMs: 500,
        words: [],
      });
    });

    await waitFor(() => expect(client.appendSegment).toHaveBeenCalledTimes(1));
    expect(client.patchSegment).not.toHaveBeenCalled();
    act(() => resolveAppend?.(syncMock.snapshot as PendantSessionSnapshot));
    await waitFor(() => expect(client.patchSegment).toHaveBeenCalledTimes(1));
    expect(client.patchSegment.mock.calls[0]?.[2]).toMatchObject({
      revision: 1,
      text: "race won",
    });
  });

  it("fans out one accepted resolved segment from the capturer with exact server fields", async () => {
    const voiceListener = vi.fn();
    window.addEventListener("eliza:pendant:voice-transcript", voiceListener);
    try {
      render(<PendantTranscriptView />);
      await connectAsCapturer();

      act(() => {
        pendantMock.onSegment?.({
          id: "local-one",
          status: "pending",
          startedAt: 1_000,
          endedAt: 1_500,
          durationMs: 500,
        });
        pendantMock.onSegment?.({
          id: "local-one",
          status: "resolved",
          text: "accepted text",
          startedAt: 1_000,
          endedAt: 1_500,
          durationMs: 500,
          words: [],
        });
      });

      await waitFor(() => expect(voiceListener).toHaveBeenCalledTimes(1));
      expect(voiceListener.mock.calls[0]?.[0].detail).toEqual({
        text: "accepted text",
        sessionId: "server-session",
        segmentId: "server-session:segment:0",
        ownerId: "owner",
        agentId: "agent",
      });
      expect(
        schedulerMock.instances[0]?.addCommittedSegment,
      ).toHaveBeenCalledWith({
        id: "server-session:segment:0",
        ordinal: 0,
        text: "accepted text",
        atMs: 1_000,
      });
    } finally {
      window.removeEventListener(
        "eliza:pendant:voice-transcript",
        voiceListener,
      );
    }
  });
});
