/**
 * Pendant insights — the cadence + dedupe scheduler (privacy/cost core).
 *
 * The scheduler consumes only `status: "resolved"` canonical segments delivered
 * by `PendantSessionSyncClientOptions.onSnapshot` in
 * `packages/ui/src/pendant/session-sync-client.ts`. It does not perform ASR, VAD,
 * speaker clustering, diarization, or transcript persistence. Server-side
 * integrations use `subscribePendantCommittedSegments` from
 * `packages/agent/src/api/pendant-session-routes.ts`. It periodically asks an {@link
 * import("./insights-client.js").InsightsClient} for a structured rollup — under
 * strict privacy + cost controls:
 *
 *  1. OPT-IN: no segment is retained and no request is made unless `enabled`.
 *     Flipping `setEnabled(false)` clears the buffer AND aborts any in-flight
 *     request — a hard stop, not a pause-with-retained-state.
 *  2. NEVER WHILE PAUSED: `setPaused(true)` (e.g. the pendant's push-to-mute /
 *     ambient gate closed) stops both ingestion AND generation. Nothing is
 *     uploaded while paused.
 *  3. ROLLING WINDOW: only the most recent `maxWindowSegments` are kept; older
 *     segments age out so the buffer (and each prompt) is bounded.
 *  4. CANONICAL DEDUPE: replayed segment IDs and same/older revisions are
 *     ignored; a newer revision patches the same retained segment in place.
 *  5. MIN THRESHOLD: generation only fires once at least `minSegments` NEW
 *     segments have accumulated since the last successful rollup.
 *  6. MAX CADENCE: at most one generation per `minIntervalMs`, regardless of how
 *     fast utterances arrive — a hard rate limit on model spend.
 *  7. CANCELLATION: `dispose()` / disconnect aborts the in-flight request; a
 *     result that lands after disposal is discarded.
 *  8. NO SILENT REDACTION + NO FAKE INSIGHTS: the scheduler never mutates segment
 *     text, and it surfaces empty rollups as-is (it does not synthesize content).
 */

import {
  MAX_INSIGHT_SEGMENTS_PER_REQUEST,
  MIN_INSIGHT_SEGMENTS,
  makePendantSegmentId,
  type PendantInsightSegmentInput,
  type PendantInsights,
  type PendantInsightsProvenance,
} from "@elizaos/shared";
import type { InsightsClient, InsightsClientResult } from "./insights-client";

export type InsightsFreshness = "none" | "fresh" | "stale";
export type InsightsSchedulerStatus =
  | "disabled"
  | "idle"
  | "paused"
  | "generating"
  | "ready"
  | "error"
  | "disposed";

/** Canonical UI state. A retained rollup is never implicitly current. */
export interface InsightsSchedulerState {
  status: InsightsSchedulerStatus;
  freshness: InsightsFreshness;
  insights: PendantInsights | null;
  provenance: PendantInsightsProvenance | null;
  lastUpdatedAt: number | null;
  error: string | null;
}

export interface InsightsSchedulerOptions {
  client: InsightsClient;
  /** Called with each newly generated rollup. */
  onInsights: (insights: PendantInsights) => void;
  /** Called on a genuine generation error (not a skip/cancel). Optional. */
  onError?: (message: string) => void;
  /**
   * Freshness/error/status integration seam for Phase 1 and session-sync.
   * Consumers should render from this state, not assume the last rollup is current.
   */
  onStateChange?: (state: InsightsSchedulerState) => void;
  /** Canonical server-authoritative session-sync id. */
  sessionId: string;
  /** New segments required since last rollup before generating. Default 6. */
  minSegments?: number;
  /** Minimum ms between generations (hard cost cap). Default 90_000 (90s). */
  minIntervalMs?: number;
  /** Rolling window cap on retained segments. Default 200. */
  maxWindowSegments?: number;
  /** Transcript char budget forwarded to the server. Optional. */
  maxTranscriptChars?: number;
  /** Clock injector (tests). Defaults to Date.now. */
  now?: () => number;
}

