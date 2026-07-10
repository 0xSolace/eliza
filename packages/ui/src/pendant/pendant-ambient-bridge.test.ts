/**
 * PendantAmbientBridge drives the pendant→ambient uplink through an injected
 * WebSocket + mint. The fakes are TRANSPORTS (fake WS, fake mint, fake PCM
 * frame source) — the tests exercise the REAL framing / resample / segment
 * mapping / pause / BLE-drop / fallback code, never a stub of the bridge.
 */

// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import {
  AmbientMintUnavailableError,
  PendantAmbientBridge,
  pendantCodecSampleRateHz,
  type AmbientBridgeEndReason,
  type AmbientWebSocketLike,
} from "./pendant-ambient-bridge";
import type { AmbientMintResponse } from "../voice/ambient-uplink-protocol";
import type { PendantTranscriptSegmentDetail } from "./transcript-segment-event";
import { int16BytesToFloatPcm } from "../voice/voice-session-pcm";

// ── Fake WebSocket (transport double) ────────────────────────────────────

type Listeners = {
  open: Array<() => void>;
  message: Array<(e: { data: unknown }) => void>;
  close: Array<(e: { code?: number; reason?: string }) => void>;
  error: Array<() => void>;
};

class FakeWs implements AmbientWebSocketLike {
  binaryType = "blob";
  readonly url: string;
  readonly sent: Array<string | ArrayBufferLike | ArrayBufferView> = [];
  closed: { code?: number; reason?: string } | null = null;
  private readonly l: Listeners = { open: [], message: [], close: [], error: [] };

  constructor(url: string) {
    this.url = url;
  }
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (this.closed) throw new Error("send after close");
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = { code, reason };
    for (const fn of this.l.close) fn({ code, reason });
  }
  addEventListener(type: keyof Listeners, listener: (...a: never[]) => void): void {
    (this.l[type] as Array<(...a: never[]) => void>).push(listener);
  }
  // test drivers
  emitOpen(): void {
    for (const fn of this.l.open) fn();
  }
  emitMessage(data: unknown): void {
    for (const fn of this.l.message) fn({ data });
  }
  emitServerClose(code = 1006): void {
    // Server/network closes the socket (distinct from a client-side close()).
    if (this.closed) return;
    this.closed = { code };
    for (const fn of this.l.close) fn({ code });
  }
  emitError(): void {
    for (const fn of this.l.error) fn();
  }
  /** JSON control frames the client sent (text). */
  get controls(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  /** Binary uplink frames the client sent, decoded back to Float32 PCM. */
  get uplinkPcm(): Float32Array[] {
    return this.sent
      .filter((s): s is ArrayBuffer => s instanceof ArrayBuffer)
      .map((buf) => int16BytesToFloatPcm(new Uint8Array(buf)));
  }
  get uplinkFrameCount(): number {
    return this.sent.filter((s) => s instanceof ArrayBuffer).length;
  }
}

// ── Fakes / helpers ──────────────────────────────────────────────────────

function ambientMint(over: Partial<AmbientMintResponse> = {}): AmbientMintResponse {
  return {
    sessionId: "sess-1",
    wsUrl: "wss://cloud/api/v1/voice/session/ws",
    token: "jwt-token",
    expiresAt: Date.now() + 120_000,
    mode: "ambient",
    pendantSessionId: "pendant-abc",
    captureLeaseToken: "lease-xyz",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    uplink: { codecs: ["pcm16"] },
    downlink: { codecs: [] },
    processingLocation: "cloud",
    iceServers: null,
    ...over,
  };
}

interface Harness {
  bridge: PendantAmbientBridge;
  ws: FakeWs;
  segments: PendantTranscriptSegmentDetail[];
  transcripts: string[];
  ends: AmbientBridgeEndReason[];
  readys: number;
}

function makeBridge(opts?: {
  mint?: () => Promise<AmbientMintResponse>;
}): Harness {
  const segments: PendantTranscriptSegmentDetail[] = [];
  const transcripts: string[] = [];
  const ends: AmbientBridgeEndReason[] = [];
  let readys = 0;
  let ws!: FakeWs;
  const bridge = new PendantAmbientBridge({
    mint: opts?.mint ?? (async () => ambientMint()),
    webSocketFactory: (url) => {
      ws = new FakeWs(url);
      return ws;
    },
    onSegment: (d) => segments.push(d),
    onTranscript: (t) => transcripts.push(t),
    onEnd: (r) => ends.push(r),
    onReady: () => {
      readys += 1;
    },
    now: () => 1000,
  });
  return {
    bridge,
    get ws() {
      return ws;
    },
    segments,
    transcripts,
    ends,
    get readys() {
      return readys;
    },
  } as Harness;
}

/** Wait until the injected WebSocket has been constructed by start(). */
async function waitForWs(h: Harness): Promise<FakeWs> {
  for (let i = 0; i < 20 && !h.ws; i++) await Promise.resolve();
  expect(h.ws).toBeDefined();
  return h.ws;
}

