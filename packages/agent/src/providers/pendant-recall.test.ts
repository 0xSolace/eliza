/**
 * Coverage for pendantRecallProvider — the gap #2 retrieval provider that feeds
 * captured pendant transcript segments + insights into the agent's context.
 *
 * Proves the load-bearing guarantees:
 * - OFF by default (no flag → empty render, no reads issued).
 * - Relevance: BM25 surfaces the on-topic segment/insight, drops off-topic noise.
 * - Provenance: injected block carries canonical `<sessionId>:segment:<ordinal>`
 *   segment ids and insight memory ids so answers can cite.
 * - Tenancy isolation: a session/insight from another owner or agent is never
 *   surfaced, even if it lands in the fake store.
 * - Deletion respected: reads the LIVE store, so a deleted session is absent
 *   (nothing to surface).
 * - Pause semantics: paused sessions stay historically readable and are tagged,
 *   never invented.
 * - Token budget: a tight char budget caps the block; the count is reported.
 *
 * Deterministic: @elizaos/core is partially mocked so
 * resolveCanonicalOwnerIdForMessage returns a fixed owner; the runtime's
 * getSetting/getMemories are in-memory vi fakes.
 */
import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import {
  createMockRuntime,
  MOCK_AGENT_ID,
} from "@elizaos/core/testing/mock-runtime";
import { pendantSegmentId } from "@elizaos/shared/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-1111-1111-111111111111";
const OTHER_OWNER = "22222222-2222-2222-2222-222222222222";
const AGENT = MOCK_AGENT_ID as string;
const OTHER_AGENT = "33333333-3333-3333-3333-333333333333";

// Drive the canonical owner resolver to a fixed owner without wiring settings.
const resolveOwner =
  vi.fn<(runtime: IAgentRuntime, message: Memory) => Promise<string | null>>();
vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    resolveCanonicalOwnerIdForMessage: (
      runtime: IAgentRuntime,
      message: Memory,
    ) => resolveOwner(runtime, message),
  };
});

// Import after the mock so the provider binds the mocked resolver.
const { pendantRecallProvider, rankAndCap, resolvePendantRecallConfig } =
  await import("./pendant-recall.ts");

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-07-10T12:00:00.000Z");

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function segment(params: {
  sessionId: string;
  ordinal: number;
  text: string;
  offsetMs?: number;
  status?: "pending" | "resolved" | "asr-error";
  speakerAlias?: string | null;
}) {
  const at = iso(params.offsetMs ?? -60_000);
  return {
    id: pendantSegmentId(params.sessionId, params.ordinal),
    sessionId: params.sessionId,
    ordinal: params.ordinal,
    status: params.status ?? "resolved",
    text: params.text,
    words: [],
    speakerCluster: null,
    speakerAlias: params.speakerAlias ?? null,
    confidence: 0.9,
    error: null,
    createdAt: at,
    updatedAt: at,
    startedAt: at,
    endedAt: at,
    revision: 0,
  };
}

function sessionMemory(params: {
  sessionId: string;
  ownerId?: string;
  agentId?: string;
  state?: "active" | "paused" | "ended";
  segments: ReturnType<typeof segment>[];
  offsetMs?: number;
}): Memory {
  const ownerId = params.ownerId ?? OWNER;
  const agentId = params.agentId ?? AGENT;
  const at = iso(params.offsetMs ?? -120_000);
  const doc = {
    schemaVersion: 1 as const,
    session: {
      id: params.sessionId,
      ownerId,
      agentId,
      startedAt: at,
      endedAt: params.state === "ended" ? iso(-30_000) : null,
      state: params.state ?? "active",
      captureLease: null,
      processingLocation: "cloud" as const,
      revision: 1,
    },
    segments: params.segments,
    insightRefs: [],
  };
  return {
    id: `sessmem-${params.sessionId}` as UUID,
    entityId: ownerId as UUID,
    agentId: agentId as UUID,
    roomId: "room" as UUID,
    content: {
      text: `Pendant session ${params.sessionId}`,
      pendantSession: doc,
    },
    metadata: { type: "custom", source: "pendant_session_sync" },
    createdAt: NOW,
  } as unknown as Memory;
}

function insightMemory(params: {
  id: string;
  sessionId: string;
  ownerId?: string;
  agentId?: string;
  text: string;
  sourceSegmentIds: string[];
  offsetMs?: number;
}): Memory {
  const ownerId = params.ownerId ?? OWNER;
  const agentId = params.agentId ?? AGENT;
  return {
    id: params.id as UUID,
    entityId: ownerId as UUID,
    agentId: agentId as UUID,
    roomId: "insight-room" as UUID,
    createdAt: NOW + (params.offsetMs ?? -90_000),
    content: { text: params.text, source: "pendant-insights" },
    metadata: {
      type: "custom",
      source: "pendant-insights",
      ownerId,
      sessionId: params.sessionId,
      agentId,
      sourceSegmentIds: params.sourceSegmentIds,
    },
  } as unknown as Memory;
}

