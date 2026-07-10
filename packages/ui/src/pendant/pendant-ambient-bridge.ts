/**
 * Pendant → ambient always-listening bridge.
 *
 * The EXISTING pendant path (pendant-connection.ts) ingests via BATCH ASR: it
 * VAD-segments decoded PCM, encodes each utterance to WAV, and POSTs it to the
 * local ASR route per utterance. This bridge is the ALTERNATIVE ingest engine:
 * when the realtime ambient path is available (a `mode:"ambient"` mint succeeds
 * and consent is present), decoded pendant PCM frames stream continuously to the
 * ambient WebSocket uplink and the SERVER (Deepgram Flux) does the segmentation.
 * The canonical `pendant_sessions_v1` segments the server commits come back as
 * `stt_final` / `segment_committed` events, which this bridge maps onto the SAME
 * {@link PendantTranscriptSegmentDetail} callbacks the batch path already emits.
 *
 * That is the whole point: SAME UI (the /pendant/transcript view + insights),
 * BETTER engine (continuous cloud STT instead of per-utterance batch WAV posts).
 *
 * Non-regression law (from the UI seat): this bridge is ADDITIVE. It only runs
 * when {@link PendantAmbientBridgeConfig.mint} resolves a usable ambient mint.
 * When the flag is off / the mint 404s / consent is missing, the caller keeps
 * the batch path completely unchanged (pendant-connection.ts routes frames to
 * the VAD/ASR path exactly as before). Frames NEVER go to BOTH paths — the
 * connection asks the bridge to claim ingestion, and only one owns the frames.
 *
 * Transport is injected (mint fetch + WebSocket factory) so tests drive the REAL
 * framing / resample / segment-mapping / pause / BLE-drop / lease code through
 * fakes-as-transport, not stubs of the bridge itself.
 */

import { logger } from "@elizaos/core";

import {
  buildAmbientHello,
  encodeAmbientClientControl,
  isUsableAmbientMintResponse,
  parseAmbientServerFrame,
  type AmbientMintResponse,
  type AmbientServerFrame,
} from "../voice/ambient-uplink-protocol";
import { floatPcmToInt16Bytes } from "../voice/voice-session-pcm";
import { OMI_OPUS_SAMPLE_RATE_HZ } from "./omi-protocol";
import type { PendantTranscriptSegmentDetail } from "./transcript-segment-event";

/** The ambient session's fixed uplink contract: 16 kHz PCM16 mono. */
export const AMBIENT_UPLINK_SAMPLE_RATE_HZ = 16_000 as const;

/** ~100 ms of 16 kHz mono samples per uplink frame (matches the mic-capture default). */
const UPLINK_FRAME_SAMPLES = (AMBIENT_UPLINK_SAMPLE_RATE_HZ / 1000) * 100; // 1600

/** Minimal WebSocket surface the bridge drives (native or fake). */
export interface AmbientWebSocketLike {
  binaryType: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: "error", listener: () => void): void;
}

export type AmbientWebSocketFactory = (url: string) => AmbientWebSocketLike;

/**
 * Why a session ended, surfaced to the caller so pendant state can react (e.g.
 * a `mint_unavailable`/`mint_failed`/`hello_rejected` at start means the caller
 * should fall back to the batch path for this connection).
 */
export type AmbientBridgeEndReason =
  | "bye" // clean client-side stop
  | "server_close" // socket closed by server / network (post-ready)
  | "server_error" // server sent a fatal (non-retryable) error event
  | "mint_unavailable" // mint returned 404 (feature off) — fall back to batch
  | "mint_failed" // mint failed for another reason — fall back to batch
  | "hello_rejected"; // server rejected the ambient hello — fall back to batch

export interface PendantAmbientBridgeConfig {
  /**
   * Mint an ambient voice session. Resolves the ambient mint response, or throws
   * {@link AmbientMintUnavailableError} (404 = feature off → batch fallback) or
   * any other error (→ batch fallback). MUST have consent already gathered (the
   * server enforces consent-before-mint; the caller supplies the nonce inside
   * this closure). Returning a non-ambient/malformed response is treated as a
   * mint failure.
   */
  mint: () => Promise<AmbientMintResponse>;
  /** Injectable WebSocket factory (tests / non-standard hosts). */
  webSocketFactory: AmbientWebSocketFactory;

  /**
   * Emit a transcript segment lifecycle update — the SAME callback the batch
   * path drives so the /pendant/transcript UI + insights are engine-agnostic.
   */
  onSegment: (detail: PendantTranscriptSegmentDetail) => void;
  /**
   * Fired when the server commits a FINAL resolved segment, carrying the plain
   * text — the caller routes this to the spoken VOICE_DM path exactly as the
   * batch `onTranscript` does. (Kept separate from onSegment so the caller's
   * commit/dispatch logic is identical across engines.)
   */
  onTranscript?: (text: string) => void;

