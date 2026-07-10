/**
 * Unit tests for the pendant session sync browser adapter.
 *
 * The server route owns persistence; this file checks client-side queueing and
 * cursor convergence around fetch failures and replay.
 */

import type {
  PendantSegment,
  PendantSessionSnapshot,
  UpsertPendantSegmentRequest,
} from "@elizaos/shared/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithCsrfMock = vi.hoisted(() => vi.fn());

vi.mock("../api/csrf-client", () => ({
  fetchWithCsrf: fetchWithCsrfMock,
}));

vi.mock("../utils/asset-url", () => ({
  resolveApiUrl: (url: string) => url,
}));

vi.mock("@elizaos/shared/contracts", () => ({
  PENDANT_SESSION_SYNC_API_PREFIX: "/api/pendant/sessions",
  pendantSegmentId: (sessionId: string, ordinal: number) =>
    `${sessionId}:segment:${ordinal}`,
}));

const { PendantSessionSyncClient } = await import("./session-sync-client");

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function snapshot(
  revision: number,
  sessionId = "sess-a",
  segments: PendantSegment[] = [],
): PendantSessionSnapshot {
  return {
    schemaVersion: 1,
    session: {
      id: sessionId,
      ownerId: "owner",
      agentId: "agent",
      startedAt: "2026-07-09T00:00:00.000Z",
      endedAt: null,
      state: "active",
      captureLease: null,
      processingLocation: "on-device",
      revision,
    },
    segments,
    insightRefs: [],
  };
}

function segment(
  status: PendantSegment["status"],
  text: string,
  revision = 0,
): PendantSegment {
  return {
    id: "sess-a:segment:0",
    sessionId: "sess-a",
    ordinal: 0,
    status,
    text,
    words: [],
    speakerCluster: null,
    speakerAlias: null,
    confidence: null,
    error: null,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
    startedAt: "2026-07-09T00:00:00.000Z",
    endedAt: status === "pending" ? null : "2026-07-09T00:00:01.000Z",
    revision,
  };
}

function lifecycleRequest(
  status: PendantSegment["status"],
  text: string,
): UpsertPendantSegmentRequest {
  return {
    leaseToken: "lease",
    segment: {
      ordinal: 0,
      status,
      text,
      words: [],
      speakerCluster: null,
      speakerAlias: null,
      confidence: null,
      error: null,
      startedAt: "2026-07-09T00:00:00.000Z",
      endedAt: status === "pending" ? null : "2026-07-09T00:00:01.000Z",
      revision: 0,
    },
  };
}

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (body: unknown, status?: number) => void;
  reject: (error: unknown) => void;
} {
  let resolvePromise: (value: Response) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<Response>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: (body, status = 200) => resolvePromise(response(body, status)),
    reject: rejectPromise,
  };
}