/**
 * Build a runtime whose getMemories routes by tableName: `pendant_sessions`
 * returns session docs, `messages` returns insight memories.
 */
function makeRuntime(params: {
  sessions?: Memory[];
  insights?: Memory[];
  enabled?: boolean;
  settings?: Record<string, string | number | boolean>;
}): { runtime: IAgentRuntime; getMemories: ReturnType<typeof vi.fn> } {
  const settings: Record<string, string | number | boolean> = {
    ...(params.enabled === false ? {} : { PENDANT_RECALL_ENABLED: "true" }),
    ...params.settings,
  };
  const getMemories = vi.fn(
    async (query: { tableName: string; roomId?: UUID }) => {
      if (query.tableName === "pendant_sessions") return params.sessions ?? [];
      if (query.tableName === "messages") return params.insights ?? [];
      return [];
    },
  );
  const runtime = createMockRuntime({
    agentId: AGENT as UUID,
    getSetting: vi.fn((key: string) =>
      key in settings ? settings[key]! : null,
    ) as unknown as IAgentRuntime["getSetting"],
    getMemories: getMemories as unknown as IAgentRuntime["getMemories"],
    reportError: vi.fn(),
  });
  return { runtime, getMemories };
}

function userMessage(text: string): Memory {
  return {
    id: "msg-1" as UUID,
    entityId: OWNER as UUID,
    roomId: "chat-room" as UUID,
    content: { text },
    createdAt: NOW,
  } as unknown as Memory;
}

const STATE = {} as State;

beforeEach(() => {
  resolveOwner.mockReset();
  resolveOwner.mockResolvedValue(OWNER);
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pendantRecallProvider — enablement", () => {
  it("is off by default: no flag → empty render and no store reads", async () => {
    const { runtime, getMemories } = makeRuntime({
      enabled: false,
      sessions: [
        sessionMemory({
          sessionId: "s1",
          segments: [
            segment({ sessionId: "s1", ordinal: 0, text: "camping trip plans" }),
          ],
        }),
      ],
    });
    const result = await pendantRecallProvider.get(
      runtime,
      userMessage("what about the camping trip"),
      STATE,
    );
    expect(result.text).toBe("");
    expect(getMemories).not.toHaveBeenCalled();
  });

  it("resolvePendantRecallConfig is disabled unless PENDANT_RECALL_ENABLED", () => {
    const { runtime } = makeRuntime({ enabled: false });
    expect(resolvePendantRecallConfig(runtime).enabled).toBe(false);
    const { runtime: on } = makeRuntime({ enabled: true });
    expect(resolvePendantRecallConfig(on).enabled).toBe(true);
  });

  it("short queries short-circuit before any store read", async () => {
    const { runtime, getMemories } = makeRuntime({ sessions: [] });
    const result = await pendantRecallProvider.get(runtime, userMessage("hi"), STATE);
    expect(result.text).toBe("");
    expect(getMemories).not.toHaveBeenCalled();
  });
});

describe("pendantRecallProvider — relevance + provenance", () => {
  it("surfaces the on-topic segment with a canonical citation, drops off-topic", async () => {
    const { runtime } = makeRuntime({
      sessions: [
        sessionMemory({
          sessionId: "sess-A",
          segments: [
            segment({
              sessionId: "sess-A",
              ordinal: 0,
              text: "Royce said the camping trip is moved to Saturday because of snow",
            }),
            segment({
              sessionId: "sess-A",
              ordinal: 1,
              text: "the quarterly revenue numbers looked flat this month",
            }),
          ],
        }),
      ],
    });

    const result = await pendantRecallProvider.get(
      runtime,
      userMessage("what did Royce say about the camping trip"),
      STATE,
    );

    expect(result.text).toContain("camping trip");
    // Canonical provenance id present.
    expect(result.text).toContain(`[${pendantSegmentId("sess-A", 0)}]`);
    // Off-topic revenue line dropped by the relevance floor.
    expect(result.text).not.toContain("revenue");
    expect(result.data?.citations).toContain(pendantSegmentId("sess-A", 0));
  });

  it("surfaces insights with their memory id as provenance", async () => {
    const { runtime } = makeRuntime({
      sessions: [
        sessionMemory({
          sessionId: "sess-B",
          segments: [
            segment({
              sessionId: "sess-B",
              ordinal: 0,
              text: "I will send the deposit for the cabin tomorrow morning",
            }),
          ],
        }),
      ],
      insights: [
        insightMemory({
          id: "insight-xyz",
          sessionId: "sess-B",
          text: "Action item: send cabin deposit tomorrow (owner: you)",
          sourceSegmentIds: [pendantSegmentId("sess-B", 0)],
        }),
      ],
    });

    const result = await pendantRecallProvider.get(
      runtime,
      userMessage("what did I commit to about the cabin deposit"),
      STATE,
    );

    expect(result.text).toContain("insight");
    expect(result.text).toContain("[insight-xyz]");
    expect(result.data?.citations).toContain("insight-xyz");
  });

  it("returns empty when nothing is relevant", async () => {
    const { runtime } = makeRuntime({
      sessions: [
        sessionMemory({
          sessionId: "s",
          segments: [
            segment({
              sessionId: "s",
              ordinal: 0,
              text: "we talked about database indexing strategies",
            }),
          ],
        }),
      ],
    });
    const result = await pendantRecallProvider.get(
      runtime,
      userMessage("what did the doctor say about my knee surgery recovery"),
      STATE,
    );
    expect(result.text).toBe("");
  });
});

