/**
 * Browser client for the server-authoritative pendant session primitive.
 *
 * The adapter keeps local capture code simple: mutations are sent through the
 * authenticated API, failed writes remain in an explicit FIFO queue, and polling
 * converges on the server revision rather than trusting local transcript state.
 */

import {
  type AcquirePendantLeaseRequest,
  type CreatePendantSessionRequest,
  type PatchPendantSegmentRequest,
  PENDANT_SESSION_SYNC_API_PREFIX,
  type PendantDeleteResponse,
  type PendantExportResponse,
  type PendantLeaseResponse,
  type PendantMutationResponse,
  type PendantSessionErrorResponse,
  type PendantSessionSnapshot,
  type PollPendantSessionResponse,
  pendantSegmentId,
  type UpsertPendantInsightRefsRequest,
  type UpsertPendantSegmentRequest,
} from "@elizaos/shared/contracts";
import { fetchWithCsrf } from "../api/csrf-client";
import { resolveApiUrl } from "../utils/asset-url";

type Fetcher = typeof fetchWithCsrf;

export interface PendantSessionSyncClientOptions {
  fetcher?: Fetcher;
  pollMs?: number;
  onSnapshot?: (snapshot: PendantSessionSnapshot) => void;
  onQueueChange?: (length: number) => void;
  onError?: (error: Error) => void;
}

export interface QueuedPendantMutation {
  id: string;
  status: "pending" | "conflict";
  error?: PendantSessionSyncError;
  run: () => Promise<PendantSessionSnapshot>;
}

export class PendantSessionSyncError extends Error {
  constructor(
    message: string,
    readonly response?: PendantSessionErrorResponse,
  ) {
    super(message);
  }
}

export class PendantSessionSyncClient {
  private readonly fetcher: Fetcher;
  private readonly pollMs: number;
  private readonly onSnapshot?: (snapshot: PendantSessionSnapshot) => void;
  private readonly onQueueChange?: (length: number) => void;
  private readonly onError?: (error: Error) => void;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollingGeneration = 0;
  private invalidationGeneration = 0;
  private draining = false;
  private snapshotNotificationHoldDepth = 0;
  private deferredSnapshotNotification: PendantSessionSnapshot | null = null;
  private snapshot: PendantSessionSnapshot | null = null;
  readonly unsyncedQueue: QueuedPendantMutation[] = [];

  constructor(options: PendantSessionSyncClientOptions = {}) {
    this.fetcher = options.fetcher ?? fetchWithCsrf;
    this.pollMs = options.pollMs ?? 500;
    this.onSnapshot = options.onSnapshot;
    this.onQueueChange = options.onQueueChange;
    this.onError = options.onError;
  }

  get currentSnapshot(): PendantSessionSnapshot | null {
    return this.snapshot;
  }

