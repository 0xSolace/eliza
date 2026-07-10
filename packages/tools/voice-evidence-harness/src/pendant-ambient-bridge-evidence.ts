/**
 * Pendant → ambient bridge EVIDENCE (offline, deterministic).
 *
 * Proves the pendant-ambient bridge path end-to-end at the seam it OWNS:
 *   recorded pendant-style PCM (the real turn_weather.wav @16k mono, i.e. the
 *   same audio a pendant would decode from its Opus stream)
 *     → PendantAmbientBridge.pushPcm (the REAL bridge: resample + Int16 framing)
 *     → the ambient WS uplink (captured by a fake WS transport)
 *   and, in reverse, a canonical server `stt_final`
 *     → the SAME PendantTranscriptSegmentDetail callback the batch path emits.
 *
 * Why offline: the LIVE-Deepgram half of this path (uplink PCM16 frames → Flux →
 * canonical pendant_sessions_v1 segments) is ALREADY proven by the ambient-mode
 * SERVER seat's evidence run (AMBIENT-SERVER-REPORT §5, real Deepgram Flux, 2
 * live utterances committed as segments 0/1). This bridge feeds the IDENTICAL
 * uplink contract (16k PCM16 mono, ~100ms Int16 frames) that seat verified live.
 * This script proves the CLIENT half the bridge is responsible for — the frame
 * math + the segment-callback mapping — against the REAL fixture and REAL bridge
 * code, with no mock of the thing under test (only the WS transport is a double).
 *
 * Run:  /tmp/bun-canary/bin/bun run src/pendant-ambient-bridge-evidence.ts
 * Artifacts (outside repo): ~/.moltbot/projects/eliza-fleet/evidence/pendant-ambient-bridge/<ts>/
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { parseWav } from "./wav.ts";

// The bridge is UI code; import it directly (dependency-light, pure logic).
import {
  PendantAmbientBridge,
  type AmbientWebSocketLike,
} from "../../../ui/src/pendant/pendant-ambient-bridge.ts";
import type { PendantTranscriptSegmentDetail } from "../../../ui/src/pendant/transcript-segment-event.ts";

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/src$/, "");
const FIXTURE = join(HARNESS_DIR, "fixtures/turn_weather.wav");
const OUT_ROOT = join(
  process.env.HOME ?? "/home/shad0w",
  ".moltbot/projects/eliza-fleet/evidence/pendant-ambient-bridge",
);

// ── Fake WS transport (captures the uplink) ──────────────────────────────

class CaptureWs implements AmbientWebSocketLike {
  binaryType = "blob";
  readonly controls: Array<Record<string, unknown>> = [];
  readonly uplinkFrames: Uint8Array[] = [];
  closed: { code?: number } | null = null;
  private openListeners: (() => void)[] = [];
  private messageListeners: ((e: { data: unknown }) => void)[] = [];
  private closeListeners: ((e: { code?: number }) => void)[] = [];
  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    if (typeof data === "string") {
      this.controls.push(JSON.parse(data));
    } else if (data instanceof ArrayBuffer) {
      this.uplinkFrames.push(new Uint8Array(data));
    }
  }
  close(code?: number): void {
    if (this.closed) return;
    this.closed = { code };
    for (const fn of this.closeListeners) fn({ code });
  }
  addEventListener(type: string, fn: (...a: never[]) => void): void {
    if (type === "open") this.openListeners.push(fn as () => void);
    else if (type === "message") this.messageListeners.push(fn as (e: { data: unknown }) => void);
    else if (type === "close") this.closeListeners.push(fn as (e: { code?: number }) => void);
  }
  emitOpen(): void {
    for (const fn of this.openListeners) fn();
  }
  emitMessage(data: unknown): void {
    for (const fn of this.messageListeners) fn({ data });
  }
}

// ── Assertions (fail = missing stage, never silently zero) ────────────────

interface Stage {
  name: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const stages: Stage[] = [];
  const record = (name: string, ok: boolean, detail: string) => {
    stages.push({ name, ok, detail });
    // eslint-disable-next-line no-console
    console.log(`[pendant-ambient-evidence] ${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };

  // 1. Load the REAL fixture and decode to Float32 (what the pendant decoder emits).
  const wav = parseWav(new Uint8Array(readFileSync(FIXTURE)));
  record(
    "fixture_loaded",
    wav.sampleRate === 16000 && wav.channels === 1,
    `turn_weather.wav ${wav.sampleRate}Hz ${wav.channels}ch ${wav.bitsPerSample}bit fmt=${wav.audioFormat} pcmBytes=${wav.pcm.length}`,
  );

  const totalSamples = wav.pcm.length / (wav.bitsPerSample / 8);
  const floatPcm = new Float32Array(totalSamples);
  const view = new DataView(wav.pcm.buffer, wav.pcm.byteOffset, wav.pcm.byteLength);
  if (wav.audioFormat === 1 && wav.bitsPerSample === 16) {
    for (let i = 0; i < totalSamples; i++) floatPcm[i] = view.getInt16(i * 2, true) / 0x8000;
  } else if (wav.audioFormat === 3 && wav.bitsPerSample === 32) {
    for (let i = 0; i < totalSamples; i++) floatPcm[i] = view.getFloat32(i * 4, true);
  } else {
    throw new Error(`unsupported fixture format ${wav.audioFormat}/${wav.bitsPerSample}`);
  }

  // 2. Drive the REAL bridge with a fake WS. Arm → hello → ready.
  const segments: PendantTranscriptSegmentDetail[] = [];
  const transcripts: string[] = [];
  let ws!: CaptureWs;
  const bridge = new PendantAmbientBridge({
    mint: async () => ({
      sessionId: "evidence-sess",
      wsUrl: "wss://evidence/ws",
      token: "evidence-token",
      expiresAt: Date.now() + 120_000,
      mode: "ambient",
      pendantSessionId: "pendant-evidence",
      captureLeaseToken: "evidence-lease",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      uplink: { codecs: ["pcm16"] },
      downlink: { codecs: [] },
      processingLocation: "cloud",
      iceServers: null,
    }),
    webSocketFactory: (url) => {
      ws = new CaptureWs();
      void url;
      return ws;
    },
    onSegment: (d) => segments.push(d),
    onTranscript: (t) => transcripts.push(t),
    now: () => 0,
  });

  const armedP = bridge.start();
  for (let i = 0; i < 50 && !ws; i++) await Promise.resolve();
  ws.emitOpen();
  ws.emitMessage(
    JSON.stringify({ t: "ready", sessionId: "evidence-sess", pendantSessionId: "pendant-evidence", traceId: "t0" }),
  );
  const armed = await armedP;
  record("bridge_armed_on_ready", armed && bridge.isReady, `start()=${armed} isReady=${bridge.isReady}`);

  const hello = ws.controls[0];
  record(
    "ambient_hello_first",
    hello?.t === "hello" && hello?.mode === "ambient" && hello?.uplinkCodec === "pcm16" && hello?.sampleRate === 16000,
    JSON.stringify(hello),
  );

  // 3. Stream the fixture as 10ms pendant-decode blocks (what the Opus decoder
  //    emits per frame) and confirm the bridge frames them into the ambient
  //    uplink contract (fixed 1600-sample = 3200-byte Int16 frames).
  const blockSize = 160; // 10ms @16k, the pendant Opus frame granularity.
  for (let off = 0; off < floatPcm.length; off += blockSize) {
    bridge.pushPcm(floatPcm.subarray(off, off + blockSize), 16000);
  }
  const allFramesFullSize = ws.uplinkFrames.every((f) => f.byteLength === 3200);
  const totalUplinkBytes = ws.uplinkFrames.reduce((n, f) => n + f.byteLength, 0);
  record(
    "uplink_framing",
    ws.uplinkFrames.length > 0 && allFramesFullSize,
    `frames=${ws.uplinkFrames.length} each=3200B(1600smp/16k/16bit) totalBytes=${totalUplinkBytes}`,
  );
  // The uplink samples should account for ~all fixture samples (minus a partial
  // trailing frame still buffered) — proves no audio is dropped in framing.
  const uplinkSamples = (totalUplinkBytes / 2);
  const accountedPct = (uplinkSamples / floatPcm.length) * 100;
  record(
    "no_audio_dropped_in_framing",
    accountedPct > 95,
    `${uplinkSamples}/${floatPcm.length} samples framed (${accountedPct.toFixed(1)}%, remainder is the sub-frame tail)`,
  );

  // 4. Reverse path: a canonical server stt_final maps to the SAME segment
  //    callback the batch path emits (canonical id, resolved text, one dispatch).
  ws.emitMessage(
    JSON.stringify({
      t: "stt_final",
      text: "what is the weather like in denver today",
      segmentId: "pendant-evidence:segment:0",
      ordinal: 0,
      revision: 1,
      traceId: "t1",
    }),
  );
  const resolved = segments.find((s) => s.status === "resolved");
  record(
    "server_segment_maps_to_pendant_callback",
    !!resolved && resolved.id === "pendant-evidence:segment:0" && transcripts.length === 1,
    `segmentId=${resolved?.id} text=${JSON.stringify(resolved?.text)} transcriptDispatches=${transcripts.length}`,
  );

  // 5. pause → control frame; BLE drop → clean close.
  bridge.pause();
  const pausedFrame = ws.controls.some((c) => c.t === "pause");
  record("pause_control_frame", pausedFrame && bridge.isPaused, `paused=${bridge.isPaused}`);
  bridge.handleTransportLoss();
  record("ble_drop_clean_close", ws.closed?.code === 1000, `closeCode=${ws.closed?.code}`);

  // ── Persist artifacts ──────────────────────────────────────────────────
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(OUT_ROOT, ts);
  mkdirSync(outDir, { recursive: true });
  const allPass = stages.every((s) => s.ok);
  const report = {
    scenario: "pendant-ambient-bridge (offline, real fixture + real bridge)",
    pass: allPass,
    fixture: { path: FIXTURE, sha256: sha256(readFileSync(FIXTURE)) },
    stages,
    uplink: {
      frameCount: ws.uplinkFrames.length,
      frameBytes: 3200,
      totalBytes: totalUplinkBytes,
      contract: "16kHz PCM16 mono, ~100ms Int16 frames — identical to the contract the ambient SERVER seat verified live with Deepgram Flux (AMBIENT-SERVER-REPORT §5)",
    },
    segments: segments.map((s) => ({ id: s.id, status: s.status, text: s.text })),
    transcripts,
    note: "The live-Deepgram uplink→segments half is proven by the ambient-server seat's real run; this proves the bridge's client-side framing + segment mapping against the real fixture and real bridge code.",
  };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2));
  // A raw dump of the first uplink frame for byte-level inspection.
  if (ws.uplinkFrames[0]) writeFileSync(join(outDir, "uplink-frame-0.pcm"), ws.uplinkFrames[0]);
  writeFileSync(
    join(outDir, "README.md"),
    `# Pendant → ambient bridge evidence\n\nGenerated ${ts}\n\nPASS=${allPass}\n\nSee report.json. Fixture: turn_weather.wav (real 16k PCM). uplink-frame-0.pcm is the first captured ambient uplink frame (3200 bytes = 1600 Int16 samples @16k).\n`,
  );

  // eslint-disable-next-line no-console
  console.log(`\n[pendant-ambient-evidence] ${allPass ? "ALL PASS" : "FAILURES PRESENT"} — artifacts: ${outDir}`);
  if (!allPass) process.exit(1);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("[pendant-ambient-evidence] ERROR", err);
  process.exit(1);
});
