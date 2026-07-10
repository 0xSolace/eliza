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

describe("POST /api/asr/cloud", () => {
  // Build a real mono PCM16 WAV. `dataSamples` = number of int16 samples of data.
  // `declared` overrides the RIFF/data sizes to simulate the iOS placeholder bug
  // (undefined = write correct/canonical sizes like desktop Chrome).
  function makeWav(
    dataSamples: number,
    sampleRate = 48000,
    declared?: { riffSize?: number; dataBytes?: number },
  ): Uint8Array {
    const dataBytes = dataSamples * 2;
    const buf = Buffer.alloc(44 + dataBytes);
    buf.write("RIFF", 0, "ascii");
    buf.writeUInt32LE(declared?.riffSize ?? 36 + dataBytes, 4);
    buf.write("WAVE", 8, "ascii");
    buf.write("fmt ", 12, "ascii");
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20); // PCM
    buf.writeUInt16LE(1, 22); // mono
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36, "ascii");
    buf.writeUInt32LE(declared?.dataBytes ?? dataBytes, 40);
    // Non-zero samples so the body isn't classified as empty.
    for (let i = 0; i < dataSamples; i += 1) buf.writeInt16LE(1000, 44 + i * 2);
    return new Uint8Array(buf);
  }
  const wav = () => makeWav(160); // non-empty PCM16 WAV with canonical sizes
  async function bootAsr(deepgramFetch: typeof fetch): Promise<RunningStandaloneServer> {
    return startStandaloneVoiceServer({
      host: "127.0.0.1", port: pickPort(), authToken: AUTH,
      deepgramApiKey: PROVIDER_STUB, cartesiaApiKey: PROVIDER_STUB,
      cartesiaVoiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
      elizaEndpoint: "https://openrouter.ai/api/v1/chat/completions", elizaAuthorization: "Bearer unused",
      organizationId: "00000000-0000-4000-8000-0000000000a1",
      userId: "00000000-0000-4000-8000-0000000000b2",
      agentId: "00000000-0000-4000-8000-0000000000c3",
      conversationId: "00000000-0000-4000-8000-0000000000d4",
      ambientStore: new FilePendantStore(dataDir), hooks: { log: () => {} }, deepgramFetch,
    });
  }

  test("returns exact { text } contract for raw WAV", async () => {
    let forwarded: RequestInit | undefined;
    server = await bootAsr((async (_url, init) => {
      forwarded = init;
      return Response.json({ results: { channels: [{ alternatives: [{ transcript: "  what is the weather  " }] }] } });
    }) as unknown as typeof fetch);
    base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/api/asr/cloud`, { method: "POST", headers: { Authorization: `Bearer ${AUTH}`, "Content-Type": "audio/wav" }, body: wav() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "what is the weather" });
    expect((forwarded?.headers as Record<string, string>).Authorization).toBe(`Token ${PROVIDER_STUB}`);
  });

  test("auth gate rejects before provider access", async () => {
    let called = false;
    server = await bootAsr((async () => { called = true; return Response.json({}); }) as unknown as typeof fetch);
    base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/api/asr/cloud`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: wav() });
    expect(res.status).toBe(401);
    expect(called).toBe(false);
  });

  test("empty audio is 400", async () => {
    server = await bootAsr(fetch);
    base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/api/asr/cloud`, { method: "POST", headers: { Authorization: `Bearer ${AUTH}`, "Content-Type": "audio/wav" }, body: new Uint8Array() });
    expect(res.status).toBe(400);
  });

  test("provider error is 502", async () => {
    server = await bootAsr((async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch);
    base = `http://127.0.0.1:${server.port}`;
    const res = await fetch(`${base}/api/asr/cloud`, { method: "POST", headers: { Authorization: `Bearer ${AUTH}`, "Content-Type": "audio/wav" }, body: wav() });
    expect(res.status).toBe(502);
  });

  // #ios-asr-fix: iPhone posts WAVs whose declared RIFF/data sizes DON'T match
  // the payload (streaming placeholder / early flush). Deepgram 408s those. The
  // shim must rewrite a clean header (and forward raw linear16) so the turn
  // succeeds. This is the exact bug that killed the mic on the installed PWA.
  test("WAV with wrong declared sizes still transcribes (iOS placeholder)", async () => {
    let forwardedUrl = "";
    let forwardedBytes = -1;
    server = await bootAsr((async (url, init) => {
      forwardedUrl = String(url);
      const body = (init as RequestInit | undefined)?.body;
      forwardedBytes = body instanceof Uint8Array ? body.byteLength : Buffer.isBuffer(body) ? body.length : -1;
      return Response.json({ results: { channels: [{ alternatives: [{ transcript: "weather please" }] }] } });
    }) as unknown as typeof fetch);
    base = `http://127.0.0.1:${server.port}`;
    // 320 samples of PCM (640 data bytes) but the header lies: RIFF=0xffffffff,
    // data=0xffffffff (classic iOS streaming placeholder).
    const bad = makeWav(320, 48000, { riffSize: 0xffffffff, dataBytes: 0xffffffff });
    const res = await fetch(`${base}/api/asr/cloud`, { method: "POST", headers: { Authorization: `Bearer ${AUTH}`, "Content-Type": "audio/wav" }, body: bad });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "weather please" });
    // Forwarded as raw linear16 (header stripped): exactly the data bytes.
    expect(forwardedBytes).toBe(640);
    expect(forwardedUrl).toContain("encoding=linear16");
    expect(forwardedUrl).toContain("sample_rate=48000");
  });

  test("empty data chunk (near-silent iOS capture) is 400", async () => {
    let called = false;
    server = await bootAsr((async () => { called = true; return Response.json({}); }) as unknown as typeof fetch);
    base = `http://127.0.0.1:${server.port}`;
    // Valid header, zero data samples — mic denied / suspended AudioContext.
    const empty = makeWav(0);
    const res = await fetch(`${base}/api/asr/cloud`, { method: "POST", headers: { Authorization: `Bearer ${AUTH}`, "Content-Type": "audio/wav" }, body: empty });
    expect(res.status).toBe(400);
    expect(called).toBe(false); // never wastes a provider round-trip
  });

  test("canonical desktop WAV forwards raw PCM data unchanged", async () => {
    let forwardedBytes = -1;
    server = await bootAsr((async (_url, init) => {
      const body = (init as RequestInit | undefined)?.body;
      forwardedBytes = body instanceof Uint8Array ? body.byteLength : Buffer.isBuffer(body) ? body.length : -1;
      return Response.json({ results: { channels: [{ alternatives: [{ transcript: "ok" }] }] } });
    }) as unknown as typeof fetch);
    base = `http://127.0.0.1:${server.port}`;
    const good = makeWav(160); // canonical, 320 data bytes
    const res = await fetch(`${base}/api/asr/cloud`, { method: "POST", headers: { Authorization: `Bearer ${AUTH}`, "Content-Type": "audio/wav" }, body: good });
    expect(res.status).toBe(200);
    expect(forwardedBytes).toBe(320); // raw PCM data, header stripped
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
