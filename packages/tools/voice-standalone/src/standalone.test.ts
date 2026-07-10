/**
 * Standalone voice backend — service-lifecycle, auth-gate, and store-durability
 * tests. These drive the REAL server module (startStandaloneVoiceServer) and the
 * REAL file-backed store over its actual HTTP surface (no mocks standing in for
 * the thing under test). Provider legs are NOT exercised here (that is the
 * live-provider E2E driver's job, evidence captured outside the repo) — these
 * tests own the boundary correctness the E2E cannot cheaply assert repeatedly:
 * boot/health/shutdown, the auth gate (401 on missing/wrong token, no mint), the
 * consent single-use precondition, and file-store durability across a restart.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startStandaloneVoiceServer, type RunningStandaloneServer } from "../../../cloud/api/v1/voice/session/lib/standalone-server.ts";
import { FilePendantStore } from "./file-pendant-store.ts";

const AUTH = "test-shared-secret-abc123";
const PROVIDER_STUB = "unused-in-boundary-tests"; // provider legs not exercised here

let dataDir: string;
let server: RunningStandaloneServer | null = null;
let base: string;

async function boot(store?: FilePendantStore): Promise<RunningStandaloneServer> {
  const s = await startStandaloneVoiceServer({
    host: "127.0.0.1",
    port: pickPort(),
    authToken: AUTH,
    deepgramApiKey: PROVIDER_STUB,
    cartesiaApiKey: PROVIDER_STUB,
    cartesiaVoiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
    elizaEndpoint: "https://openrouter.ai/api/v1/chat/completions",
    elizaAuthorization: "Bearer unused",
    organizationId: "00000000-0000-4000-8000-0000000000a1",
    userId: "00000000-0000-4000-8000-0000000000b2",
    agentId: "00000000-0000-4000-8000-0000000000c3",
    conversationId: "00000000-0000-4000-8000-0000000000d4",
    ambientStore: store ?? new FilePendantStore(dataDir),
    hooks: { log: () => {} },
  });
  return s;
}

// Deterministic ephemeral port in a high range to avoid collisions in CI.
let portCounter = 27801 + Math.floor(Math.random() * 400);
function pickPort(): number {
  return portCounter++;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "vsa-test-"));
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("service lifecycle", () => {
  test("boots, serves unauthenticated health, and shuts down cleanly", async () => {
    server = await boot();
    base = `http://127.0.0.1:${server.port}`;

    const health = await fetch(`${base}/api/v1/voice/session/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { ok: boolean; service: string; liveSessions: number };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("voice-standalone");
    expect(body.liveSessions).toBe(0);

    await server.stop();
    server = null;

    // After shutdown the port must no longer accept connections.
    let refused = false;
    try {
      await fetch(`${base}/api/v1/voice/session/health`, { signal: AbortSignal.timeout(1000) });
    } catch {
      refused = true;
    }
    expect(refused).toBe(true);
  });
});

describe("auth gate", () => {
  beforeEach(async () => {
    server = await boot();
    base = `http://127.0.0.1:${server.port}`;
  });

  test("consent with NO token is 401 (no nonce issued)", async () => {
    const res = await fetch(`${base}/api/v1/voice/session/consent`, { method: "POST" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string; consentNonce?: string };
    expect(body.consentNonce).toBeUndefined();
  });

  test("consent with WRONG token is 401", async () => {
    const res = await fetch(`${base}/api/v1/voice/session/consent`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  test("mint with NO token is 401 (no session minted)", async () => {
    const res = await fetch(`${base}/api/v1/voice/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ consentNonce: "anything" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { token?: string };
    expect(body.token).toBeUndefined();
  });

  test("authed consent issues a nonce; authed mint requires+consumes it", async () => {
    const consent = await fetch(`${base}/api/v1/voice/session/consent`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(consent.status).toBe(200);
    const { consentNonce } = (await consent.json()) as { consentNonce: string };
    expect(typeof consentNonce).toBe("string");

    // Mint WITHOUT the nonce → 400.
    const noNonce = await fetch(`${base}/api/v1/voice/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(noNonce.status).toBe(400);

    // Mint WITH the nonce → 200, real scoped token + wsUrl.
    const mint = await fetch(`${base}/api/v1/voice/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH}`, "content-type": "application/json" },
      body: JSON.stringify({ consentNonce }),
    });
    expect(mint.status).toBe(200);
    const minted = (await mint.json()) as { token: string; wsUrl: string; sessionId: string };
    expect(minted.token.split(".")).toHaveLength(3); // JWS compact
    expect(minted.wsUrl).toContain("/api/v1/voice/session/ws?sessionId=");
    expect(minted.sessionId).toBeTruthy();

    // REPLAY the same nonce → 403 consent_required (single-use enforced).
    const replay = await fetch(`${base}/api/v1/voice/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH}`, "content-type": "application/json" },
      body: JSON.stringify({ consentNonce }),
    });
    expect(replay.status).toBe(403);
  });

  test("ambient mint returns an empty downlink + cloud processing location", async () => {
    const consent = await fetch(`${base}/api/v1/voice/session/consent`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH}` },
    });
    const { consentNonce } = (await consent.json()) as { consentNonce: string };
    const mint = await fetch(`${base}/api/v1/voice/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH}`, "content-type": "application/json" },
      body: JSON.stringify({ consentNonce, mode: "ambient" }),
    });
    expect(mint.status).toBe(200);
    const minted = (await mint.json()) as {
      mode: string;
      pendantSessionId: string;
      captureLeaseToken: string;
      downlink: { codecs: string[] };
      processingLocation: string;
    };
    expect(minted.mode).toBe("ambient");
    expect(minted.pendantSessionId).toContain("pendant-");
    expect(minted.captureLeaseToken).toBeTruthy();
    expect(minted.downlink.codecs).toEqual([]);
    expect(minted.processingLocation).toBe("cloud");
  });
});

describe("file store durability (restart recovery)", () => {
  test("ambient segments survive a service restart", async () => {
    // Boot 1: mint an ambient session (creates the pendant session on disk) and
    // append two segments through the store directly (the runtime append path).
    const store1 = new FilePendantStore(dataDir);
    server = await boot(store1);
    base = `http://127.0.0.1:${server.port}`;

    const consent = await fetch(`${base}/api/v1/voice/session/consent`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH}` },
    });
    const { consentNonce } = (await consent.json()) as { consentNonce: string };
    const mint = await fetch(`${base}/api/v1/voice/session`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AUTH}`, "content-type": "application/json" },
      body: JSON.stringify({ consentNonce, mode: "ambient" }),
    });
    const minted = (await mint.json()) as { pendantSessionId: string; captureLeaseToken: string };

    // Commit two segments via the REAL store contract (contiguous ordinals).
    await store1.appendSegment(minted.pendantSessionId, minted.captureLeaseToken, {
      ordinal: 0,
      text: "first segment",
      words: [],
      status: "resolved",
      confidence: 0.9,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });
    await store1.appendSegment(minted.pendantSessionId, minted.captureLeaseToken, {
      ordinal: 1,
      text: "second segment",
      words: [],
      status: "resolved",
      confidence: 0.9,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });

    await server.stop();
    server = null;

    // Boot 2: a FRESH store instance over the same dataDir must read both
    // segments back (proves file persistence, not in-memory).
    const store2 = new FilePendantStore(dataDir);
    const recovered = store2.readSegments(minted.pendantSessionId);
    expect(recovered).toHaveLength(2);
    expect(recovered.map((s) => s.ordinal)).toEqual([0, 1]);
    expect(recovered.map((s) => s.text)).toEqual(["first segment", "second segment"]);

    // And the new server serves them over the inspect route.
    server = await boot(store2);
    base = `http://127.0.0.1:${server.port}`;
    const segRes = await fetch(
      `${base}/api/v1/voice/session/segments?pendantSessionId=${encodeURIComponent(minted.pendantSessionId)}`,
      { headers: { Authorization: `Bearer ${AUTH}` } },
    );
    expect(segRes.status).toBe(200);
    const seg = (await segRes.json()) as { segments: { ordinal: number }[] };
    expect(seg.segments).toHaveLength(2);
  });

  test("store enforces contiguous ordinals, lease match, and paused-refuses-append", async () => {
    const store = new FilePendantStore(dataDir);
    const { pendantSessionId } = await store.createSession("cloud");
    const { leaseToken } = await store.acquireLease(pendantSessionId, "holder", 60_000);

    // Non-contiguous ordinal is rejected.
    await expect(
      store.appendSegment(pendantSessionId, leaseToken, {
        ordinal: 5,
        text: "x",
        words: [],
        status: "resolved",
        confidence: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
      }),
    ).rejects.toThrow();

    // Wrong lease is rejected.
    await expect(
      store.appendSegment(pendantSessionId, "wrong-lease", {
        ordinal: 0,
        text: "x",
        words: [],
        status: "resolved",
        confidence: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
      }),
    ).rejects.toThrow();

    // Correct append works.
    await store.appendSegment(pendantSessionId, leaseToken, {
      ordinal: 0,
      text: "ok",
      words: [],
      status: "resolved",
      confidence: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
    });

    // Paused refuses append.
    await store.setState(pendantSessionId, "paused");
    await expect(
      store.appendSegment(pendantSessionId, leaseToken, {
        ordinal: 1,
        text: "y",
        words: [],
        status: "resolved",
        confidence: null,
        startedAt: new Date().toISOString(),
        endedAt: null,
      }),
    ).rejects.toThrow();
  });
});