  /** Fired when the ambient session ends (any reason). */
  onEnd?: (reason: AmbientBridgeEndReason) => void;
  /** Fired once the server `ready` event arrives — the bridge is live. */
  onReady?: () => void;

  /** Monotonic clock (tests inject). */
  now?: () => number;
}

/** A mint failure the bridge/caller branches on (404 = feature off → batch). */
export class AmbientMintUnavailableError extends Error {
  constructor(readonly status: number, message?: string) {
    super(message ?? `ambient mint unavailable (${status})`);
    this.name = "AmbientMintUnavailableError";
  }

  /** True when the realtime feature is off; the caller should use batch. */
  get isFeatureDisabled(): boolean {
    return this.status === 404;
  }
}

type BridgePhase =
  | "idle"
  | "connecting"
  | "hello-sent"
  | "ready"
  | "closing"
  | "closed";

/**
 * A live pendant→ambient bridge. Construct + {@link PendantAmbientBridge.start};
 * feed decoded PCM via {@link PendantAmbientBridge.pushPcm}; call
 * {@link PendantAmbientBridge.pause}/{@link PendantAmbientBridge.resume} for the
 * pendant pause control, and {@link PendantAmbientBridge.stop} to end cleanly.
 * {@link PendantAmbientBridge.handleTransportLoss} maps a BLE drop onto a clean
 * session end.
 */
export class PendantAmbientBridge {
  private phase: BridgePhase = "idle";
  private ws: AmbientWebSocketLike | null = null;
  private minted: AmbientMintResponse | null = null;
  private paused = false;
  private ended = false;

  /** Fractional read position carried across frames for continuous resampling. */
  private resamplePosition = 0;
  private resampleTail = 0;
  private resampleHasTail = false;

  /** Accumulated resampled 16 kHz samples awaiting a full uplink frame cut. */
  private pending: Float32Array = new Float32Array(0);

  private readonly now: () => number;

  constructor(private readonly config: PendantAmbientBridgeConfig) {
    this.now = config.now ?? nowDefault;
  }