describe("pendantRecallProvider — tenancy isolation", () => {
  it("never surfaces a session whose stored owner differs", async () => {
    const { runtime } = makeRuntime({
      sessions: [
        // Mis-keyed row from another owner leaked into the returned list.
        sessionMemory({
          sessionId: "foreign",
          ownerId: OTHER_OWNER,
          segments: [
            segment({
              sessionId: "foreign",
              ordinal: 0,
              text: "secret camping trip for a different person entirely",
            }),
          ],
        }),
      ],
    });
    const result = await pendantRecallProvider.get(
      runtime,
      userMessage("tell me about the camping trip"),
      STATE,
    );
    expect(result.text).toBe("");
    expect(JSON.stringify(result.data ?? {})).not.toContain("foreign");
  });

  it("never surfaces a session bound to a different agent", async () => {
    const { runtime } = makeRuntime({
      sessions: [
        sessionMemory({
          sessionId: "cross-agent",
          agentId: OTHER_AGENT,
          segments: [
            segment({
              sessionId: "cross-agent",
              ordinal: 0,
              text: "camping trip details that belong to another agent",
            }),
          ],
        }),
      ],
    });
    const result = await pendantRecallProvider.get(
      runtime,
      userMessage("camping trip details please"),
      STATE,
    );
    expect(result.text).toBe("");
  });

  it("never surfaces an insight whose owner metadata differs", async () => {
    const { runtime } = makeRuntime({
      insights: [
        insightMemory({
          id: "foreign-insight",
          sessionId: "x",
          ownerId: OTHER_OWNER,
          text: "Action item from another user about the camping trip",
          sourceSegmentIds: ["pseg"],
        }),
      ],
    });
    const result = await pendantRecallProvider.get(
      runtime,
      userMessage("camping trip action items"),
      STATE,
    );
    expect(result.text).toBe("");
  });

  it("scopes reads to the owner+agent session room and insights room", async () => {
    const { runtime, getMemories } = makeRuntime({ sessions: [], insights: [] });
    await pendantRecallProvider.get(
      runtime,
      userMessage("anything about the camping trip"),
      STATE,
    );
    const calls = getMemories.mock.calls.map((c) => c[0]);
    const sessionCall = calls.find((c) => c.tableName === "pendant_sessions");
    const insightCall = calls.find((c) => c.tableName === "messages");
    expect(sessionCall).toBeDefined();
    expect(insightCall).toBeDefined();
    // Both reads are room-scoped (owner/agent derived room keys), never a
    // global scan.
    expect(sessionCall?.roomId).toBeDefined();
    expect(insightCall?.roomId).toBeDefined();
  });
});

describe("pendantRecallProvider — deletion respected", () => {
  it("a deleted session is absent from the live store, so nothing surfaces", async () => {
    // Simulate post-delete: the store returns no session docs (cascade removed
    // them). The provider reads live, so there is nothing to recall.
    const { runtime } = makeRuntime({ sessions: [], insights: [] });
    const result = await pendantRecallProvider.get(
      runtime,
      userMessage("what did we decide on the camping trip"),
      STATE,
    );
    expect(result.text).toBe("");
    expect(result.data?.citations ?? []).toHaveLength(0);
  });
});