export type InsightsSchedulerSegmentInput = Omit<
  PendantInsightSegmentInput,
  "status"
> & {
  /** Direct session-sync status and field names, with no parallel transcript type. */
  status: "pending" | "resolved" | "asr-error";
  speakerCluster?: string | null;
  speakerAlias?: string | null;
  startedAt?: string;
};

/** A rolling ambient-insight scheduler. Construct one per listening session. */
export class PendantInsightsScheduler {
  private enabled = false;
  private paused = false;
  private disposed = false;

  private readonly sessionId: string;
  private readonly window: PendantInsightSegmentInput[] = [];
  private readonly windowSegmentIds = new Set<string>();
  private latestInsights: PendantInsights | null = null;
  private latestProvenance: PendantInsightsProvenance | null = null;
  private state: InsightsSchedulerState = {
    status: "disabled",
    freshness: "none",
    insights: null,
    provenance: null,
    lastUpdatedAt: null,
    error: null,
  };
  /** Segments added since the last SUCCESSFUL generation (the min-threshold gate). */
  private newSinceLastRun = 0;
  /** Time the most recent request STARTED, successful or not (hard rate cap). */
  private lastAttemptAt: number | null = null;
  private lastSummary = "";
  private cadenceTimer: ReturnType<typeof setTimeout> | null = null;

  private inFlight: AbortController | null = null;
  private generating = false;

  private readonly minSegments: number;
  private readonly minIntervalMs: number;
  private readonly maxWindowSegments: number;
  private readonly now: () => number;

  constructor(private readonly opts: InsightsSchedulerOptions) {
    this.sessionId = opts.sessionId;
    this.minSegments = Math.min(
      MAX_INSIGHT_SEGMENTS_PER_REQUEST,
      Math.max(MIN_INSIGHT_SEGMENTS, opts.minSegments ?? 6),
    );
    this.minIntervalMs = Math.max(0, opts.minIntervalMs ?? 90_000);
    this.maxWindowSegments = Math.min(
      MAX_INSIGHT_SEGMENTS_PER_REQUEST,
      Math.max(this.minSegments, opts.maxWindowSegments ?? 200),
    );
    this.now = opts.now ?? Date.now;
  }