  /** True once the server `ready` arrived and audio may stream. */
  get isReady(): boolean {
    return this.phase === "ready";
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * Mint + connect. Resolves TRUE if the ambient session armed (mint ok + WS
   * opening); resolves FALSE if the ambient path is unavailable and the caller
   * must fall back to batch. Never throws — a mint/transport failure is
   * translated into a FALSE result + an `onEnd(mint_*)` so the caller can pick
   * the batch path deterministically.
   */
  async start(): Promise<boolean> {
    if (this.phase !== "idle") return this.phase === "ready" || this.phase === "connecting";
    this.phase = "connecting";
    let minted: AmbientMintResponse;
    try {
      minted = await this.config.mint();
    } catch (error) {
      if (error instanceof AmbientMintUnavailableError) {
        this.finish("mint_unavailable");
        return false;
      }
      logger.warn({ error }, "[PendantAmbientBridge] ambient mint failed");
      this.finish("mint_failed");
      return false;
    }
    if (!isUsableAmbientMintResponse(minted)) {
      logger.warn("[PendantAmbientBridge] malformed ambient mint response");
      this.finish("mint_failed");
      return false;
    }
    this.minted = minted;

    let socket: AmbientWebSocketLike;
    try {
      socket = this.config.webSocketFactory(minted.wsUrl);
    } catch (error) {
      logger.warn({ error }, "[PendantAmbientBridge] WS construction failed");
      this.finish("mint_failed");
      return false;
    }
    socket.binaryType = "arraybuffer";
    this.ws = socket;

    socket.addEventListener("open", () => {
      if (this.ended || !this.ws) return;
      // FIRST frame MUST be the ambient hello carrying the token + lease.
      this.sendControl(encodeAmbientClientControl(buildAmbientHello(minted)));
      this.phase = "hello-sent";
    });
    socket.addEventListener("message", (event) => {
      this.handleServerFrame(event.data);
    });
    socket.addEventListener("close", (event) => {
      if (this.ended) return;
      // A clean close (1000) before ready = the server rejected the hello
      // (e.g. lease/mode/claim failure) → the caller falls back to batch. A
      // non-clean or post-ready close is a transport/server end.
      if (this.phase === "hello-sent" || this.phase === "connecting") {
        this.finish("hello_rejected");
        return;
      }
      const clean = event.code === 1000;
      this.finish(clean ? "server_close" : "server_close");
    });
    socket.addEventListener("error", () => {
      logger.debug("[PendantAmbientBridge] ambient WS error");
      // The close handler follows and drives the end; nothing to do here.
    });
    return true;
  }

  /**
   * Feed one decoded pendant PCM block (Float32, mono) at its native codec rate.
   * Resamples to 16 kHz if needed, frames to fixed 100 ms Int16 LE chunks, and
   * streams them to the ambient uplink. Dropped while paused or not-ready (no
   * audio is ingested/metered while paused — matches the server pause guarantee).
   */
  pushPcm(pcm: Float32Array, sourceRateHz: number = OMI_OPUS_SAMPLE_RATE_HZ): void {
    if (this.phase !== "ready" || this.paused || this.ended) return;
    if (pcm.length === 0) return;
    const resampled = this.resample(pcm, sourceRateHz);
    if (resampled.length === 0) return;
    // Append to the pending accumulator, then cut fixed-size frames.
    const merged = new Float32Array(this.pending.length + resampled.length);
    merged.set(this.pending, 0);
    merged.set(resampled, this.pending.length);
    let offset = 0;
    while (merged.length - offset >= UPLINK_FRAME_SAMPLES) {
      const frame = merged.subarray(offset, offset + UPLINK_FRAME_SAMPLES);
      this.sendUplink(floatPcmToInt16Bytes(frame));
      offset += UPLINK_FRAME_SAMPLES;
    }
    this.pending =
      offset < merged.length ? merged.slice(offset) : new Float32Array(0);
  }

  /** Pause ambient capture — severs Flux server-side via the pause control frame. */
  pause(): void {
    if (this.paused || this.ended) return;
    this.paused = true;
    // Drop any partial pending frame so resume starts on a clean boundary.
    this.pending = new Float32Array(0);
    this.sendControl(encodeAmbientClientControl({ t: "pause" }));
  }

  /** Resume ambient capture — reopens Flux server-side via the resume control frame. */
  resume(): void {
    if (!this.paused || this.ended) return;
    this.paused = false;
    this.sendControl(encodeAmbientClientControl({ t: "resume" }));
  }

  /** Renew the capture lease over the socket (server holds the current token). */
  renewLease(): void {
    if (this.phase !== "ready" || this.ended) return;
    this.sendControl(encodeAmbientClientControl({ t: "lease_renew" }));
  }

  /**
   * A BLE drop / pendant loss ends the ambient session cleanly. Ambient sessions
   * are resumable at the SERVER (a fresh mint with the same pendantSessionId
   * rebinds), but the transport for THIS session is gone, so we tear it down and
   * let the pendant's own reconnect logic re-arm a new bridge on reconnect.
   */
  handleTransportLoss(): void {
    if (this.ended) return;
    this.finish("server_close");
  }

  /** Send a clean `bye` and tear down. */
  stop(): void {
    if (this.ended) return;
    if (this.ws && (this.phase === "ready" || this.phase === "hello-sent")) {
      this.sendControl(encodeAmbientClientControl({ t: "bye" }));
    }
    this.finish("bye");
  }

  // ── internals ──────────────────────────────────────────────────────────

  private handleServerFrame(data: unknown): void {
    // Ambient has NO downlink audio — a binary frame is a contract violation we
    // ignore (never route it anywhere, there is no playback sink in ambient).
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      logger.debug("[PendantAmbientBridge] unexpected binary frame in ambient");
      return;
    }
    const raw = typeof data === "string" ? data : null;
    if (raw === null) return;
    const event = parseAmbientServerFrame(raw);
    if (!event) return; // a single bad frame must not kill the session.
    this.applyServerEvent(event);
  }

  private applyServerEvent(event: AmbientServerFrame): void {
    switch (event.t) {
      case "ready":
        this.phase = "ready";
        this.config.onReady?.();
        break;
      case "stt_partial":
        // Interim text → a pending segment row keyed by the (not-yet-final)
        // partial. We emit an interim pending detail so the transcript view can
        // show live text; the canonical id lands on stt_final.
        this.emitInterim(event.text);
        break;
      case "stt_final":
        this.emitFinal(event);
        break;
      case "segment_committed":
        // The store confirmed the canonical commit. The resolved detail was
        // already emitted on stt_final (which carries the same canonical id);
        // this is the durability ack — no additional UI row needed.
        break;
      case "paused":
        // Server confirmed the pause (Flux severed). Local `paused` already set.
        break;
      case "resumed":
        break;
      case "lease_renewed":
        break;
      case "insight":
        // Insights are consumed by the existing PendantInsightsScheduler off the
        // committed segments — no bridge action.
        break;
      case "usage":
        break;
      case "error":
        if (!event.retryable) {
          logger.warn(
            { code: event.code },
            "[PendantAmbientBridge] fatal ambient server error",
          );
          this.finish("server_error");
        }
        break;
    }
  }