  startPolling(sessionId: string): void {
    this.stopPolling();
    const generation = this.pollingGeneration;
    const tick = async (): Promise<void> => {
      try {
        await this.flushQueue();
      } catch (err) {
        if (generation === this.pollingGeneration) {
          this.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
      try {
        await this.poll(sessionId);
      } catch (err) {
        if (generation === this.pollingGeneration) {
          this.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (generation === this.pollingGeneration) {
          this.pollTimer = setTimeout(tick, this.pollMs);
        }
      }
    };
    this.pollTimer = setTimeout(tick, 0);
  }

  stopPolling(): void {
    this.pollingGeneration += 1;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  async createSession(
    input: CreatePendantSessionRequest = {},
  ): Promise<PendantSessionSnapshot> {
    const generation = this.invalidationGeneration;
    return this.requestSnapshot(generation, PENDANT_SESSION_SYNC_API_PREFIX, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async acquireLease(
    sessionId: string,
    request: AcquirePendantLeaseRequest,
  ): Promise<PendantLeaseResponse> {
    return this.request<PendantLeaseResponse>(`${path(sessionId)}/lease`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async appendSegment(
    sessionId: string,
    request: UpsertPendantSegmentRequest,
  ): Promise<PendantSessionSnapshot> {
    return this.enqueueOrRun(
      `append:${sessionId}:${request.segment.ordinal}`,
      () =>
        this.requestMutation(`${path(sessionId)}/segments`, {
          method: "POST",
          body: JSON.stringify(request),
        }),
    );
  }

  async patchSegment(
    sessionId: string,
    segmentId: string,
    request: PatchPendantSegmentRequest,
  ): Promise<PendantSessionSnapshot> {
    return this.enqueueOrRun(
      `patch:${sessionId}:${segmentId}:${request.revision}`,
      () =>
        this.requestMutation(
          `${path(sessionId)}/segments/${encodeURIComponent(segmentId)}`,
          {
            method: "PATCH",
            body: JSON.stringify(request),
          },
        ),
    );
  }

  async upsertSegmentLifecycle(
    sessionId: string,
    request: UpsertPendantSegmentRequest,
  ): Promise<PendantSessionSnapshot> {
    const key = `segment-lifecycle:${sessionId}:${request.segment.ordinal}`;
    const run = () => this.runSegmentLifecycleUpsert(sessionId, request);
    return this.enqueueOrRun(key, run, { coalesce: true });
  }

  async pause(
    sessionId: string,
    revision?: number,
  ): Promise<PendantSessionSnapshot> {
    return this.requestMutation(`${path(sessionId)}/pause`, {
      method: "POST",
      body: JSON.stringify({ revision }),
    });
  }

  async resume(
    sessionId: string,
    revision?: number,
  ): Promise<PendantSessionSnapshot> {
    return this.requestMutation(`${path(sessionId)}/resume`, {
      method: "POST",
      body: JSON.stringify({ revision }),
    });
  }

  async end(
    sessionId: string,
    revision?: number,
  ): Promise<PendantSessionSnapshot> {
    return this.requestMutation(`${path(sessionId)}/end`, {
      method: "POST",
      body: JSON.stringify({ revision }),
    });
  }

  async upsertInsightRefs(
    sessionId: string,
    request: UpsertPendantInsightRefsRequest,
  ): Promise<PendantSessionSnapshot> {
    return this.requestMutation(`${path(sessionId)}/insight-refs`, {
      method: "PUT",
      body: JSON.stringify(request),
    });
  }

  async poll(sessionId: string): Promise<PendantSessionSnapshot | null> {
    const generation = this.invalidationGeneration;
    const afterRevision =
      this.snapshot?.session.id === sessionId
        ? this.snapshot.session.revision
        : undefined;
    const suffix =
      afterRevision === undefined ? "" : `?afterRevision=${afterRevision}`;
    const response = await this.request<PollPendantSessionResponse>(
      `${path(sessionId)}${suffix}`,
      { method: "GET" },
    );
    if (!response.changed) return null;
    this.acceptSnapshot(response.snapshot, generation);
    return response.snapshot;
  }

  async exportSession(sessionId: string): Promise<PendantSessionSnapshot> {
    const response = await this.request<PendantExportResponse>(
      `${path(sessionId)}/export`,
      { method: "GET" },
    );
    return response.export;
  }

  async deleteSession(sessionId: string): Promise<PendantDeleteResponse> {
    const generation = this.invalidationGeneration;
    const response = await this.request<PendantDeleteResponse>(
      path(sessionId),
      {
        method: "DELETE",
      },
    );
    if (generation === this.invalidationGeneration) {
      if (this.snapshot?.session.id === sessionId) this.snapshot = null;
    }
    return response;
  }

  clearLocalSession(sessionId?: string): void {
    this.invalidationGeneration += 1;
    this.stopPolling();
    if (!sessionId || this.snapshot?.session.id === sessionId) {
      this.snapshot = null;
    }
    const previousLength = this.unsyncedQueue.length;
    this.unsyncedQueue.length = 0;
    this.emitQueueChange(previousLength);
  }

  clearUnsyncedCache(): void {
    const previousLength = this.unsyncedQueue.length;
    this.unsyncedQueue.length = 0;
    this.emitQueueChange(previousLength);
  }

  async flushQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.unsyncedQueue.length > 0) {
        const next = this.unsyncedQueue[0];
        if (!next) return;
        if (next.status === "conflict" && next.error) throw next.error;
        try {
          this.snapshotNotificationHoldDepth += 1;
          await next.run();
          if (this.unsyncedQueue[0] === next) {
            const previousLength = this.unsyncedQueue.length;
            this.unsyncedQueue.shift();
            this.emitQueueChange(previousLength);
          }
        } catch (err) {
          if (
            err instanceof PendantSessionSyncError &&
            err.response?.error.code !== "store_unavailable"
          ) {
            next.status = "conflict";
            next.error = err;
          }
          throw err;
        } finally {
          this.snapshotNotificationHoldDepth = Math.max(
            0,
            this.snapshotNotificationHoldDepth - 1,
          );
          this.flushDeferredSnapshotNotification();
        }
      }
    } finally {
      this.draining = false;
    }
  }

  discardUnsyncedMutation(id: string): boolean {
    const index = this.unsyncedQueue.findIndex(
      (mutation) => mutation.id === id,
    );
    if (index < 0) return false;
    const previousLength = this.unsyncedQueue.length;
    this.unsyncedQueue.splice(index, 1);
    this.emitQueueChange(previousLength);
    return true;
  }

  private async enqueueOrRun(
    id: string,
    run: () => Promise<PendantSessionSnapshot>,
    options: { coalesce?: boolean } = {},
  ): Promise<PendantSessionSnapshot> {
    const generation = this.invalidationGeneration;
    if (options.coalesce && this.replaceQueuedMutation(id, run)) {
      if (this.snapshot) return this.snapshot;
    }
    try {
      const snapshot = await run();
      if (generation !== this.invalidationGeneration) {
        return snapshot;
      }
      return snapshot;
    } catch (err) {
      if (generation !== this.invalidationGeneration) throw err;
      if (!isOfflineError(err)) throw err;
      if (options.coalesce) {
        this.replaceQueuedMutation(id, run) ||
          this.unsyncedQueue.push({ id, status: "pending", run });
      } else {
        this.unsyncedQueue.push({ id, status: "pending", run });
      }
      this.emitQueueChange();
      if (this.snapshot) return this.snapshot;
      throw err;
    }
  }

  private replaceQueuedMutation(
    id: string,
    run: () => Promise<PendantSessionSnapshot>,
  ): boolean {
    const index = this.unsyncedQueue.findIndex(
      (mutation) => mutation.id === id,
    );
    if (index < 0) return false;
    this.unsyncedQueue[index] = { id, status: "pending", run };
    return true;
  }

  private emitQueueChange(previousLength?: number): void {
    if (
      previousLength !== undefined &&
      previousLength === this.unsyncedQueue.length
    ) {
      return;
    }
    this.onQueueChange?.(this.unsyncedQueue.length);
  }

  private async runSegmentLifecycleUpsert(
    sessionId: string,
    request: UpsertPendantSegmentRequest,
  ): Promise<PendantSessionSnapshot> {
    const segmentId = pendantSegmentId(sessionId, request.segment.ordinal);
    const existing =
      this.snapshot?.session.id === sessionId
        ? this.snapshot.segments.find((segment) => segment.id === segmentId)
        : undefined;
    if (!existing) {
      return this.requestMutation(`${path(sessionId)}/segments`, {
        method: "POST",
        body: JSON.stringify(request),
      });
    }
    if (
      existing.status === "resolved" &&
      request.segment.status !== "resolved" &&
      this.snapshot
    ) {
      return this.snapshot;
    }
    return this.requestMutation(
      `${path(sessionId)}/segments/${encodeURIComponent(segmentId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
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
        } satisfies PatchPendantSegmentRequest),
      },
    );
  }

  private async requestSnapshot(
    generation: number,
    url: string,
    init: RequestInit,
  ): Promise<PendantSessionSnapshot> {
    const response = await this.request<PendantMutationResponse>(url, init);
    this.acceptSnapshot(response.snapshot, generation);
    return response.snapshot;
  }

  private async requestMutation(
    url: string,
    init: RequestInit,
  ): Promise<PendantSessionSnapshot> {
    const generation = this.invalidationGeneration;
    const response = await this.request<PendantMutationResponse>(url, init);
    this.acceptSnapshot(response.snapshot, generation);
    return response.snapshot;
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const response = await this.fetcher(resolveApiUrl(url), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init.headers,
      },
    });
    const body = (await response.json()) as T | PendantSessionErrorResponse;
    if (!response.ok) {
      const errorBody = body as PendantSessionErrorResponse;
      throw new PendantSessionSyncError(
        errorBody.error?.message ?? "Pendant session request failed",
        errorBody,
      );
    }
    return body as T;
  }

  private acceptSnapshot(
    snapshot: PendantSessionSnapshot,
    generation = this.invalidationGeneration,
  ): void {
    if (generation !== this.invalidationGeneration) return;
    if (
      this.snapshot &&
      this.snapshot.session.id === snapshot.session.id &&
      snapshot.session.revision <= this.snapshot.session.revision
    ) {
      return;
    }
    this.snapshot = snapshot;
    if (this.snapshotNotificationHoldDepth > 0) {
      this.deferredSnapshotNotification = snapshot;
      return;
    }
    this.onSnapshot?.(snapshot);
  }

  private flushDeferredSnapshotNotification(): void {
    if (
      this.snapshotNotificationHoldDepth > 0 ||
      !this.deferredSnapshotNotification
    ) {
      return;
    }
    const snapshot = this.deferredSnapshotNotification;
    this.deferredSnapshotNotification = null;
    this.onSnapshot?.(snapshot);
  }
}

export function createPendantSessionSyncClient(
  options?: PendantSessionSyncClientOptions,
): PendantSessionSyncClient {
  return new PendantSessionSyncClient(options);
}

function path(sessionId: string): string {
  return `${PENDANT_SESSION_SYNC_API_PREFIX}/${encodeURIComponent(sessionId)}`;
}

function isOfflineError(err: unknown): boolean {
  if (!(err instanceof TypeError || err instanceof Error)) return false;
  return /Failed to fetch|NetworkError|offline|Load failed/i.test(err.message);
}