  /** Opt-in toggle. Turning OFF clears all retained state + aborts in-flight. */
  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.reset();
      this.publishState("disabled");
    } else {
      this.publishState(this.paused ? "paused" : "idle");
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Pause/resume ingestion + generation (mute gate). Paused NEVER uploads. Unlike
   * disable, pause RETAINS the accumulated window so resuming continues the
   * rolling context — but any in-flight request is aborted on pause.
   */
  setPaused(paused: boolean): void {
    if (this.disposed || this.paused === paused) return;
    this.paused = paused;
    if (paused) {
      this.clearCadenceTimer();
      this.abortInFlight("paused");
      this.publishState(this.enabled ? "paused" : "disabled");
    } else {
      this.publishState(this.enabled ? "idle" : "disabled");
      if (this.enabled) void this.maybeGenerate();
    }
  }

  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Canonical session-sync seam. Preserves the shared deterministic segment id
   * and ordinal instead of inventing a second transcript/session identity.
   * Nullable speaker ids are retained honestly; canonical repeats dedupe by id,
   * not by text, because a person may legitimately repeat the same phrase.
   */
  addSegment(segment: InsightsSchedulerSegmentInput): boolean {
    if (!this.enabled || this.paused || this.disposed) return false;
    const text = segment.text.trim();
    if (
      !text ||
      segment.status !== "resolved" ||
      segment.sessionId !== this.sessionId ||
      segment.id !== makePendantSegmentId(this.sessionId, segment.ordinal)
    ) {
      return false;
    }
    const parsedAtMs =
      segment.atMs ??
      (segment.startedAt ? Date.parse(segment.startedAt) : undefined);
    const atMs =
      typeof parsedAtMs === "number" &&
      Number.isFinite(parsedAtMs) &&
      parsedAtMs >= 0
        ? Math.floor(parsedAtMs)
        : undefined;
    const normalized: PendantInsightSegmentInput = {
      id: segment.id,
      sessionId: segment.sessionId,
      ordinal: segment.ordinal,
      status: "resolved",
      revision: segment.revision ?? 0,
      text,
      ...(segment.speakerId !== undefined ||
      segment.speakerCluster !== undefined
        ? { speakerId: segment.speakerId ?? segment.speakerCluster ?? null }
        : {}),
      ...(segment.speakerLabel || segment.speakerAlias
        ? {
            speakerLabel:
              segment.speakerLabel ?? segment.speakerAlias ?? undefined,
          }
        : {}),
      ...(atMs !== undefined ? { atMs } : {}),
    };
    const existingIndex = this.window.findIndex(
      (candidate) => candidate.id === segment.id,
    );
    if (existingIndex >= 0) {
      const existing = this.window[existingIndex];
      if ((normalized.revision ?? 0) <= (existing.revision ?? 0)) return false;
      this.window[existingIndex] = normalized;
      this.newSinceLastRun++;
      this.publishState("idle");
      void this.maybeGenerate();
      return true;
    }
    return this.ingestSegment(normalized);
  }

  /** Snapshot the current retained window (defensive copy) for inspection/UI. */
  getWindow(): PendantInsightSegmentInput[] {
    return this.window.map((segment) => ({ ...segment }));
  }

  /** Freshness/error snapshot for UI and cross-device session integration. */
  getState(): InsightsSchedulerState {
    return { ...this.state };
  }

  /** True while a generation request is in flight. */
  isGenerating(): boolean {
    return this.generating;
  }

  /**
   * Force a generation attempt now, bypassing the cadence timer but NOT the
   * privacy gates or the min-segment threshold. Useful on a manual "summarize
   * now" affordance. Resolves when the attempt settles.
   */
  async flush(): Promise<void> {
    await this.maybeGenerate(true);
  }

  /** Session-delete hook: abort immediately, clear transcript/insights, and disable. */
  clearForSessionDelete(): void {
    if (this.disposed) return;
    this.enabled = false;
    this.reset();
    this.publishState("disabled");
  }

  /** Tear down: abort in-flight, clear state, block further work. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.enabled = false;
    this.reset();
    this.publishState("disposed");
  }

  // ── internals ───────────────────────────────────────────────────────────

  private publishState(
    status: InsightsSchedulerStatus,
    error: string | null = null,
  ): void {
    this.state = {
      status,
      freshness: this.latestInsights
        ? this.newSinceLastRun > 0 || status === "error"
          ? "stale"
          : "fresh"
        : "none",
      insights: this.latestInsights,
      provenance: this.latestProvenance,
      lastUpdatedAt: this.latestInsights?.generatedAt ?? null,
      error,
    };
    this.opts.onStateChange?.({ ...this.state });
  }

  private ingestSegment(segment: PendantInsightSegmentInput): boolean {
    if (this.windowSegmentIds.has(segment.id)) return false;
    this.window.push({ ...segment });
    this.windowSegmentIds.add(segment.id);
    this.newSinceLastRun++;
    this.trimWindow();
    const priorError = this.state.status === "error" ? this.state.error : null;
    this.publishState(priorError ? "error" : "idle", priorError);
    void this.maybeGenerate();
    return true;
  }

  private reset(): void {
    this.abortInFlight("reset");
    this.window.length = 0;
    this.windowSegmentIds.clear();
    this.newSinceLastRun = 0;
    this.lastAttemptAt = null;
    this.lastSummary = "";
    this.latestInsights = null;
    this.latestProvenance = null;
    this.clearCadenceTimer();
  }

  private abortInFlight(reason: string): void {
    if (this.inFlight) {
      this.inFlight.abort(reason);
      this.inFlight = null;
    }
    this.generating = false;
  }

  private trimWindow(): void {
    while (this.window.length > this.maxWindowSegments) {
      const removed = this.window.shift();
      if (removed) this.windowSegmentIds.delete(removed.id);
    }
  }

  private clearCadenceTimer(): void {
    if (this.cadenceTimer !== null) {
      clearTimeout(this.cadenceTimer);
      this.cadenceTimer = null;
    }
  }

  private scheduleAfterCadence(delayMs: number): void {
    if (
      this.cadenceTimer !== null ||
      this.disposed ||
      !this.enabled ||
      this.paused
    ) {
      return;
    }
    this.cadenceTimer = setTimeout(
      () => {
        this.cadenceTimer = null;
        void this.maybeGenerate();
      },
      Math.max(0, delayMs),
    );
  }

  /** Gate + fire a generation. `force` skips only the cadence timer. */
  private async maybeGenerate(force = false): Promise<void> {
    if (this.disposed || !this.enabled || this.paused) return;
    if (this.generating) return; // one at a time
    if (this.newSinceLastRun < this.minSegments) return;
    const nowMs = this.now();
    if (
      !force &&
      this.lastAttemptAt !== null &&
      nowMs - this.lastAttemptAt < this.minIntervalMs
    ) {
      this.scheduleAfterCadence(
        this.minIntervalMs - (nowMs - this.lastAttemptAt),
      );
      return;
    }
    if (this.window.length === 0) return;

    this.clearCadenceTimer();
    const controller = new AbortController();
    this.inFlight = controller;
    this.generating = true;
    this.lastAttemptAt = nowMs;
    this.publishState("generating");

    const segments = this.getWindow();
    const newCountAtStart = this.newSinceLastRun;
    const priorSummary = this.lastSummary || undefined;

    let result: InsightsClientResult;
    try {
      result = await this.opts.client.requestInsights({
        sessionId: this.sessionId,
        segments,
        ...(priorSummary ? { priorSummary } : {}),
        ...(this.opts.maxTranscriptChars
          ? { maxTranscriptChars: this.opts.maxTranscriptChars }
          : {}),
        signal: controller.signal,
      });
    } catch (err) {
      // Client threw (should be rare — it normalizes errors). Treat as error
      // unless we were aborted.
      this.finishGeneration(controller);
      if (!controller.signal.aborted && !this.disposed) {
        const message = err instanceof Error ? err.message : String(err);
        this.publishState("error", message);
        this.opts.onError?.(message);
        if (this.newSinceLastRun >= this.minSegments) {
          this.scheduleAfterCadence(this.minIntervalMs);
        }
      }
      return;
    }

    // A result that landed after disposal / disable / pause / a new abort is
    // discarded — cancellation on disconnect.
    if (
      this.disposed ||
      controller.signal.aborted ||
      this.inFlight !== controller
    ) {
      this.finishGeneration(controller);
      return;
    }
    this.finishGeneration(controller);

    if (result.ok) {
      // Preserve utterances that arrived while this request was in flight.
      this.newSinceLastRun = Math.max(
        0,
        this.newSinceLastRun - newCountAtStart,
      );
      if (result.insights.summary) this.lastSummary = result.insights.summary;
      this.latestInsights = result.insights;
      this.latestProvenance = result.provenance;
      this.publishState("ready");
      this.opts.onInsights(result.insights);
    } else if (!result.skipped) {
      this.publishState("error", result.error);
      this.opts.onError?.(result.error);
    } else if (result.reason === "runtime-unavailable") {
      this.publishState("error", result.reason);
      this.opts.onError?.(result.reason);
    } else {
      this.publishState("idle");
    }

    // If enough new speech arrived during the request, guarantee a later pass
    // even when no additional utterance arrives to trigger maybeGenerate.
    if (this.newSinceLastRun >= this.minSegments) {
      const elapsed = this.now() - (this.lastAttemptAt ?? this.now());
      this.scheduleAfterCadence(this.minIntervalMs - elapsed);
    }
  }

  private finishGeneration(controller: AbortController): void {
    if (this.inFlight === controller) {
      this.inFlight = null;
      this.generating = false;
    }
  }
}