  /**
   * Emit an interim (pending) segment for live partial text. Uses a stable
   * per-utterance id so successive partials update the SAME row until the final
   * lands with the canonical id. We derive nothing fake: the id is the pending
   * marker, replaced by the canonical id on stt_final.
   */
  private lastPartialText = "";
  private emitInterim(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || trimmed === this.lastPartialText) return;
    this.lastPartialText = trimmed;
    const at = this.now();
    this.config.onSegment({
      id: `pendant-ambient-partial`,
      status: "pending",
      text: trimmed,
      startedAt: at,
      endedAt: at,
      durationMs: 0,
    });
  }

  private emitFinal(event: {
    text: string;
    segmentId: string;
    ordinal: number;
    revision: number;
  }): void {
    this.lastPartialText = "";
    const text = event.text.trim();
    const at = this.now();
    const detail: PendantTranscriptSegmentDetail = {
      // Canonical server id (pendant_sessions_v1 <sessionId>:segment:<ordinal>)
      // is the stable id — the same id the durable store persisted.
      id: event.segmentId,
      status: text ? "resolved" : "discarded",
      startedAt: at,
      endedAt: at,
      durationMs: 0,
    };
    if (text) {
      detail.text = text;
    } else {
      detail.discardReason = "silence";
    }
    this.config.onSegment(detail);
    if (text) this.config.onTranscript?.(text);
  }

  private sendControl(payload: string): void {
    if (!this.ws || this.ended) return;
    try {
      this.ws.send(payload);
    } catch {
      // socket closing; the close handler drives teardown.
    }
  }

  private sendUplink(bytes: Uint8Array): void {
    if (!this.ws || this.phase !== "ready" || this.ended) return;
    try {
      // Copy into a standalone ArrayBuffer so a shared/pooled backing store from
      // the decode path is never observed mutated after send.
      this.ws.send(bytes.slice().buffer);
    } catch {
      // dropped; the close handler handles a dead socket.
    }
  }

  private finish(reason: AmbientBridgeEndReason): void {
    if (this.ended) return;
    this.ended = true;
    this.phase = "closed";
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      try {
        socket.close(1000, "ambient bridge end");
      } catch {
        /* already closing */
      }
    }
    this.pending = new Float32Array(0);
    this.config.onEnd?.(reason);
  }

  /**
   * A streaming linear resampler (sourceRate → 16 kHz), carried across frames so
   * the fractional read position is continuous (no per-frame boundary glitch).
   * Identical math to the mic-capture resampler; kept local so the bridge has no
   * dependency on the mic-capture module's private class. A no-op when the source
   * is already 16 kHz (the Opus/PCM_16K pendant codecs — the common case).
   */
  private resample(block: Float32Array, sourceRate: number): Float32Array {
    if (sourceRate === AMBIENT_UPLINK_SAMPLE_RATE_HZ) return block;
    if (block.length === 0) return block;
    const ratio = sourceRate / AMBIENT_UPLINK_SAMPLE_RATE_HZ;
    const out: number[] = [];
    while (this.resamplePosition < block.length) {
      const idx = this.resamplePosition;
      const i0 = Math.floor(idx);
      const frac = idx - i0;
      const s0 = i0 < 0 ? (this.resampleHasTail ? this.resampleTail : block[0]) : block[i0];
      const s1 =
        i0 + 1 < block.length ? block[i0 + 1] : block[block.length - 1];
      out.push(s0 + (s1 - s0) * frac);
      this.resamplePosition += ratio;
    }
    this.resampleTail = block[block.length - 1];
    this.resampleHasTail = true;
    this.resamplePosition -= block.length;
    return Float32Array.from(out);
  }
}

function nowDefault(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/**
 * Map an omi codec id to its native decoded PCM sample rate, so the bridge knows
 * whether to resample. OPUS_16K / PCM_16K decode to 16 kHz (no resample);
 * PCM_8K / MU_LAW_8K decode to 8 kHz (resample up to the 16 kHz uplink).
 */
export function pendantCodecSampleRateHz(codecId: number | null): number {
  switch (codecId) {
    case 0: // PCM_8K
    case 10: // MU_LAW_8K
      return 8_000;
    case 1: // PCM_16K
    case 20: // OPUS_16K
    default:
      return OMI_OPUS_SAMPLE_RATE_HZ; // 16 kHz
  }
}
