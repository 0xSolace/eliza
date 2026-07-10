/**
 * File-backed ambient pendant store for the STANDALONE dev/test voice backend.
 *
 * WHY THIS EXISTS (honest boundary):
 *   In production, ambient segments live in the canonical `pendant_sessions_v1`
 *   store behind the AGENT's `/api/pendant/sessions/*` routes (sol-real on
 *   :7799), reached over HTTP via `createHttpPendantSegmentStore`. The
 *   standalone backend is a *dev/test* deployment that has no cloud auth/DB and
 *   is not the agent host, so it cannot mint into that store the way the CF
 *   worker does (the agent derives ownerId from its own authenticated caller).
 *
 *   For the standalone service we therefore persist segments to a local
 *   file-backed store that enforces the EXACT SAME runtime contract the real
 *   pendant route enforces (contiguous ordinals, lease-digest match,
 *   paused-refuses-append, ended-immutable, create/resume/exists). This is the
 *   same "platform seam substituted, voice logic real" boundary the harness
 *   documents for its in-process store — the AmbientSession's ordering / lease /
 *   pause / resume / revoke logic under test runs UNMODIFIED against this store.
 *
 *   The ONLY difference from the harness in-process store is durability: this
 *   persists to disk so segments survive a service restart (DoD "restart
 *   recovers ambient segments"). The transcript UI's canonical read path is
 *   documented in the report as served by sol-real (:7799), not this service;
 *   this store is the standalone service's own inspectable segment record.
 *
 * The store NEVER holds a provider key. Lease tokens are stored as digests
 * (sha-256), never plaintext, mirroring the real route's SEC-7 posture; the
 * plaintext token is returned once at acquire/renew and matched by digest.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { pendantSegmentId } from "@harness-adapters/pendant-contracts.ts";
import {
  AmbientStoreError,
  type AmbientAppendResult,
  type AmbientSegmentInput,
  type AmbientSegmentStore,
  type AmbientSessionProvisioner,
} from "@harness-adapters/pendant-store-client.ts";

interface StoredSegment {
  id: string;
  ordinal: number;
  text: string;
  status: string;
  confidence: number | null;
  startedAt: string;
  endedAt: string | null;
}

interface StoredSessionDoc {
  pendantSessionId: string;
  processingLocation: "cloud";
  state: "active" | "paused" | "ended";
  /** sha-256 digest of the current plaintext lease token (never store plaintext). */
  leaseDigest: string | null;
  leaseHolder: string | null;
  leaseExpiresAt: string | null;
  revision: number;
  segments: StoredSegment[];
  createdAt: string;
  updatedAt: string;
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * A durable, single-process file-backed pendant store. One JSON file per pendant
 * session under `<dataDir>/pendant/<pendantSessionId>.json`. Writes are
 * synchronous + atomic-ish (write-then-rename would be ideal, but the ambient
 * writer is single-flight per session so a torn write cannot interleave two
 * appends; we still rewrite the whole small doc each mutation which is fine at
 * ambient segment cadence).
 */
export class FilePendantStore implements AmbientSegmentStore, AmbientSessionProvisioner {
  private readonly dir: string;
  private readonly cache = new Map<string, StoredSessionDoc>();

  constructor(dataDir: string) {
    this.dir = join(dataDir, "pendant");
    mkdirSync(this.dir, { recursive: true });
  }

  private pathFor(id: string): string {
    // Guard against path traversal in the id (defensive; ids are server-minted).
    const safe = id.replace(/[^a-zA-Z0-9_.-]/g, "_");
    return join(this.dir, `${safe}.json`);
  }

  private load(id: string): StoredSessionDoc | null {
    const cached = this.cache.get(id);
    if (cached) return cached;
    const p = this.pathFor(id);
    if (!existsSync(p)) return null;
    try {
      const doc = JSON.parse(readFileSync(p, "utf8")) as StoredSessionDoc;
      this.cache.set(id, doc);
      return doc;
    } catch {
      throw new AmbientStoreError("pendant doc corrupt on disk", "protocol");
    }
  }

  private save(doc: StoredSessionDoc): void {
    doc.updatedAt = new Date().toISOString();
    this.cache.set(doc.pendantSessionId, doc);
    writeFileSync(this.pathFor(doc.pendantSessionId), JSON.stringify(doc, null, 2));
  }

  /** Enumerate all persisted sessions (for the inspect/report endpoint). */
  listSessions(): { pendantSessionId: string; state: string; segmentCount: number }[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const out: { pendantSessionId: string; state: string; segmentCount: number }[] = [];
    for (const f of files) {
      try {
        const doc = JSON.parse(readFileSync(join(this.dir, f), "utf8")) as StoredSessionDoc;
        out.push({
          pendantSessionId: doc.pendantSessionId,
          state: doc.state,
          segmentCount: doc.segments.length,
        });
      } catch {
        /* skip corrupt */
      }
    }
    return out;
  }

  /** Read the committed segments for a session (inspect / evidence). */
  readSegments(pendantSessionId: string): StoredSegment[] {
    const doc = this.load(pendantSessionId);
    return doc?.segments ?? [];
  }

