/**
 * PendantConnection ↔ ambient bridge wiring. Proves engine SELECT (ambient vs
 * batch), the non-regression fallback, no-double-ingestion (a decoded frame goes
 * to exactly ONE engine), pause/resume forwarding, and BLE-drop teardown of the
 * ambient session — all through injected transports (no real BLE / WS / ASR).
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { OMI_CODEC, type OmiCodecId } from "./omi-protocol";
import type {
  PendantAudioListener,
  PendantBatteryListener,
  PendantTransport,
} from "./pendant-transport";

// Decoder: each 4-byte notification decodes to 160 samples (10ms @16k) so we
// can drive the batch VAD + count ambient pushes deterministically.
vi.mock("./opus-frame-decoder", () => ({
  createPendantAudioDecoder: vi.fn(async () => ({
    ready: Promise.resolve(),
    decodeFrame: () => new Float32Array(160).fill(0.3),
    free: vi.fn(),
  })),
}));

// Batch ASR: count invocations so we can assert it is NEVER called in ambient.
const asrCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock("../voice/local-asr-transcribe", () => ({
  transcribeLocalInferenceWav: vi.fn(async () => {
    asrCalls.n += 1;
    return { text: "batch text", words: [] };
  }),
}));

// VAD: force stop when a control flag flips so we can trigger a batch utterance.
let forceStop = false;
vi.mock("../voice/local-asr-capture", () => ({
  createLocalAsrAutoStopDetector: () => () => ({
    shouldBuffer: true,
    shouldStop: forceStop,
  }),
  encodeMonoPcm16Wav: () => new Uint8Array([1, 2, 3]),
  isSilentPcmAudio: () => false,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
}));

import {
  PendantConnection,
  type PendantAmbientBridgeHooks,
  type PendantState,
} from "./pendant-connection";
import type { PendantAmbientBridge } from "./pendant-ambient-bridge";

/** Fake transport (same shape as the main pendant-connection suite). */
class FakeTransport implements PendantTransport {
  readonly kind = "web-bluetooth" as const;
  audioListener: PendantAudioListener | null = null;
  disconnectedHandler: (() => void) | null = null;
  disconnectCalls = 0;
  constructor(private readonly codec: OmiCodecId = OMI_CODEC.OPUS_16K) {}
  async requestAndConnect() {
    return { deviceName: "omi pendant" };
  }
  async readCodec() {
    return this.codec;
  }
  async startAudio(listener: PendantAudioListener) {
    this.audioListener = listener;
  }
  async startBattery(_l: PendantBatteryListener) {
    return null;
  }
  onDisconnected(handler: () => void) {
    this.disconnectedHandler = handler;
  }
  async disconnect() {
    this.disconnectCalls += 1;
  }
}

/**
 * A fake ambient bridge implementing the PendantAmbientBridge surface the
 * connection drives. `armResult` controls whether it claims ingestion (true) or
 * declines (false → batch fallback).
 */