/** Bring a bridge fully live: start → open → hello → server ready. */
async function bringLive(h: Harness): Promise<void> {
  const armedP = h.bridge.start();
  const ws = await waitForWs(h);
  ws.emitOpen();
  const armed = await armedP;
  expect(armed).toBe(true);
  h.ws.emitMessage(
    JSON.stringify({
      t: "ready",
      sessionId: "sess-1",
      pendantSessionId: "pendant-abc",
      traceId: "trace-1",
    }),
  );
  expect(h.bridge.isReady).toBe(true);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("PendantAmbientBridge", () => {
  it("sends the ambient hello first, then streams 16k PCM frames to the uplink", async () => {
    const h = makeBridge();
    await bringLive(h);
    expect(h.readys).toBe(1);

    // First control frame MUST be the ambient hello with the token + lease.
    const hello = h.ws.controls[0];
    expect(hello).toMatchObject({
      t: "hello",
      mode: "ambient",
      token: "jwt-token",
      pendantSessionId: "pendant-abc",
      captureLeaseToken: "lease-xyz",
      uplinkCodec: "pcm16",
      sampleRate: 16000,
    });

    // Feed 3200 samples of already-16k PCM → exactly 2 x 1600-sample frames.
    h.bridge.pushPcm(new Float32Array(3200).fill(0.5), 16000);
    expect(h.ws.uplinkFrameCount).toBe(2);
    // Each frame is 1600 samples = 3200 bytes int16.
    expect(h.ws.uplinkPcm[0]!.length).toBe(1600);
    // Value round-trips (0.5 → int16 → ~0.5 within 1 LSB).
    expect(h.ws.uplinkPcm[0]![0]!).toBeCloseTo(0.5, 2);
  });

  it("buffers a partial frame across pushes (no short frames on the wire)", async () => {
    const h = makeBridge();
    await bringLive(h);
    // 1000 samples < one 1600-sample frame → nothing sent yet.
    h.bridge.pushPcm(new Float32Array(1000).fill(0.1), 16000);
    expect(h.ws.uplinkFrameCount).toBe(0);
    // +800 → 1800 total → one full 1600 frame, 200 carried.
    h.bridge.pushPcm(new Float32Array(800).fill(0.1), 16000);
    expect(h.ws.uplinkFrameCount).toBe(1);
  });

  it("resamples an 8k pendant codec up to the 16k uplink contract", async () => {
    const h = makeBridge();
    await bringLive(h);
    // 800 samples @ 8k ≈ 1600 samples @16k → ~1 frame.
    h.bridge.pushPcm(new Float32Array(1600).fill(0.25), 8000);
    // 1600 @8k → ~3200 @16k → 2 frames.
    expect(h.ws.uplinkFrameCount).toBe(2);
  });

  it("maps stt_final → a resolved segment (canonical id) + a transcript dispatch", async () => {
    const h = makeBridge();
    await bringLive(h);
    h.ws.emitMessage(
      JSON.stringify({
        t: "stt_final",
        text: "what is the weather in denver",
        segmentId: "pendant-abc:segment:0",
        ordinal: 0,
        revision: 1,
        traceId: "trace-2",
      }),
    );
    const resolved = h.segments.find((s) => s.status === "resolved");
    expect(resolved).toBeDefined();
    expect(resolved!.id).toBe("pendant-abc:segment:0");
    expect(resolved!.text).toBe("what is the weather in denver");
    expect(h.transcripts).toEqual(["what is the weather in denver"]);
  });

  it("maps stt_partial → an interim pending segment, coalescing duplicates", async () => {
    const h = makeBridge();
    await bringLive(h);
    h.ws.emitMessage(JSON.stringify({ t: "stt_partial", text: "what is", traceId: "t" }));
    h.ws.emitMessage(JSON.stringify({ t: "stt_partial", text: "what is", traceId: "t" }));
    h.ws.emitMessage(JSON.stringify({ t: "stt_partial", text: "what is the", traceId: "t" }));
    const pendings = h.segments.filter((s) => s.status === "pending");
    // Duplicate identical partial is coalesced → 2 pending emits, not 3.
    expect(pendings.length).toBe(2);
    expect(pendings[1]!.text).toBe("what is the");
  });

  it("an empty stt_final is a discarded segment, never a transcript dispatch", async () => {
    const h = makeBridge();
    await bringLive(h);
    h.ws.emitMessage(
      JSON.stringify({
        t: "stt_final",
        text: "   ",
        segmentId: "pendant-abc:segment:1",
        ordinal: 1,
        revision: 1,
        traceId: "t",
      }),
    );
    expect(h.segments.at(-1)!.status).toBe("discarded");
    expect(h.transcripts).toEqual([]);
  });

  it("pause sends a pause control frame and drops audio (Flux severed server-side)", async () => {
    const h = makeBridge();
    await bringLive(h);
    h.bridge.pause();
    expect(h.bridge.isPaused).toBe(true);
    expect(h.ws.controls.some((c) => c.t === "pause")).toBe(true);
    const before = h.ws.uplinkFrameCount;
    h.bridge.pushPcm(new Float32Array(3200).fill(0.5), 16000);
    // No frames while paused (not ingested, not metered).
    expect(h.ws.uplinkFrameCount).toBe(before);
    // Resume sends a resume frame and re-enables audio.
    h.bridge.resume();
    expect(h.ws.controls.some((c) => c.t === "resume")).toBe(true);
    h.bridge.pushPcm(new Float32Array(3200).fill(0.5), 16000);
    expect(h.ws.uplinkFrameCount).toBeGreaterThan(before);
  });

  it("a BLE drop mid-session ends cleanly with a bye + server_close", async () => {
    const h = makeBridge();
    await bringLive(h);
    h.bridge.handleTransportLoss();
    expect(h.ends).toEqual(["server_close"]);
    // The socket was closed cleanly (1000).
    expect(h.ws.closed?.code).toBe(1000);
    // Further pushes are inert after end.
    h.bridge.pushPcm(new Float32Array(3200).fill(0.5), 16000);
    expect(h.ws.uplinkFrameCount).toBe(0);
  });

  it("stop() sends a clean bye then ends with reason bye", async () => {
    const h = makeBridge();
    await bringLive(h);
    h.bridge.stop();
    expect(h.ws.controls.at(-1)).toMatchObject({ t: "bye" });
    expect(h.ends).toEqual(["bye"]);
  });

  it("a fatal (non-retryable) server error ends the session", async () => {
    const h = makeBridge();
    await bringLive(h);
    h.ws.emitMessage(JSON.stringify({ t: "error", code: "quota_exhausted", retryable: false }));
    expect(h.ends).toEqual(["server_error"]);
  });

  it("a retryable server error does NOT end the session", async () => {
    const h = makeBridge();
    await bringLive(h);
    h.ws.emitMessage(JSON.stringify({ t: "error", code: "lease_renew_failed", retryable: true }));
    expect(h.ends).toEqual([]);
    expect(h.bridge.isReady).toBe(true);
  });

  it("a malformed / unknown server frame is ignored (session survives)", async () => {
    const h = makeBridge();
    await bringLive(h);
    h.ws.emitMessage("not json {");
    h.ws.emitMessage(JSON.stringify({ t: "totally_unknown" }));
    h.ws.emitMessage(new ArrayBuffer(8)); // ambient has no downlink audio
    expect(h.bridge.isReady).toBe(true);
    expect(h.ends).toEqual([]);
  });

  // ── Fallback semantics (the non-regression law) ────────────────────────

  it("mint 404 → start() returns false + mint_unavailable (caller uses batch)", async () => {
    const h = makeBridge({
      mint: async () => {
        throw new AmbientMintUnavailableError(404);
      },
    });
    const armed = await h.bridge.start();
    expect(armed).toBe(false);
    expect(h.ends).toEqual(["mint_unavailable"]);
  });

  it("mint failure (non-404) → start() returns false + mint_failed", async () => {
    const h = makeBridge({
      mint: async () => {
        throw new Error("network down");
      },
    });
    const armed = await h.bridge.start();
    expect(armed).toBe(false);
    expect(h.ends).toEqual(["mint_failed"]);
  });

  it("a malformed mint response → mint_failed (never arms on junk)", async () => {
    const h = makeBridge({
      mint: async () => ambientMint({ pendantSessionId: "" }),
    });
    const armed = await h.bridge.start();
    expect(armed).toBe(false);
    expect(h.ends).toEqual(["mint_failed"]);
  });

  it("server rejects the hello (clean close before ready) → hello_rejected", async () => {
    const h = makeBridge();
    const armedP = h.bridge.start();
    const ws = await waitForWs(h);
    ws.emitOpen();
    await armedP; // start resolves true (WS opened); rejection comes async.
    // Server closes before sending `ready` (e.g. lease/claim/mode mismatch).
    h.ws.emitServerClose(1000);
    expect(h.ends).toEqual(["hello_rejected"]);
    expect(h.bridge.isReady).toBe(false);
  });

  it("audio pushed before ready is dropped (no uplink until server ready)", async () => {
    const h = makeBridge();
    const armedP = h.bridge.start();
    const ws = await waitForWs(h);
    ws.emitOpen();
    await armedP;
    // hello sent but no ready yet.
    h.bridge.pushPcm(new Float32Array(3200).fill(0.5), 16000);
    expect(h.ws.uplinkFrameCount).toBe(0);
  });
});

describe("pendantCodecSampleRateHz", () => {
  it("maps omi codec ids to their native decoded rate", () => {
    expect(pendantCodecSampleRateHz(20)).toBe(16000); // OPUS_16K
    expect(pendantCodecSampleRateHz(1)).toBe(16000); // PCM_16K
    expect(pendantCodecSampleRateHz(0)).toBe(8000); // PCM_8K
    expect(pendantCodecSampleRateHz(10)).toBe(8000); // MU_LAW_8K
    expect(pendantCodecSampleRateHz(null)).toBe(16000); // default
  });
});