describe("pendantRecallProvider — pause semantics", () => {
  it("paused sessions remain readable and are tagged, not invented", async () => {
    const { runtime } = makeRuntime({
      sessions: [
        sessionMemory({
          sessionId: "paused-sess",
          state: "paused",
          segments: [
            segment({
              sessionId: "paused-sess",
              ordinal: 0,
              text: "Royce mentioned the camping trip gear list before we paused",
            }),
          ],
        }),
      ],
    });
    const result = await pendantRecallProvider.get(
      runtime,
      userMessage("what did Royce say about the camping trip gear"),
      STATE,
    );
    expect(result.text).toContain("camping trip");
    expect(result.text).toContain("(paused session)");
  });

  it("does not surface non-resolved (pending/asr-error) segments as fact", async () => {
    const { runtime } = makeRuntime({
      sessions: [
        sessionMemory({
          sessionId: "s",
          segments: [
            segment({
              sessionId: "s",
              ordinal: 0,
              text: "camping trip is definitely happening on Saturday",
              status: "pending",
            }),
          ],
        }),
      ],
    });
    const result = await pendantRecallProvider.get(
      runtime,
      userMessage("is the camping trip happening"),
      STATE,
    );
    expect(result.text).toBe("");
  });
});

describe("pendantRecallProvider — token budget + lookback", () => {
  it("respects a tight char budget and reports exhaustion", async () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      segment({
        sessionId: "big",
        ordinal: i,
        text: `camping trip planning detail number ${i} with lots of extra words to consume budget`,
        offsetMs: -60_000 - i * 1000,
      }),
    );
    const { runtime } = makeRuntime({
      sessions: [sessionMemory({ sessionId: "big", segments: many })],
      settings: { PENDANT_RECALL_MAX_CHARS: 300, PENDANT_RECALL_MAX_SEGMENTS: 20 },
    });
    const result = await pendantRecallProvider.get(
      runtime,
      userMessage("camping trip planning details"),
      STATE,
    );
    expect(result.text.length).toBeLessThanOrEqual(300);
    expect(result.values?.pendantRecallBudgetExhausted).toBe(true);
  });

  it("bounds ranked output to the configured max even with a huge candidate pool", async () => {
    // 3 sessions worth of on-topic segments; the provider must still cap output.
    const sessions = Array.from({ length: 3 }, (_, s) =>
      sessionMemory({
        sessionId: `bulk-${s}`,
        segments: Array.from({ length: 60 }, (_, i) =>
          segment({
            sessionId: `bulk-${s}`,
            ordinal: i,
            text: `camping trip logistics note ${s}-${i}`,
            offsetMs: -60_000 - (s * 60 + i) * 1000,
          }),
        ),
      }),
    );
    const { runtime } = makeRuntime({
      sessions,
      settings: {
        PENDANT_RECALL_MAX_SEGMENTS: 5,
        PENDANT_RECALL_MAX_CHARS: 20_000,
      },
    });
    const result = await pendantRecallProvider.get(
      runtime,
      userMessage("camping trip logistics"),
      STATE,
    );
    expect(result.values?.pendantRecallSegmentCount).toBeLessThanOrEqual(5);
    expect((result.data?.citations as string[]).length).toBeLessThanOrEqual(5);
  });

  it("excludes content older than the lookback window", async () => {
    const eightDaysAgo = -8 * 24 * 60 * 60 * 1000;
    const { runtime } = makeRuntime({
      sessions: [
        sessionMemory({
          sessionId: "old",
          offsetMs: eightDaysAgo,
          segments: [
            segment({
              sessionId: "old",
              ordinal: 0,
              text: "camping trip from over a week ago should not surface",
              offsetMs: eightDaysAgo,
            }),
          ],
        }),
      ],
      settings: { PENDANT_RECALL_LOOKBACK_DAYS: 7 },
    });
    const result = await pendantRecallProvider.get(
      runtime,
      userMessage("what about the camping trip"),
      STATE,
    );
    expect(result.text).toBe("");
  });
});

describe("rankAndCap", () => {
  it("orders by relevance then recency and drops weak matches", () => {
    const items = [
      { text: "camping trip snow saturday", when: 1 },
      { text: "camping trip snow saturday", when: 5 },
      { text: "completely unrelated tax filing", when: 10 },
    ];
    const ranked = rankAndCap("camping trip snow", items, 5);
    expect(ranked.length).toBe(2);
    // Same relevance → newer first.
    expect(ranked[0]?.item.when).toBe(5);
    expect(ranked.every((r) => !r.item.text.includes("tax"))).toBe(true);
  });

  it("caps by count", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      text: "camping trip detail",
      when: i,
    }));
    expect(rankAndCap("camping trip", items, 3).length).toBe(3);
  });
});

describe("pendantRecallProvider — registration shape", () => {
  it("declares the expected native provider contract", () => {
    expect(pendantRecallProvider.name).toBe("pendant-recall");
    expect(pendantRecallProvider.dynamic).toBe(true);
    expect(typeof pendantRecallProvider.get).toBe("function");
    expect(pendantRecallProvider.roleGate).toEqual({ minRole: "USER" });
    expect(pendantRecallProvider.contexts).toContain("memory");
  });
});