class FakeBridge implements Partial<PendantAmbientBridge> {
  pushes: Array<{ len: number; rate: number }> = [];
  started = false;
  paused = false;
  resumed = false;
  stopped = false;
  hooks: PendantAmbientBridgeHooks;
  private ready = false;
  constructor(
    hooks: PendantAmbientBridgeHooks,
    private readonly armResult: boolean,
  ) {
    this.hooks = hooks;
  }
  get isReady() {
    return this.ready;
  }
  get isPaused() {
    return this.paused;
  }
  async start(): Promise<boolean> {
    this.started = true;
    this.ready = this.armResult;
    return this.armResult;
  }
  pushPcm(pcm: Float32Array, rate: number): void {
    if (!this.ready || this.paused) return;
    this.pushes.push({ len: pcm.length, rate });
  }
  pause(): void {
    this.paused = true;
  }
  resume(): void {
    this.paused = false;
    this.resumed = true;
  }
  renewLease(): void {}
  handleTransportLoss(): void {}
  stop(): void {
    this.stopped = true;
    this.ready = false;
  }
  // Drive server events onto the wired hooks (as the real bridge does).
  emitFinal(id: string, text: string): void {
    this.hooks.onSegment({
      id,
      status: text ? "resolved" : "discarded",
      text: text || undefined,
      startedAt: 0,
      endedAt: 0,
      durationMs: 0,
    });
    if (text) this.hooks.onTranscript(text);
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function collectStates() {
  const states: PendantState[] = [];
  return { onState: (s: PendantState) => states.push({ ...s }), states };
}

afterEach(() => {
  forceStop = false;
  asrCalls.n = 0;
  vi.clearAllMocks();
});

describe("PendantConnection ambient wiring", () => {
  it("arms the ambient bridge and routes decoded frames to it (NOT the batch VAD)", async () => {
    const transport = new FakeTransport();
    let bridge: FakeBridge | null = null;
    const segments: string[] = [];
    const transcripts: string[] = [];
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      onSegment: (d) => segments.push(`${d.status}:${d.id}`),
      onTranscript: (t) => transcripts.push(t),
      createTransport: () => transport,
      createAmbientBridge: (hooks) => {
        bridge = new FakeBridge(hooks, /* arm */ true) as unknown as PendantAmbientBridge & FakeBridge;
        return bridge as unknown as PendantAmbientBridge;
      },
    });
    await conn.connect();
    await flush();
    expect(bridge).not.toBeNull();
    expect(bridge!.started).toBe(true);

    // Feed audio: every frame must go to the ambient bridge, never the batch ASR.
    // The reassembler emits a frame when the NEXT frameIndex-0 packet arrives,
    // so N+1 notifications produce N frames. Send 3 → 2 pushes.
    forceStop = true; // would trigger a batch utterance IF the batch path ran.
    transport.audioListener?.(new Uint8Array([1, 0, 0, 42]));
    transport.audioListener?.(new Uint8Array([2, 0, 0, 43]));
    transport.audioListener?.(new Uint8Array([3, 0, 0, 44]));
    await flush();
    expect(bridge!.pushes.length).toBe(2);
    expect(bridge!.pushes[0]).toEqual({ len: 160, rate: 16000 });
    // NO batch ASR call — the batch engine is not fed while ambient owns ingest.
    expect(asrCalls.n).toBe(0);

    // A server-driven final segment lands on the SAME UI + dispatch callbacks.
    bridge!.emitFinal("pendant-abc:segment:0", "hello from the cloud");
    expect(segments).toContain("resolved:pendant-abc:segment:0");
    expect(transcripts).toEqual(["hello from the cloud"]);
  });

  it("falls back to the batch path UNCHANGED when the bridge declines to arm", async () => {
    const transport = new FakeTransport();
    let bridge: FakeBridge | null = null;
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
      createAmbientBridge: (hooks) => {
        bridge = new FakeBridge(hooks, /* arm */ false) as unknown as PendantAmbientBridge & FakeBridge;
        return bridge as unknown as PendantAmbientBridge;
      },
    });
    await conn.connect();
    await flush();
    expect(bridge!.started).toBe(true);

    // Bridge declined → batch VAD path runs: a stopped utterance hits the ASR.
    forceStop = false;
    transport.audioListener?.(new Uint8Array([1, 0, 0, 42]));
    forceStop = true;
    transport.audioListener?.(new Uint8Array([2, 0, 0, 43]));
    await flush();
    // The batch engine ran (bridge got no pushes).
    expect(bridge!.pushes.length).toBe(0);
    expect(asrCalls.n).toBe(1);
  });

  it("with NO ambient factory, the batch path is byte-for-byte unchanged", async () => {
    const transport = new FakeTransport();
    const { onState } = collectStates();
    const conn = new PendantConnection({ onState, createTransport: () => transport });
    await conn.connect();
    await flush();
    forceStop = false;
    transport.audioListener?.(new Uint8Array([1, 0, 0, 42]));
    forceStop = true;
    transport.audioListener?.(new Uint8Array([2, 0, 0, 43]));
    await flush();
    expect(asrCalls.n).toBe(1);
  });

  it("pause / resume forward to the ambient bridge control frames", async () => {
    const transport = new FakeTransport();
    let bridge: FakeBridge | null = null;
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
      createAmbientBridge: (hooks) => {
        bridge = new FakeBridge(hooks, true) as unknown as PendantAmbientBridge & FakeBridge;
        return bridge as unknown as PendantAmbientBridge;
      },
    });
    await conn.connect();
    await flush();
    conn.pause();
    expect(bridge!.paused).toBe(true);
    // Frames dropped while paused (no push).
    transport.audioListener?.(new Uint8Array([1, 0, 0, 42]));
    expect(bridge!.pushes.length).toBe(0);
    conn.resume();
    expect(bridge!.resumed).toBe(true);
    // 2 notifications post-resume → 1 emitted frame → 1 push.
    transport.audioListener?.(new Uint8Array([2, 0, 0, 43]));
    transport.audioListener?.(new Uint8Array([3, 0, 0, 44]));
    expect(bridge!.pushes.length).toBe(1);
  });

  it("a BLE drop tears down the ambient bridge (stop called)", async () => {
    const transport = new FakeTransport();
    let bridge: FakeBridge | null = null;
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
      createAmbientBridge: (hooks) => {
        bridge = new FakeBridge(hooks, true) as unknown as PendantAmbientBridge & FakeBridge;
        return bridge as unknown as PendantAmbientBridge;
      },
    });
    await conn.connect();
    await flush();
    // Simulate a remote BLE disconnect.
    transport.disconnectedHandler?.();
    await flush();
    expect(bridge!.stopped).toBe(true);
  });

  it("intentional disconnect tears down the ambient bridge", async () => {
    const transport = new FakeTransport();
    let bridge: FakeBridge | null = null;
    const { onState } = collectStates();
    const conn = new PendantConnection({
      onState,
      createTransport: () => transport,
      createAmbientBridge: (hooks) => {
        bridge = new FakeBridge(hooks, true) as unknown as PendantAmbientBridge & FakeBridge;
        return bridge as unknown as PendantAmbientBridge;
      },
    });
    await conn.connect();
    await flush();
    await conn.disconnect();
    expect(bridge!.stopped).toBe(true);
  });

  it("a bridge factory that throws degrades to the batch path (never fatal)", async () => {
    const transport = new FakeTransport();
    const states = collectStates();
    const conn = new PendantConnection({
      onState: states.onState,
      createTransport: () => transport,
      createAmbientBridge: () => {
        throw new Error("factory boom");
      },
    });
    await conn.connect();
    await flush();
    // Lands listening (not error) — the ambient failure degraded to batch.
    expect(states.states.at(-1)!.status).toBe("listening");
    forceStop = false;
    transport.audioListener?.(new Uint8Array([1, 0, 0, 42]));
    forceStop = true;
    transport.audioListener?.(new Uint8Array([2, 0, 0, 43]));
    await flush();
    expect(asrCalls.n).toBe(1);
  });
});