  // --- AmbientSessionProvisioner (mint-time) ---

  async createSession(processingLocation: "cloud"): Promise<{ pendantSessionId: string }> {
    const pendantSessionId = `pendant-${randomUUID()}`;
    const now = new Date().toISOString();
    const doc: StoredSessionDoc = {
      pendantSessionId,
      processingLocation,
      state: "active",
      leaseDigest: null,
      leaseHolder: null,
      leaseExpiresAt: null,
      revision: 0,
      segments: [],
      createdAt: now,
      updatedAt: now,
    };
    this.save(doc);
    return { pendantSessionId };
  }

  async sessionExists(pendantSessionId: string): Promise<boolean> {
    return this.load(pendantSessionId) !== null;
  }

  async acquireLease(
    pendantSessionId: string,
    holder: string,
    leaseMs: number,
  ): Promise<{ leaseToken: string; leaseExpiresAt: string }> {
    const doc = this.load(pendantSessionId);
    if (!doc) throw new AmbientStoreError("pendant session not found", "not_found", 404);
    if (doc.state === "ended") throw new AmbientStoreError("session ended", "revision_conflict", 409);
    // A live, unexpired lease held by a DIFFERENT holder is a conflict (SEC-7).
    if (
      doc.leaseDigest &&
      doc.leaseHolder &&
      doc.leaseHolder !== holder &&
      doc.leaseExpiresAt &&
      new Date(doc.leaseExpiresAt).getTime() > Date.now()
    ) {
      throw new AmbientStoreError("capture lease already held", "lease_conflict", 409);
    }
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    doc.leaseDigest = digest(leaseToken);
    doc.leaseHolder = holder;
    doc.leaseExpiresAt = leaseExpiresAt;
    doc.revision += 1;
    this.save(doc);
    return { leaseToken, leaseExpiresAt };
  }

  // --- AmbientSegmentStore (runtime) ---

  async getSessionState(
    pendantSessionId: string,
  ): Promise<{ segmentCount: number; state: "active" | "paused" | "ended" }> {
    const doc = this.load(pendantSessionId);
    if (!doc) throw new AmbientStoreError("pendant session not found", "not_found", 404);
    return { segmentCount: doc.segments.length, state: doc.state };
  }

  async appendSegment(
    pendantSessionId: string,
    leaseToken: string,
    input: AmbientSegmentInput,
  ): Promise<AmbientAppendResult> {
    const doc = this.load(pendantSessionId);
    if (!doc) throw new AmbientStoreError("pendant session not found", "not_found", 404);
    if (doc.state === "paused") throw new AmbientStoreError("session paused", "revision_conflict", 409);
    if (doc.state === "ended") throw new AmbientStoreError("session ended", "revision_conflict", 409);
    if (!doc.leaseDigest || digest(leaseToken) !== doc.leaseDigest) {
      throw new AmbientStoreError("lease mismatch", "lease_conflict", 409);
    }
    if (input.ordinal !== doc.segments.length) {
      throw new AmbientStoreError(
        `non-contiguous ordinal (expected ${doc.segments.length}, got ${input.ordinal})`,
        "validation",
        400,
      );
    }
    const id = pendantSegmentId(pendantSessionId, input.ordinal);
    doc.segments.push({
      id,
      ordinal: input.ordinal,
      text: input.text,
      status: input.status,
      confidence: input.confidence,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
    });
    doc.revision += 1;
    this.save(doc);
    return {
      segmentId: id,
      ordinal: input.ordinal,
      revision: 0,
      sessionRevision: doc.revision,
      segmentCount: doc.segments.length,
    };
  }

  async setState(pendantSessionId: string, state: "paused" | "active" | "ended"): Promise<void> {
    const doc = this.load(pendantSessionId);
    if (!doc) throw new AmbientStoreError("pendant session not found", "not_found", 404);
    if (doc.state === "ended") {
      // Ended is immutable (design): a further transition is a no-op-if-same,
      // conflict otherwise.
      if (state !== "ended") throw new AmbientStoreError("session ended", "revision_conflict", 409);
      return;
    }
    doc.state = state;
    doc.revision += 1;
    this.save(doc);
  }

  async renewLease(
    pendantSessionId: string,
    holder: string,
    currentLeaseToken: string,
    leaseMs: number,
  ): Promise<{ leaseToken: string; leaseExpiresAt: string }> {
    const doc = this.load(pendantSessionId);
    if (!doc) throw new AmbientStoreError("pendant session not found", "not_found", 404);
    if (doc.state === "ended") throw new AmbientStoreError("session ended", "revision_conflict", 409);
    // The renew must present the current lease (SEC-7: current holder branch).
    if (!doc.leaseDigest || digest(currentLeaseToken) !== doc.leaseDigest) {
      throw new AmbientStoreError("lease mismatch on renew", "lease_conflict", 409);
    }
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    doc.leaseDigest = digest(leaseToken);
    doc.leaseHolder = holder;
    doc.leaseExpiresAt = leaseExpiresAt;
    doc.revision += 1;
    this.save(doc);
    return { leaseToken, leaseExpiresAt };
  }
}
