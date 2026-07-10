/**
 * Route-level tests for pendant session sync using the real in-memory adapter.
 *
 * The runtime wrapper is intentionally narrow, but storage operations go through
 * InMemoryDatabaseAdapter rather than a fake map so create/update/delete memory
 * behavior matches the repository persistence contract.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../../core/src/database/inMemoryAdapter.ts";
import type { Memory } from "../../../core/src/types/memory.ts";
import type { UUID } from "../../../core/src/types/primitives.ts";

vi.mock("@elizaos/core", () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
  MemoryType: { CUSTOM: "custom" },
  stringToUuid: (value: string) => {
    let hash = 2166136261;
    for (const character of value) {
      hash ^= character.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    const seed = (hash >>> 0).toString(16).padStart(8, "0");
    return `${seed}-${seed.slice(0, 4)}-4${seed.slice(1, 4)}-a${seed.slice(1, 4)}-${seed}${seed.slice(0, 4)}`;
  },
}));

const { handlePendantSessionRoutes, subscribePendantCommittedSegments } =
  await import("./pendant-session-routes");

class TestRuntime {
  readonly agentId: UUID;
  readonly adapter: InMemoryDatabaseAdapter;
  private readonly memoryIds = new Set<UUID>();
  createMemoryThrows = false;
  updateMemorySucceeds = true;

  constructor(agentId: UUID, adapter = new InMemoryDatabaseAdapter()) {
    this.agentId = agentId;
    this.adapter = adapter;
    void this.adapter.init();
  }

  async getMemoryById(id: UUID): Promise<Memory | null> {
    const memories = await this.adapter.getMemoriesByIds([id]);
    return memories[0] ?? null;
  }

  async createMemory(
    memory: Memory,
    tableName: string,
    unique?: boolean,
  ): Promise<UUID> {
    if (this.createMemoryThrows) throw new Error("create failed");
    const ids = await this.adapter.createMemories([
      { memory, tableName, unique },
    ]);
    const id = ids[0];
    if (!id) throw new Error("adapter did not return memory id");
    this.memoryIds.add(id);
    return id;
  }

  async updateMemory(memory: Partial<Memory> & { id: UUID }): Promise<boolean> {
    if (!this.updateMemorySucceeds) return false;
    await this.adapter.updateMemories([memory]);
    return true;
  }

  async deleteMemory(memoryId: UUID): Promise<void> {
    await this.adapter.deleteMemories([memoryId]);
    this.memoryIds.delete(memoryId);
  }

  async deleteMemories(memoryIds: UUID[]): Promise<void> {
    await this.adapter.deleteMemories(memoryIds);
    for (const id of memoryIds) this.memoryIds.delete(id);
  }

  async getMemories(params: {
    roomId?: UUID;
    tableName: string;
    limit?: number;
    metadata?: Record<string, unknown>;
  }): Promise<Memory[]> {
    return this.adapter.getMemories(params);
  }

  async getAllMemories(): Promise<Memory[]> {
    return this.adapter.getMemoriesByIds([...this.memoryIds]);
  }
}

interface RouteResult {
  status: number;
  body: unknown;
}

function uuid(): UUID {
  return crypto.randomUUID() as UUID;
}

function makeHarness(
  ownerId = uuid(),
  adapter?: InMemoryDatabaseAdapter,
  agentId = uuid(),
) {
  const runtime = new TestRuntime(agentId, adapter);
  const broadcastWs = vi.fn();
  const state = {
    runtime: runtime as never,
    adminEntityId: ownerId,
    broadcastWs,
  };

  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<RouteResult> {
    const url = new URL(`http://127.0.0.1${path}`);
    let result: RouteResult | null = null;
    const handled = await handlePendantSessionRoutes({
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method,
      pathname: url.pathname,
      url,
      state,
      readJsonBody: async <T>() => (body ?? {}) as T,
      json: (_res, data, status = 200) => {
        result = { status, body: data };
      },
    });
    expect(handled).toBe(true);
    if (!result) throw new Error("route did not write a response");
    return result;
  }

  return { request, runtime, state, broadcastWs };
}

function okBody<T>(result: RouteResult): T {
  expect(result.status).toBeGreaterThanOrEqual(200);
  expect(result.status).toBeLessThan(300);
  return result.body as T;
}

function segment(
  _sessionId: string,
  ordinal: number,
  revision = 0,
  text = `segment ${ordinal}`,
) {
  return {
    ordinal,
    status: "resolved",
    text,
    words: [
      { word: text, startMs: ordinal * 1000, endMs: ordinal * 1000 + 500 },
    ],
    speakerCluster: null,
    speakerAlias: null,
    confidence: 0.9,
    error: null,
    startedAt: "2026-07-09T00:00:00.000Z",
    endedAt: "2026-07-09T00:00:01.000Z",
    revision,
  };
}

describe("handlePendantSessionRoutes", () => {
  it("supports capturer append observed by follower and follower pause observed by capturer", async () => {
    const h = makeHarness();
    const created = okBody<{ snapshot: { session: { id: string } } }>(
      await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-a" }),
    );
    const lease = okBody<{ leaseToken: string }>(
      await h.request("POST", "/api/pendant/sessions/sess-a/lease", {
        holder: "capturer",
        leaseMs: 30_000,
      }),
    );

    await h.request("POST", "/api/pendant/sessions/sess-a/segments", {
      leaseToken: lease.leaseToken,
      segment: segment(created.snapshot.session.id, 0),
    });
    const follower = okBody<{
      changed: true;
      snapshot: { segments: unknown[] };
    }>(await h.request("GET", "/api/pendant/sessions/sess-a?afterRevision=0"));
    expect(follower.snapshot.segments).toHaveLength(1);

    const paused = okBody<{
      snapshot: { session: { state: string; revision: number } };
    }>(
      await h.request("POST", "/api/pendant/sessions/sess-a/pause", {
        revision: 2,
      }),
    );
    expect(paused.snapshot.session.state).toBe("paused");

    const capturer = okBody<{
      changed: true;
      snapshot: { session: { state: string } };
    }>(await h.request("GET", "/api/pendant/sessions/sess-a?afterRevision=2"));
    expect(capturer.snapshot.session.state).toBe("paused");

    const resumed = okBody<{
      snapshot: { session: { state: string; revision: number } };
    }>(
      await h.request("POST", "/api/pendant/sessions/sess-a/resume", {
        revision: paused.snapshot.session.revision,
      }),
    );
    expect(resumed.snapshot.session.state).toBe("active");
  });

  it("defaults processing location to cloud and rejects client labels", async () => {
    const original = process.env.ELIZA_PENDANT_ASR_PROCESSING_LOCATION;
    const originalAsrBase = process.env.ELIZA_ASR_BASE_URL;
    process.env.ELIZA_PENDANT_ASR_PROCESSING_LOCATION = "cloud";
    delete process.env.ELIZA_ASR_BASE_URL;
    const h = makeHarness();
    try {
      const rejected = await h.request("POST", "/api/pendant/sessions", {
        sessionId: "sess-location-reject",
        processingLocation: "on-device",
      });
      expect(rejected.status).toBe(400);
      const created = okBody<{
        snapshot: { session: { processingLocation: string } };
      }>(
        await h.request("POST", "/api/pendant/sessions", {
          sessionId: "sess-location",
        }),
      );
      expect(created.snapshot.session.processingLocation).toBe("cloud");

      delete process.env.ELIZA_PENDANT_ASR_PROCESSING_LOCATION;
      process.env.ELIZA_ASR_BASE_URL = "http://127.0.0.1:3000";
      const loopback = okBody<{
        snapshot: { session: { processingLocation: string } };
      }>(
        await h.request("POST", "/api/pendant/sessions", {
          sessionId: "sess-location-local",
        }),
      );
      expect(loopback.snapshot.session.processingLocation).toBe("cloud");

      process.env.ELIZA_PENDANT_ASR_PROCESSING_LOCATION = "on-device";
      const explicit = okBody<{
        snapshot: { session: { processingLocation: string } };
      }>(
        await h.request("POST", "/api/pendant/sessions", {
          sessionId: "sess-location-explicit",
        }),
      );
      expect(explicit.snapshot.session.processingLocation).toBe("cloud");
    } finally {
      if (original === undefined) {
        delete process.env.ELIZA_PENDANT_ASR_PROCESSING_LOCATION;
      } else {
        process.env.ELIZA_PENDANT_ASR_PROCESSING_LOCATION = original;
      }
      if (originalAsrBase === undefined) {
        delete process.env.ELIZA_ASR_BASE_URL;
      } else {
        process.env.ELIZA_ASR_BASE_URL = originalAsrBase;
      }
    }
  });

  it("notifies post-commit consumers from the canonical durable segment only once", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", {
      sessionId: "sess-hook",
    });
    const lease = okBody<{ leaseToken: string }>(
      await h.request("POST", "/api/pendant/sessions/sess-hook/lease", {
        holder: "capturer",
      }),
    );
    const committed = vi.fn();
    const unsubscribe = subscribePendantCommittedSegments(committed);

    try {
      await h.request("POST", "/api/pendant/sessions/sess-hook/segments", {
        leaseToken: lease.leaseToken,
        segment: segment("sess-hook", 0),
      });
      await h.request("POST", "/api/pendant/sessions/sess-hook/segments", {
        leaseToken: lease.leaseToken,
        segment: segment("sess-hook", 0),
      });
      expect(committed).toHaveBeenCalledTimes(1);
      expect(committed.mock.calls[0]?.[0].segment).toMatchObject({
        id: "sess-hook:segment:0",
        sessionId: "sess-hook",
        ordinal: 0,
        revision: 0,
      });
      const stored = okBody<{
        changed: true;
        snapshot: { segments: unknown[] };
      }>(await h.request("GET", "/api/pendant/sessions/sess-hook"));
      expect(committed.mock.calls[0]?.[0].snapshot.segments).toEqual(
        stored.snapshot.segments,
      );
    } finally {
      unsubscribe();
    }
  });

  it("broadcasts only invalidation metadata, never transcript or snapshots", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", {
      sessionId: "sess-broadcast",
    });
    const lease = okBody<{ leaseToken: string }>(
      await h.request("POST", "/api/pendant/sessions/sess-broadcast/lease", {
        holder: "capturer",
      }),
    );
    await h.request("POST", "/api/pendant/sessions/sess-broadcast/segments", {
      leaseToken: lease.leaseToken,
      segment: segment("sess-broadcast", 0, 0, "private words"),
    });
    const frame = h.broadcastWs.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(frame).toMatchObject({
      type: "pendant-session:updated",
      sessionId: "sess-broadcast",
      agentId: h.runtime.agentId,
    });
    expect(JSON.stringify(frame)).not.toContain("private words");
    expect(frame).not.toHaveProperty("segments");
    expect(frame).not.toHaveProperty("snapshot");
    expect(frame).not.toHaveProperty("text");
  });

  it("keeps exact duplicate replay idempotent and conflicts altered same-revision content", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-b" });
    const lease = okBody<{ leaseToken: string }>(
      await h.request("POST", "/api/pendant/sessions/sess-b/lease", {
        holder: "capturer",
      }),
    );
    const first = await h.request(
      "POST",
      "/api/pendant/sessions/sess-b/segments",
      {
        leaseToken: lease.leaseToken,
        segment: segment("sess-b", 0),
      },
    );
    expect(first.status).toBe(200);
    const firstBody = okBody<{
      snapshot: {
        session: { revision: number };
        segments: Array<{ text: string }>;
      };
    }>(first);
    expect(firstBody.snapshot.session.revision).toBe(2);
    const replay = okBody<{
      snapshot: {
        session: { revision: number };
        segments: Array<{ text: string }>;
      };
    }>(
      await h.request("POST", "/api/pendant/sessions/sess-b/segments", {
        leaseToken: lease.leaseToken,
        segment: segment("sess-b", 0),
      }),
    );
    expect(replay.snapshot.session.revision).toBe(2);
    const alteredReplay = await h.request(
      "POST",
      "/api/pendant/sessions/sess-b/segments",
      {
        leaseToken: lease.leaseToken,
        segment: segment("sess-b", 0, 0, "changed"),
      },
    );
    expect(alteredReplay.status).toBe(409);
    expect(
      (alteredReplay.body as { error?: { code?: string } }).error?.code,
    ).toBe("revision_conflict");
  });

  it("rejects late revisions, client-spoofed segment fields, and out-of-order ordinal", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-b2" });
    const lease = okBody<{ leaseToken: string }>(
      await h.request("POST", "/api/pendant/sessions/sess-b2/lease", {
        holder: "capturer",
      }),
    );
    await h.request("POST", "/api/pendant/sessions/sess-b2/segments", {
      leaseToken: lease.leaseToken,
      segment: segment("sess-b2", 0),
    });
    const late = await h.request(
      "PATCH",
      "/api/pendant/sessions/sess-b2/segments/sess-b2%3Asegment%3A0",
      {
        leaseToken: lease.leaseToken,
        revision: 3,
        text: "late",
      },
    );
    expect(late.status).toBe(409);
    const malformed = await h.request(
      "POST",
      "/api/pendant/sessions/sess-b2/segments",
      {
        leaseToken: lease.leaseToken,
        segment: {
          ...segment("sess-b2", 1),
          createdAt: "2026-07-09T00:00:00.000Z",
        },
      },
    );
    expect(malformed.status).toBe(400);
    const outOfOrder = await h.request(
      "POST",
      "/api/pendant/sessions/sess-b2/segments",
      {
        leaseToken: lease.leaseToken,
        segment: segment("sess-b2", 2),
      },
    );
    expect(outOfOrder.status).toBe(400);
  });

  it("patches late ASR revisions in place, preserves id/createdAt, and advances updatedAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-09T00:00:00.000Z"));
    const h = makeHarness();
    try {
      await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-f" });
      const lease = okBody<{ leaseToken: string }>(
        await h.request("POST", "/api/pendant/sessions/sess-f/lease", {
          holder: "capturer",
        }),
      );
      const appended = okBody<{
        snapshot: {
          segments: Array<{
            id: string;
            sessionId: string;
            text: string;
            createdAt: string;
            updatedAt: string;
          }>;
        };
      }>(
        await h.request("POST", "/api/pendant/sessions/sess-f/segments", {
          leaseToken: lease.leaseToken,
          segment: { ...segment("sess-f", 0), status: "pending", text: "" },
        }),
      );
      const original = appended.snapshot.segments[0];
      expect(original?.id).toBe("sess-f:segment:0");
      expect(original?.sessionId).toBe("sess-f");
      vi.setSystemTime(new Date("2026-07-09T00:00:01.000Z"));
      const patched = okBody<{
        snapshot: {
          segments: Array<{
            id: string;
            text: string;
            createdAt: string;
            updatedAt: string;
          }>;
        };
      }>(
        await h.request(
          "PATCH",
          "/api/pendant/sessions/sess-f/segments/sess-f%3Asegment%3A0",
          {
            leaseToken: lease.leaseToken,
            revision: 1,
            status: "resolved",
            text: "resolved words",
            speakerCluster: "speaker-1",
          },
        ),
      );
      expect(patched.snapshot.segments).toHaveLength(1);
      expect(patched.snapshot.segments[0]?.id).toBe(original?.id);
      expect(patched.snapshot.segments[0]?.createdAt).toBe(original?.createdAt);
      expect(patched.snapshot.segments[0]?.updatedAt).not.toBe(
        original?.updatedAt,
      );
      expect(patched.snapshot.segments[0]?.text).toBe("resolved words");

      const patchReplay = await h.request(
        "PATCH",
        "/api/pendant/sessions/sess-f/segments/sess-f%3Asegment%3A0",
        {
          leaseToken: lease.leaseToken,
          revision: 1,
          text: "different words",
        },
      );
      expect(patchReplay.status).toBe(409);
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes ended sessions immutable", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-f2" });
    const lease = okBody<{ leaseToken: string }>(
      await h.request("POST", "/api/pendant/sessions/sess-f2/lease", {
        holder: "capturer",
      }),
    );
    await h.request("POST", "/api/pendant/sessions/sess-f2/segments", {
      leaseToken: lease.leaseToken,
      segment: { ...segment("sess-f2", 0), status: "pending", text: "" },
    });

    const ended = okBody<{ snapshot: { session: { state: string } } }>(
      await h.request("POST", "/api/pendant/sessions/sess-f2/end", {}),
    );
    expect(ended.snapshot.session.state).toBe("ended");
    const blocked = await h.request(
      "PATCH",
      "/api/pendant/sessions/sess-f2/segments/sess-f2%3Asegment%3A0",
      {
        leaseToken: lease.leaseToken,
        revision: 1,
        text: "too late",
      },
    );
    expect(blocked.status).toBe(409);
    const exported = okBody<{ export: { segments: Array<{ text: string }> } }>(
      await h.request("GET", "/api/pendant/sessions/sess-f2/export"),
    );
    expect(exported.export.segments[0]?.text).toBe("");
  });

  it("allows lease takeover only after expiry and blocks appends while paused", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-c" });
    const first = okBody<{ leaseToken: string }>(
      await h.request("POST", "/api/pendant/sessions/sess-c/lease", {
        holder: "a",
        leaseMs: 50,
      }),
    );
    const conflict = await h.request(
      "POST",
      "/api/pendant/sessions/sess-c/lease",
      {
        holder: "b",
        leaseMs: 30_000,
      },
    );
    expect(conflict.status).toBe(409);
    const renameRenewal = await h.request(
      "POST",
      "/api/pendant/sessions/sess-c/lease",
      {
        holder: "b",
        leaseToken: first.leaseToken,
        leaseMs: 30_000,
      },
    );
    expect(renameRenewal.status).toBe(409);
    const renewal = okBody<{
      leaseToken: string;
      session: { captureLease: { holder: string } };
    }>(
      await h.request("POST", "/api/pendant/sessions/sess-c/lease", {
        holder: "a",
        leaseToken: first.leaseToken,
        leaseMs: 50,
      }),
    );
    expect(renewal.session.captureLease.holder).toBe("a");
    await new Promise((resolve) => setTimeout(resolve, 60));
    const second = okBody<{ leaseToken: string }>(
      await h.request("POST", "/api/pendant/sessions/sess-c/lease", {
        holder: "b",
        leaseMs: 30_000,
      }),
    );
    expect(second.leaseToken).not.toBe(first.leaseToken);

    await h.request("POST", "/api/pendant/sessions/sess-c/pause", {});
    const blocked = await h.request(
      "POST",
      "/api/pendant/sessions/sess-c/segments",
      {
        leaseToken: second.leaseToken,
        segment: segment("sess-c", 0),
      },
    );
    expect(blocked.status).toBe(409);
  });

  it("converges polling, deletes from memory, and enforces owner and agent isolation", async () => {
    const owner = uuid();
    const h = makeHarness(owner);
    await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-d" });
    const unchanged = okBody<{ changed: false }>(
      await h.request("GET", "/api/pendant/sessions/sess-d?afterRevision=0"),
    );
    expect(unchanged.changed).toBe(false);

    const isolated = makeHarness(uuid());
    isolated.state.runtime = h.state.runtime;
    const missing = await isolated.request(
      "GET",
      "/api/pendant/sessions/sess-d",
    );
    expect(missing.status).toBe(404);

    const differentAgent = makeHarness(owner, h.runtime.adapter);
    const agentMissing = await differentAgent.request(
      "GET",
      "/api/pendant/sessions/sess-d",
    );
    expect(agentMissing.status).toBe(404);

    const deleted = await h.request("DELETE", "/api/pendant/sessions/sess-d");
    expect(deleted.status).toBe(200);
    expect(h.broadcastWs).toHaveBeenCalledWith({
      type: "pendant-session:deleted",
      sessionId: "sess-d",
      agentId: h.runtime.agentId,
    });
    const afterDelete = await h.request("GET", "/api/pendant/sessions/sess-d");
    expect(afterDelete.status).toBe(404);
  });

  it("enforces two-tenant isolation on a shared adapter", async () => {
    const adapter = new InMemoryDatabaseAdapter();
    const agent = uuid();
    const tenantA = makeHarness(uuid(), adapter, agent);
    const tenantB = makeHarness(uuid(), adapter, agent);
    await tenantA.request("POST", "/api/pendant/sessions", {
      sessionId: "shared-known-id",
    });
    const blocked = await tenantB.request(
      "GET",
      "/api/pendant/sessions/shared-known-id",
    );
    expect(blocked.status).toBe(404);
    const deleteBlocked = await tenantB.request(
      "DELETE",
      "/api/pendant/sessions/shared-known-id",
    );
    expect(deleteBlocked.status).toBe(404);
    const fanoutBlocked = await tenantB.request(
      "POST",
      "/api/pendant/sessions/shared-known-id/segments",
      {
        leaseToken: "known-token",
        segment: segment("shared-known-id", 0),
      },
    );
    expect(fanoutBlocked.status).toBe(404);
  });

  it("cascades delete to pendant insight memories and session-tagged VOICE_DM turns", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-del" });
    const lease = okBody<{ leaseToken: string }>(
      await h.request("POST", "/api/pendant/sessions/sess-del/lease", {
        holder: "capturer",
      }),
    );
    const appended = okBody<{
      snapshot: { segments: Array<{ id: string }> };
    }>(
      await h.request("POST", "/api/pendant/sessions/sess-del/segments", {
        leaseToken: lease.leaseToken,
        segment: segment("sess-del", 0),
      }),
    );
    const segmentId = appended.snapshot.segments[0]?.id;
    expect(segmentId).toBeTruthy();
    const insightId = uuid();
    const voiceId = uuid();
    await h.runtime.createMemory(
      {
        id: insightId,
        agentId: h.runtime.agentId,
        entityId: h.runtime.agentId,
        roomId: h.runtime.agentId,
        content: { text: "insight", source: "pendant-insights" },
        metadata: {
          source: "pendant-insights",
          ownerId: h.state.adminEntityId,
          sessionId: "sess-del",
          sourceSegmentIds: [segmentId],
        },
      } as Memory,
      "messages",
      true,
    );
    await h.runtime.createMemory(
      {
        id: voiceId,
        agentId: h.runtime.agentId,
        entityId: uuid(),
        roomId: uuid(),
        content: {
          text: "segment 0",
          channelType: "VOICE_DM",
          metadata: {
            voiceSource: "pendant",
            ownerId: h.state.adminEntityId,
            pendantSessionId: "sess-del",
            pendantSegmentId: segmentId,
          },
        },
        metadata: { type: "message" },
      } as Memory,
      "messages",
      true,
    );
    await h.request("DELETE", "/api/pendant/sessions/sess-del");
    expect(await h.runtime.getMemoryById(insightId)).toBeNull();
    expect(await h.runtime.getMemoryById(voiceId)).toBeNull();
  });

  it("does not cascade-delete another tenant's derived memories for the same known session id", async () => {
    const adapter = new InMemoryDatabaseAdapter();
    const agent = uuid();
    const tenantA = makeHarness(uuid(), adapter, agent);
    const tenantB = makeHarness(uuid(), adapter, agent);
    await tenantA.request("POST", "/api/pendant/sessions", {
      sessionId: "known-shared-session",
    });
    await tenantB.request("POST", "/api/pendant/sessions", {
      sessionId: "known-shared-session",
    });
    const leaseA = okBody<{ leaseToken: string }>(
      await tenantA.request(
        "POST",
        "/api/pendant/sessions/known-shared-session/lease",
        { holder: "capturer" },
      ),
    );
    const leaseB = okBody<{ leaseToken: string }>(
      await tenantB.request(
        "POST",
        "/api/pendant/sessions/known-shared-session/lease",
        { holder: "capturer" },
      ),
    );
    const segmentA = okBody<{ snapshot: { segments: Array<{ id: string }> } }>(
      await tenantA.request(
        "POST",
        "/api/pendant/sessions/known-shared-session/segments",
        { leaseToken: leaseA.leaseToken, segment: segment("known", 0) },
      ),
    ).snapshot.segments[0]?.id;
    const segmentB = okBody<{ snapshot: { segments: Array<{ id: string }> } }>(
      await tenantB.request(
        "POST",
        "/api/pendant/sessions/known-shared-session/segments",
        { leaseToken: leaseB.leaseToken, segment: segment("known", 0) },
      ),
    ).snapshot.segments[0]?.id;
    const aInsight = uuid();
    const bInsight = uuid();
    const bVoice = uuid();
    await tenantA.runtime.createMemory(
      {
        id: aInsight,
        agentId: tenantA.runtime.agentId,
        entityId: tenantA.state.adminEntityId as UUID,
        roomId: uuid(),
        content: { text: "tenant a insight", source: "pendant-insights" },
        metadata: {
          source: "pendant-insights",
          ownerId: tenantA.state.adminEntityId,
          sessionId: "known-shared-session",
          sourceSegmentIds: [segmentA],
        },
      } as Memory,
      "messages",
      true,
    );
    await tenantB.runtime.createMemory(
      {
        id: bInsight,
        agentId: tenantB.runtime.agentId,
        entityId: tenantB.state.adminEntityId as UUID,
        roomId: uuid(),
        content: { text: "tenant b insight", source: "pendant-insights" },
        metadata: {
          source: "pendant-insights",
          ownerId: tenantB.state.adminEntityId,
          sessionId: "known-shared-session",
          sourceSegmentIds: [segmentB],
        },
      } as Memory,
      "messages",
      true,
    );
    await tenantB.runtime.createMemory(
      {
        id: bVoice,
        agentId: tenantB.runtime.agentId,
        entityId: tenantB.state.adminEntityId as UUID,
        roomId: uuid(),
        content: {
          text: "tenant b voice",
          channelType: "VOICE_DM",
          metadata: {
            voiceSource: "pendant",
            ownerId: tenantB.state.adminEntityId,
            pendantSessionId: "known-shared-session",
            pendantSegmentId: segmentB,
          },
        },
        metadata: { type: "message" },
      } as Memory,
      "messages",
      true,
    );

    await tenantA.request(
      "DELETE",
      "/api/pendant/sessions/known-shared-session",
    );

    expect(await tenantA.runtime.getMemoryById(aInsight)).toBeNull();
    expect(await tenantB.runtime.getMemoryById(bInsight)).not.toBeNull();
    expect(await tenantB.runtime.getMemoryById(bVoice)).not.toBeNull();
  });

  it("fails delete explicitly when derived-memory cascade cannot run", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", {
      sessionId: "sess-cascade-unavailable",
    });
    (h.state.runtime as { deleteMemories?: unknown }).deleteMemories =
      undefined;

    const result = await h.request(
      "DELETE",
      "/api/pendant/sessions/sess-cascade-unavailable",
    );
    expect(result.status).toBe(503);
    expect((result.body as { error?: { code?: string } }).error?.code).toBe(
      "store_unavailable",
    );
    const stillPresent = await h.request(
      "GET",
      "/api/pendant/sessions/sess-cascade-unavailable",
    );
    expect(stillPresent.status).toBe(200);
  });

  it("requires authenticated admin identity", async () => {
    const h = makeHarness();
    h.state.adminEntityId = null as never;
    const result = await h.request("POST", "/api/pendant/sessions", {
      sessionId: "sess-auth",
    });
    expect(result.status).toBe(401);
    expect((result.body as { error?: { code?: string } }).error?.code).toBe(
      "auth",
    );
  });

  it("returns typed validation errors for malformed encoding and invalid afterRevision", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-v" });

    for (const query of ["abc", "1.2", "-1"]) {
      const result = await h.request(
        "GET",
        `/api/pendant/sessions/sess-v?afterRevision=${query}`,
      );
      expect(result.status).toBe(400);
      expect((result.body as { error?: { code?: string } }).error?.code).toBe(
        "validation",
      );
    }

    const malformed = await h.request("GET", "/api/pendant/sessions/%E0%A4%A");
    expect(malformed.status).toBe(400);
    expect((malformed.body as { error?: { code?: string } }).error?.code).toBe(
      "validation",
    );
  });

  it("maps storage create and update failures to typed store_unavailable", async () => {
    const createHarness = makeHarness();
    createHarness.runtime.createMemoryThrows = true;
    const createFailed = await createHarness.request(
      "POST",
      "/api/pendant/sessions",
      { sessionId: "sess-store" },
    );
    expect(createFailed.status).toBe(503);
    expect(
      (createFailed.body as { error?: { code?: string } }).error?.code,
    ).toBe("store_unavailable");

    const updateHarness = makeHarness();
    await updateHarness.request("POST", "/api/pendant/sessions", {
      sessionId: "sess-store-update",
    });
    updateHarness.runtime.updateMemorySucceeds = false;
    const updateFailed = await updateHarness.request(
      "POST",
      "/api/pendant/sessions/sess-store-update/lease",
      { holder: "capturer" },
    );
    expect(updateFailed.status).toBe(503);
    expect(
      (updateFailed.body as { error?: { code?: string } }).error?.code,
    ).toBe("store_unavailable");
  });

  it("exports portable sessions and rejects insight refs for unknown segments", async () => {
    const h = makeHarness();
    await h.request("POST", "/api/pendant/sessions", { sessionId: "sess-e" });
    const badRef = await h.request(
      "PUT",
      "/api/pendant/sessions/sess-e/insight-refs",
      {
        insightRefs: [
          {
            id: "i1",
            segmentIds: ["missing"],
            createdAt: "2026-07-09T00:00:00.000Z",
            updatedAt: "2026-07-09T00:00:00.000Z",
            revision: 0,
          },
        ],
      },
    );
    expect(badRef.status).toBe(400);
    const exported = okBody<{ export: { session: { id: string } } }>(
      await h.request("GET", "/api/pendant/sessions/sess-e/export"),
    );
    expect(exported.export.session.id).toBe("sess-e");
  });
});
