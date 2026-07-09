import type { PendantInsights } from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  InsightsClient,
  InsightsClientResult,
  RequestInsightsInput,
} from "./insights-client";
import {
  type InsightsSchedulerSegmentInput,
  PendantInsightsScheduler,
} from "./insights-scheduler";

const SESSION_ID = "stable";

function segment(
  ordinal: number,
  text: string,
  overrides: Partial<InsightsSchedulerSegmentInput> = {},
): InsightsSchedulerSegmentInput {
  return {
    id: `${SESSION_ID}:segment:${ordinal}`,
    sessionId: SESSION_ID,
    ordinal,
    status: "resolved",
    revision: 0,
    text,
    ...overrides,
  };
}

function insights(summary = "summary"): PendantInsights {
  return {
    schemaVersion: 1,
    summary,
    actionItems: [],
    topics: [],
    peopleMentioned: [],
    notableQuotes: [],
    generatedAt: 1,
    transcriptRange: {
      startOrdinal: 0,
      endOrdinal: 2,
      segmentCount: 3,
      startedAtMs: 0,
      endedAtMs: 0,
    },
  };
}

function success(summary = "summary"): InsightsClientResult {
  return {
    ok: true,
    insights: insights(summary),
    provenance: {
      sessionId: SESSION_ID,
      agentId: "agent-1",
      memoryId: "memory-1",
      sourceSegments: [
        { id: `${SESSION_ID}:segment:0`, ordinal: 0, revision: 0 },
      ],
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("PendantInsightsScheduler canonical session-sync controls", () => {
  it("retains and uploads nothing before opt-in or while paused", async () => {
    const requestInsights = vi.fn(
      async (): Promise<InsightsClientResult> => success(),
    );
    const scheduler = new PendantInsightsScheduler({
      client: { requestInsights },
      onInsights: vi.fn(),
      sessionId: SESSION_ID,
      minSegments: 3,
      minIntervalMs: 0,
    });

    expect(scheduler.addSegment(segment(0, "before opt in"))).toBe(false);
    expect(scheduler.getWindow()).toEqual([]);
    scheduler.setEnabled(true);
    scheduler.setPaused(true);
    expect(scheduler.addSegment(segment(0, "while paused"))).toBe(false);
    expect(scheduler.getWindow()).toEqual([]);
    await scheduler.flush();
    expect(requestInsights).not.toHaveBeenCalled();
  });

  it("accepts only resolved canonical segments, dedupes replay by id, and bounds the window", () => {
    const scheduler = new PendantInsightsScheduler({
      client: {
        requestInsights: vi.fn(async () => ({
          ok: false as const,
          skipped: true as const,
          reason: "too-few-segments",
        })),
      },
      onInsights: vi.fn(),
      sessionId: SESSION_ID,
      minSegments: 3,
      maxWindowSegments: 3,
    });
    scheduler.setEnabled(true);
    expect(
      scheduler.addSegment(segment(0, "pending", { status: "pending" })),
    ).toBe(false);
    expect(
      scheduler.addSegment(segment(0, "failed", { status: "asr-error" })),
    ).toBe(false);
    const first = segment(0, "repeat this");
    expect(scheduler.addSegment(first)).toBe(true);
    expect(scheduler.addSegment(first)).toBe(false);
    expect(scheduler.addSegment(segment(1, "repeat this"))).toBe(true);
    scheduler.addSegment(segment(2, "three"));
    scheduler.addSegment(segment(3, "four"));
    expect(scheduler.getWindow().map((item) => item.ordinal)).toEqual([
      1, 2, 3,
    ]);
  });

  it("consumes session-sync revisions and existing nullable speaker attribution", () => {
    const scheduler = new PendantInsightsScheduler({
      client: { requestInsights: vi.fn() },
      onInsights: vi.fn(),
      minSegments: 100,
      sessionId: "shared",
    });
    scheduler.setEnabled(true);
    const first: InsightsSchedulerSegmentInput = {
      id: "shared:segment:4",
      sessionId: "shared",
      ordinal: 4,
      status: "resolved",
      revision: 0,
      text: "repeat this",
      speakerCluster: null,
      speakerAlias: null,
      startedAt: "2026-07-09T20:00:00.000Z",
    };
    const revisedFirst = {
      ...first,
      revision: 1,
      text: "repeat this, corrected",
    };
    const second: InsightsSchedulerSegmentInput = {
      id: "shared:segment:5",
      sessionId: "shared",
      ordinal: 5,
      status: "resolved",
      revision: 0,
      text: "repeat this",
      speakerCluster: "spk_1",
      speakerAlias: "Speaker 1",
      startedAt: "2026-07-09T20:00:01.000Z",
    };
    expect(scheduler.addSegment(first)).toBe(true);
    expect(scheduler.addSegment(first)).toBe(false);
    expect(scheduler.addSegment(revisedFirst)).toBe(true);
    expect(scheduler.addSegment(second)).toBe(true);
    expect(scheduler.getWindow()).toEqual([
      {
        id: revisedFirst.id,
        sessionId: "shared",
        ordinal: 4,
        status: "resolved",
        revision: 1,
        text: revisedFirst.text,
        speakerId: null,
        atMs: Date.parse(first.startedAt ?? ""),
      },
      {
        id: second.id,
        sessionId: "shared",
        ordinal: 5,
        status: "resolved",
        revision: 0,
        text: second.text,
        speakerId: "spk_1",
        speakerLabel: "Speaker 1",
        atMs: Date.parse(second.startedAt ?? ""),
      },
    ]);
  });

  it("omits malformed session-sync timestamps instead of poisoning a request", () => {
    const scheduler = new PendantInsightsScheduler({
      client: { requestInsights: vi.fn() },
      onInsights: vi.fn(),
      minSegments: 100,
      sessionId: "timestamps",
    });
    scheduler.setEnabled(true);
    expect(
      scheduler.addSegment({
        id: "timestamps:segment:0",
        sessionId: "timestamps",
        ordinal: 0,
        status: "resolved",
        revision: 0,
        text: "valid text",
        startedAt: "not-a-date",
      }),
    ).toBe(true);
    expect(scheduler.getWindow()[0]).not.toHaveProperty("atMs");
  });

  it("marks a retained rollup stale as soon as a canonical segment arrives", async () => {
    const states: string[] = [];
    const scheduler = new PendantInsightsScheduler({
      client: { requestInsights: vi.fn(async () => success()) },
      onInsights: vi.fn(),
      onStateChange: (state) =>
        states.push(`${state.status}:${state.freshness}`),
      sessionId: SESSION_ID,
      minSegments: 3,
      minIntervalMs: 0,
    });
    scheduler.setEnabled(true);
    for (let ordinal = 0; ordinal < 3; ordinal++) {
      scheduler.addSegment(segment(ordinal, `segment ${ordinal}`));
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.getState()).toMatchObject({
      status: "ready",
      freshness: "fresh",
      error: null,
    });
    scheduler.addSegment(segment(3, "new context"));
    expect(scheduler.getState()).toMatchObject({
      status: "idle",
      freshness: "stale",
      insights: insights(),
    });
    expect(states).toContain("ready:fresh");
    expect(states).toContain("idle:stale");
  });

  it("aborts an in-flight upload when paused", async () => {
    const pending = deferred<InsightsClientResult>();
    let input: RequestInsightsInput | undefined;
    const client: InsightsClient = {
      requestInsights: vi.fn((nextInput) => {
        input = nextInput;
        return pending.promise;
      }),
    };
    const onInsights = vi.fn();
    const scheduler = new PendantInsightsScheduler({
      client,
      onInsights,
      sessionId: SESSION_ID,
      minSegments: 3,
      minIntervalMs: 0,
    });
    scheduler.setEnabled(true);
    for (let ordinal = 0; ordinal < 3; ordinal++) {
      scheduler.addSegment(segment(ordinal, `segment ${ordinal}`));
    }
    expect(input?.sessionId).toBe(SESSION_ID);
    expect(input?.signal?.aborted).toBe(false);
    scheduler.setPaused(true);
    expect(input?.signal?.aborted).toBe(true);
    pending.resolve(success());
    await pending.promise;
    await Promise.resolve();
    expect(onInsights).not.toHaveBeenCalled();
  });

  it("aborts and forgets retained speech and insights on session delete", async () => {
    const pending = deferred<InsightsClientResult>();
    let signal: AbortSignal | undefined;
    const scheduler = new PendantInsightsScheduler({
      client: {
        requestInsights: vi.fn((input) => {
          signal = input.signal;
          return pending.promise;
        }),
      },
      onInsights: vi.fn(),
      sessionId: SESSION_ID,
      minSegments: 3,
      minIntervalMs: 0,
    });
    scheduler.setEnabled(true);
    for (let ordinal = 0; ordinal < 3; ordinal++) {
      scheduler.addSegment(segment(ordinal, `segment ${ordinal}`));
    }
    scheduler.clearForSessionDelete();
    expect(signal?.aborted).toBe(true);
    expect(scheduler.isEnabled()).toBe(false);
    expect(scheduler.getWindow()).toEqual([]);
    expect(scheduler.getState()).toEqual({
      status: "disabled",
      freshness: "none",
      insights: null,
      provenance: null,
      lastUpdatedAt: null,
      error: null,
    });
    pending.resolve(success());
    await pending.promise;
    await Promise.resolve();
    expect(scheduler.getState().insights).toBeNull();
  });

  it("rate-limits failed attempts and exposes explicit error state", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const states: Array<{
      status: string;
      freshness: string;
      error: string | null;
    }> = [];
    const requestInsights = vi.fn(
      async (): Promise<InsightsClientResult> => ({
        ok: false,
        skipped: false,
        error: "bad model output",
      }),
    );
    const scheduler = new PendantInsightsScheduler({
      client: { requestInsights },
      onInsights: vi.fn(),
      onStateChange: (state) =>
        states.push({
          status: state.status,
          freshness: state.freshness,
          error: state.error,
        }),
      sessionId: SESSION_ID,
      minSegments: 3,
      minIntervalMs: 1_000,
      now: () => now,
    });
    scheduler.setEnabled(true);
    for (let ordinal = 0; ordinal < 3; ordinal++) {
      scheduler.addSegment(segment(ordinal, `segment ${ordinal}`));
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(requestInsights).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toEqual({
      status: "error",
      freshness: "none",
      error: "bad model output",
    });
    scheduler.addSegment(segment(3, "four"));
    expect(requestInsights).toHaveBeenCalledTimes(1);
    now += 999;
    await vi.advanceTimersByTimeAsync(999);
    expect(requestInsights).toHaveBeenCalledTimes(1);
    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(requestInsights).toHaveBeenCalledTimes(2);
  });

  it("preserves canonical segments arriving in flight and schedules a follow-up", async () => {
    vi.useFakeTimers();
    let now = 1_000;
    const first = deferred<InsightsClientResult>();
    const requestInsights = vi
      .fn<InsightsClient["requestInsights"]>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(success("second"));
    const scheduler = new PendantInsightsScheduler({
      client: { requestInsights },
      onInsights: vi.fn(),
      sessionId: SESSION_ID,
      minSegments: 3,
      minIntervalMs: 100,
      now: () => now,
    });
    scheduler.setEnabled(true);
    for (let ordinal = 0; ordinal < 6; ordinal++) {
      scheduler.addSegment(segment(ordinal, `segment ${ordinal}`));
    }
    first.resolve(success("first"));
    await first.promise;
    await Promise.resolve();
    expect(requestInsights).toHaveBeenCalledTimes(1);
    now += 100;
    await vi.advanceTimersByTimeAsync(100);
    expect(requestInsights).toHaveBeenCalledTimes(2);
  });
});