describe("PendantSessionSyncClient", () => {
  beforeEach(() => {
    fetchWithCsrfMock.mockReset();
  });

  it("queues offline appends and drains them before polling", async () => {
    const fetcher = fetchWithCsrfMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(response({ ok: true, snapshot: snapshot(1) }))
      .mockResolvedValueOnce(response({ ok: true, changed: false }));
    const seen: number[] = [];
    const client = new PendantSessionSyncClient({
      fetcher,
      onSnapshot: (next) => seen.push(next.session.revision),
    });
    Object.defineProperty(client, "snapshot", {
      value: snapshot(0),
      writable: true,
    });

    const local = await client.appendSegment("sess-a", {
      leaseToken: "lease",
      segment: {
        ordinal: 0,
        status: "resolved",
        text: "hello",
        words: [],
        speakerCluster: null,
        speakerAlias: null,
        confidence: null,
        error: null,
        startedAt: "2026-07-09T00:00:00.000Z",
        endedAt: null,
        revision: 0,
      },
    });

    expect(local.session.revision).toBe(0);
    expect(client.unsyncedQueue).toHaveLength(1);
    await client.flushQueue();
    expect(client.unsyncedQueue).toHaveLength(0);
    await client.poll("sess-a");
    expect(seen).toEqual([1]);
    expect(fetcher.mock.calls.at(-1)?.[0]).toContain("afterRevision=1");
  });

  it("emits the final queue drain before a changed-false poll", async () => {
    const fetcher = fetchWithCsrfMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(response({ ok: true, snapshot: snapshot(1) }))
      .mockResolvedValueOnce(response({ ok: true, changed: false }));
    const queueLengths: number[] = [];
    const seenSnapshots: number[] = [];
    const client = new PendantSessionSyncClient({
      fetcher,
      onQueueChange: (length) => queueLengths.push(length),
      onSnapshot: (next) => seenSnapshots.push(next.session.revision),
    });
    Object.defineProperty(client, "snapshot", {
      value: snapshot(0),
      writable: true,
    });

    await client.appendSegment("sess-a", {
      leaseToken: "lease",
      segment: {
        ordinal: 0,
        status: "resolved",
        text: "hello",
        words: [],
        speakerCluster: null,
        speakerAlias: null,
        confidence: null,
        error: null,
        startedAt: "2026-07-09T00:00:00.000Z",
        endedAt: null,
        revision: 0,
      },
    });
    await client.flushQueue();
    await client.poll("sess-a");

    expect(seenSnapshots).toEqual([1]);
    expect(queueLengths).toEqual([1, 0]);
    expect(client.unsyncedQueue).toHaveLength(0);
  });

  it("surfaces offline revision conflicts and converges after explicit discard", async () => {
    const fetcher = fetchWithCsrfMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        response(
          {
            ok: false,
            error: {
              code: "revision_conflict",
              message: "stale segment",
              currentRevision: 3,
            },
          },
          409,
        ),
      )
      .mockResolvedValueOnce(
        response({ ok: true, changed: true, snapshot: snapshot(3) }),
      );
    const client = new PendantSessionSyncClient({ fetcher });
    Object.defineProperty(client, "snapshot", {
      value: snapshot(0),
      writable: true,
    });

    await client.appendSegment("sess-a", {
      leaseToken: "lease",
      segment: {
        ordinal: 0,
        status: "resolved",
        text: "hello",
        words: [],
        speakerCluster: null,
        speakerAlias: null,
        confidence: null,
        error: null,
        startedAt: "2026-07-09T00:00:00.000Z",
        endedAt: null,
        revision: 0,
      },
    });
    await expect(client.flushQueue()).rejects.toMatchObject({
      response: { error: { code: "revision_conflict" } },
    });
    expect(client.unsyncedQueue[0]?.status).toBe("conflict");
    expect(client.discardUnsyncedMutation("append:sess-a:0")).toBe(true);
    await client.poll("sess-a");
    expect(client.currentSnapshot?.session.revision).toBe(3);
  });

  it("does not reuse a revision cursor when switching sessions", async () => {
    const fetcher = fetchWithCsrfMock.mockResolvedValueOnce(
      response({
        ok: true,
        changed: true,
        snapshot: snapshot(0, "sess-b"),
      }),
    );
    const client = new PendantSessionSyncClient({ fetcher });
    Object.defineProperty(client, "snapshot", {
      value: snapshot(5, "sess-a"),
      writable: true,
    });

    await client.poll("sess-b");
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/pendant/sessions/sess-b");
    expect(client.currentSnapshot?.session.id).toBe("sess-b");
  });

  it("ignores stale snapshots during convergence", async () => {
    const client = new PendantSessionSyncClient();
    Object.defineProperty(client, "snapshot", {
      value: snapshot(5),
      writable: true,
    });
    (
      client as unknown as { acceptSnapshot: (value: unknown) => void }
    ).acceptSnapshot(snapshot(3));
    expect(client.currentSnapshot?.session.revision).toBe(5);
  });

  it("does not reschedule an in-flight poll after stop", async () => {
    vi.useFakeTimers();
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const client = new PendantSessionSyncClient({ fetcher, pollMs: 500 });

    try {
      client.startPolling("sess-a");
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      client.stopPolling();
      resolveFetch?.(response({ ok: true, changed: false }));
      await Promise.resolve();
      await Promise.resolve();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      client.stopPolling();
      vi.useRealTimers();
    }
  });

  it("invalidates deferred create and poll responses after a local clear", async () => {
    const create = deferredResponse();
    const poll = deferredResponse();
    const fetcher = vi
      .fn()
      .mockReturnValueOnce(create.promise)
      .mockReturnValueOnce(poll.promise);
    const seen: string[] = [];
    const client = new PendantSessionSyncClient({
      fetcher,
      onSnapshot: (next) => seen.push(next.session.id),
    });

    const createPromise = client.createSession({ sessionId: "sess-a" });
    client.clearLocalSession("sess-a");
    create.resolve({ ok: true, snapshot: snapshot(1, "sess-a") });
    await expect(createPromise).resolves.toMatchObject({
      session: { id: "sess-a" },
    });
    expect(client.currentSnapshot).toBeNull();
    expect(seen).toEqual([]);

    const pollPromise = client.poll("sess-a");
    client.clearLocalSession("sess-a");
    poll.resolve({
      ok: true,
      changed: true,
      snapshot: snapshot(2, "sess-a"),
    });
    await expect(pollPromise).resolves.toMatchObject({
      session: { revision: 2 },
    });
    expect(client.currentSnapshot).toBeNull();
    expect(seen).toEqual([]);
  });

  it("does not reaccept deferred queued mutations after local clear", async () => {
    const queued = deferredResponse();
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockReturnValueOnce(queued.promise);
    const seen: number[] = [];
    const client = new PendantSessionSyncClient({
      fetcher,
      onSnapshot: (next) => seen.push(next.session.revision),
    });
    Object.defineProperty(client, "snapshot", {
      value: snapshot(0),
      writable: true,
    });

    await client.appendSegment("sess-a", {
      leaseToken: "lease",
      segment: {
        ordinal: 0,
        status: "resolved",
        text: "hello",
        words: [],
        speakerCluster: null,
        speakerAlias: null,
        confidence: null,
        error: null,
        startedAt: "2026-07-09T00:00:00.000Z",
        endedAt: null,
        revision: 0,
      },
    });
    const flush = client.flushQueue();
    await Promise.resolve();
    client.clearLocalSession("sess-a");
    queued.resolve({ ok: true, snapshot: snapshot(1) });
    await flush;

    expect(client.currentSnapshot).toBeNull();
    expect(client.unsyncedQueue).toHaveLength(0);
    expect(seen).toEqual([]);
  });

  it("does not requeue a deferred offline mutation after local clear", async () => {
    const append = deferredResponse();
    const fetcher = vi.fn().mockReturnValueOnce(append.promise);
    const client = new PendantSessionSyncClient({ fetcher });
    Object.defineProperty(client, "snapshot", {
      value: snapshot(0),
      writable: true,
    });

    const appendPromise = client.appendSegment("sess-a", {
      leaseToken: "lease",
      segment: {
        ordinal: 0,
        status: "resolved",
        text: "hello",
        words: [],
        speakerCluster: null,
        speakerAlias: null,
        confidence: null,
        error: null,
        startedAt: "2026-07-09T00:00:00.000Z",
        endedAt: null,
        revision: 0,
      },
    });
    client.clearLocalSession("sess-a");
    append.reject(new TypeError("Failed to fetch"));

    await expect(appendPromise).rejects.toThrow("Failed to fetch");
    expect(client.currentSnapshot).toBeNull();
    expect(client.unsyncedQueue).toHaveLength(0);
  });

  it("clears unsynced cache without touching the authoritative snapshot", () => {
    const client = new PendantSessionSyncClient();
    Object.defineProperty(client, "snapshot", {
      value: snapshot(4),
      writable: true,
    });
    client.unsyncedQueue.push({
      id: "queued",
      status: "pending",
      run: async () => snapshot(5),
    });

    client.clearUnsyncedCache();

    expect(client.currentSnapshot?.session.revision).toBe(4);
    expect(client.unsyncedQueue).toHaveLength(0);
  });

  it("emits drained queue state before notifying replayed snapshots", async () => {
    const fetcher = fetchWithCsrfMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        response({
          ok: true,
          snapshot: snapshot(1, "sess-a", [segment("resolved", "done")]),
        }),
      );
    const events: string[] = [];
    let client!: InstanceType<typeof PendantSessionSyncClient>;
    client = new PendantSessionSyncClient({
      fetcher,
      onQueueChange: (count) => events.push(`queue:${count}`),
      onSnapshot: () => events.push(`snapshot:${client.unsyncedQueue.length}`),
    });
    Object.defineProperty(client, "snapshot", {
      value: snapshot(0),
      writable: true,
    });

    await client.upsertSegmentLifecycle(
      "sess-a",
      lifecycleRequest("resolved", "done"),
    );
    expect(client.unsyncedQueue).toHaveLength(1);
    events.length = 0;

    await client.flushQueue();

    expect(client.unsyncedQueue).toHaveLength(0);
    expect(events).toEqual(["queue:0", "snapshot:0"]);
  });

  it("coalesces pending and resolved offline lifecycle updates into one canonical segment", async () => {
    const fetcher = fetchWithCsrfMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(
        response({
          ok: true,
          snapshot: snapshot(1, "sess-a", [segment("resolved", "done")]),
        }),
      );
    const client = new PendantSessionSyncClient({ fetcher });
    Object.defineProperty(client, "snapshot", {
      value: snapshot(0),
      writable: true,
    });

    await client.upsertSegmentLifecycle(
      "sess-a",
      lifecycleRequest("pending", ""),
    );
    await client.upsertSegmentLifecycle(
      "sess-a",
      lifecycleRequest("resolved", "done"),
    );

    expect(client.unsyncedQueue).toHaveLength(1);
    expect(client.unsyncedQueue[0]?.id).toBe("segment-lifecycle:sess-a:0");
    await client.flushQueue();

    expect(client.unsyncedQueue).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(fetcher.mock.calls[1]?.[0]).toBe(
      "/api/pendant/sessions/sess-a/segments",
    );
    expect(
      JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).segment,
    ).toMatchObject({ ordinal: 0, status: "resolved", text: "done" });
    expect(client.currentSnapshot?.segments).toHaveLength(1);
    expect(client.currentSnapshot?.segments[0]).toMatchObject({
      ordinal: 0,
      status: "resolved",
      text: "done",
    });
  });

  it("reruns a replaced lifecycle operation after the older flush completes", async () => {
    const append = deferredResponse();
    const fetcher = fetchWithCsrfMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockReturnValueOnce(append.promise)
      .mockResolvedValueOnce(
        response({
          ok: true,
          snapshot: snapshot(2, "sess-a", [segment("resolved", "done", 1)]),
        }),
      );
    const client = new PendantSessionSyncClient({ fetcher });
    Object.defineProperty(client, "snapshot", {
      value: snapshot(0),
      writable: true,
    });

    await client.upsertSegmentLifecycle(
      "sess-a",
      lifecycleRequest("pending", ""),
    );
    const flush = client.flushQueue();
    await Promise.resolve();
    await client.upsertSegmentLifecycle(
      "sess-a",
      lifecycleRequest("resolved", "done"),
    );

    append.resolve({
      ok: true,
      snapshot: snapshot(1, "sess-a", [segment("pending", "", 0)]),
    });
    await flush;

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(fetcher.mock.calls[2]?.[1]?.method).toBe("PATCH");
    expect(fetcher.mock.calls[2]?.[0]).toBe(
      "/api/pendant/sessions/sess-a/segments/sess-a%3Asegment%3A0",
    );
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toMatchObject({
      revision: 1,
      status: "resolved",
      text: "done",
    });
    expect(client.currentSnapshot?.segments).toEqual([
      expect.objectContaining({
        ordinal: 0,
        status: "resolved",
        text: "done",
        revision: 1,
      }),
    ]);
  });

  it("does not let a stale pending lifecycle replay regress a resolved canonical segment", async () => {
    const fetcher = fetchWithCsrfMock;
    const client = new PendantSessionSyncClient({ fetcher });
    Object.defineProperty(client, "snapshot", {
      value: snapshot(1, "sess-a", [segment("resolved", "done", 1)]),
      writable: true,
    });
    client.unsyncedQueue.push({
      id: "segment-lifecycle:sess-a:0",
      status: "pending",
      run: () =>
        (
          client as unknown as {
            runSegmentLifecycleUpsert: (
              sessionId: string,
              request: UpsertPendantSegmentRequest,
            ) => Promise<PendantSessionSnapshot>;
          }
        ).runSegmentLifecycleUpsert("sess-a", lifecycleRequest("pending", "")),
    });

    await client.flushQueue();

    expect(fetcher).not.toHaveBeenCalled();
    expect(client.currentSnapshot?.segments[0]).toMatchObject({
      status: "resolved",
      text: "done",
      revision: 1,
    });
  });
});
