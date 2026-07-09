/**
 * omi DevKit1 BLE audio protocol constants and frame reassembly.
 *
 * The firmware sends a three-byte header before every audio payload. Bytes 0
 * and 1 are a uint16 little-endian packet id. Byte 2 is a 0-based chunk index
 * within the encoded audio frame and resets to 0 for the next frame.
 *
 * Historical upstream firmware increments the packet id on every BLE
 * notification. Older app code treated the packet id as a frame id that stayed
 * constant across continuation chunks. The reassembler supports both wire
 * contracts and only locks onto a mode after a continuation chunk proves it.
 */

/** omi audio GATT service. Also the Web Bluetooth `filters`/`optionalServices` id. */
export const OMI_AUDIO_SERVICE_UUID = "19b10000-e8f2-537e-4f6c-d104768a1214";
/** Audio data characteristic: subscribe for `notify`. */
export const OMI_AUDIO_DATA_CHAR_UUID = "19b10001-e8f2-537e-4f6c-d104768a1214";
/** Codec-type characteristic: `read` returns one byte (`CODEC_ID`). */
export const OMI_AUDIO_CODEC_CHAR_UUID = "19b10002-e8f2-537e-4f6c-d104768a1214";

/**
 * Standard Bluetooth Battery Service (0x180F) + Battery Level (0x2A19).
 *
 * Web Bluetooth accepts the SIG short names; the Capacitor plugin
 * (`@capacitor-community/bluetooth-le`) requires FULL 128-bit UUIDs, so we keep
 * both forms. The 128-bit forms are the SIG base UUID with the 16-bit id in the
 * high word (`0000XXXX-0000-1000-8000-00805f9b34fb`).
 */
export const BATTERY_SERVICE_UUID = "battery_service"; // 0x180F short name
export const BATTERY_LEVEL_CHAR_UUID = "battery_level"; // 0x2A19 short name
/** Full 128-bit Battery Service UUID (0x180F) for the native BLE plugin. */
export const BATTERY_SERVICE_UUID_128 = "0000180f-0000-1000-8000-00805f9b34fb";
/** Full 128-bit Battery Level char UUID (0x2A19) for the native BLE plugin. */
export const BATTERY_LEVEL_CHAR_UUID_128 =
  "00002a19-0000-1000-8000-00805f9b34fb";

/** Codec ids the firmware may report from the codec characteristic. */
export const OMI_CODEC = {
  /** PCM 8 kHz 16-bit. */
  PCM_8K: 0,
  /** PCM 16 kHz 16-bit. */
  PCM_16K: 1,
  /** PCM 8 kHz 8-bit µ-law. */
  MU_LAW_8K: 10,
  /** Opus 16 kHz mono (the DK1 default, `CODEC_ID = 20`). */
  OPUS_16K: 20,
} as const;

export type OmiCodecId = (typeof OMI_CODEC)[keyof typeof OMI_CODEC];

/** Firmware Opus parameters (codec.c) that the decoder must match. */
export const OMI_OPUS_SAMPLE_RATE_HZ = 16000 as const;
export const OMI_OPUS_CHANNELS = 1 as const;
/** 160 samples @ 16 kHz = 10 ms. Used only for latency accounting. */
export const OMI_OPUS_FRAME_SAMPLES = 160 as const;

/** `NET_BUFFER_HEADER_SIZE`, the 3-byte packet/frame index prefix. */
export const OMI_PACKET_HEADER_SIZE = 3 as const;

/** Device advertising name prefixes we accept (currently "Friend", soon "eliza"). */
export const OMI_NAME_PREFIXES = ["Friend", "Omi", "eliza"] as const;

export interface ReassembledFrame {
  /** The complete Opus (or raw PCM) frame payload, header stripped. */
  readonly data: Uint8Array;
  /** Monotonic packet or frame id associated with the first chunk. */
  readonly packetIndex: number;
  /** Number of missing packet ids observed before this frame. */
  readonly droppedBefore: number;
}

export type OmiWireMode = "unknown" | "notification-sequence" | "frame-id";

export type OmiFrameDiagnosticCode =
  | "duplicate-notification"
  | "malformed-notification"
  | "missing-notification"
  | "missing-chunk"
  | "out-of-order"
  | "unexpected-continuation"
  | "mode-conflict"
  | "ambiguous-tail"
  | "dropped-buffered-frame";

export interface OmiFrameDiagnostic {
  readonly code: OmiFrameDiagnosticCode;
  readonly packetIndex: number | null;
  readonly chunkIndex: number | null;
  readonly detail: string;
  readonly count?: number;
}

export interface OmiFrameMetricsSnapshot {
  readonly notificationCount: number;
  readonly notificationBytes: number;
  readonly emittedFrames: number;
  readonly droppedFrames: number;
  readonly malformedNotifications: number;
  readonly duplicates: number;
  readonly missingNotifications: number;
  readonly missingChunks: number;
  readonly outOfOrder: number;
  readonly detectedWireMode: OmiWireMode;
  readonly cadenceMeanMs: number | null;
  readonly cadenceP95Ms: number | null;
}

export interface OmiFrameReassemblerResult {
  readonly frames: ReassembledFrame[];
  readonly diagnostics: OmiFrameDiagnostic[];
  readonly metrics: OmiFrameMetricsSnapshot;
}

interface BufferedFrame {
  readonly startRawIndex: number;
  readonly startUnwrappedIndex: number;
  readonly droppedBefore: number;
  readonly chunks: Uint8Array[];
  expectedChunkIndex: number;
  lastRawIndex: number;
  lastUnwrappedIndex: number;
}

interface MutableOmiFrameMetrics {
  notificationCount: number;
  notificationBytes: number;
  emittedFrames: number;
  droppedFrames: number;
  malformedNotifications: number;
  duplicates: number;
  missingNotifications: number;
  missingChunks: number;
  outOfOrder: number;
}

const UINT16_MODULUS = 0x10000;
const UINT16_HALF_RANGE = 0x8000;
const MAX_CADENCE_SAMPLES = 512;

/**
 * Stateful reassembler for the omi 3-byte-headed notification stream.
 *
 * Feed it raw notifications in arrival order. It emits complete frames only
 * when the buffered chunk sequence is still valid under the detected wire mode.
 */
export class OmiFrameReassembler {
  private mode: OmiWireMode = "unknown";
  private buffer: BufferedFrame | null = null;
  private lastRawIndex: number | null = null;
  private lastUnwrappedIndex: number | null = null;
  private lastNotification: Uint8Array | null = null;
  private lastReceivedAtMs: number | null = null;
  private readonly cadenceIntervalsMs: number[] = [];
  private readonly metrics: MutableOmiFrameMetrics = {
    notificationCount: 0,
    notificationBytes: 0,
    emittedFrames: 0,
    droppedFrames: 0,
    malformedNotifications: 0,
    duplicates: 0,
    missingNotifications: 0,
    missingChunks: 0,
    outOfOrder: 0,
  };

  /** Reset all state (call on (re)connect). */
  reset(): void {
    this.mode = "unknown";
    this.buffer = null;
    this.lastRawIndex = null;
    this.lastUnwrappedIndex = null;
    this.lastNotification = null;
    this.lastReceivedAtMs = null;
    this.cadenceIntervalsMs.length = 0;
    this.metrics.notificationCount = 0;
    this.metrics.notificationBytes = 0;
    this.metrics.emittedFrames = 0;
    this.metrics.droppedFrames = 0;
    this.metrics.malformedNotifications = 0;
    this.metrics.duplicates = 0;
    this.metrics.missingNotifications = 0;
    this.metrics.missingChunks = 0;
    this.metrics.outOfOrder = 0;
  }

  getMetricsSnapshot(): OmiFrameMetricsSnapshot {
    return this.snapshot();
  }

  private unwrap(raw: number, previous: number | null): number {
    if (previous === null) return raw;
    const prevRaw = previous & 0xffff;
    let delta = raw - prevRaw;
    if (delta < -UINT16_HALF_RANGE) delta += UINT16_MODULUS;
    else if (delta > UINT16_HALF_RANGE) delta -= UINT16_MODULUS;
    return previous + delta;
  }

  /**
   * Push one BLE notification. Returns complete frames and packet diagnostics.
   */
  push(
    notification: Uint8Array,
    receivedAtMs = this.defaultReceivedAtMs(),
  ): OmiFrameReassemblerResult {
    const diagnostics: OmiFrameDiagnostic[] = [];
    const frames: ReassembledFrame[] = [];
    this.recordNotification(notification, receivedAtMs);

    if (this.isExactDuplicate(notification)) {
      this.metrics.duplicates += 1;
      diagnostics.push({
        code: "duplicate-notification",
        packetIndex: this.lastRawIndex,
        chunkIndex: notification.length > 2 ? notification[2] : null,
        detail: "Exact duplicate notification ignored.",
      });
      return this.result(frames, diagnostics);
    }

    if (notification.length <= OMI_PACKET_HEADER_SIZE) {
      const packetIndex =
        notification.length >= 2
          ? notification[0] | (notification[1] << 8)
          : null;
      const chunkIndex = notification.length >= 3 ? notification[2] : null;
      this.metrics.malformedNotifications += 1;
      if (this.buffer) {
        this.dropBuffered(
          diagnostics,
          packetIndex,
          chunkIndex,
          "dropped-buffered-frame",
          "Buffered frame dropped because a malformed notification interrupted it.",
        );
      }
      diagnostics.push({
        code: "malformed-notification",
        packetIndex,
        chunkIndex,
        detail: "Notification is missing an audio payload.",
      });
      this.lastNotification = new Uint8Array(notification);
      return this.result(frames, diagnostics);
    }

    const rawIndex = notification[0] | (notification[1] << 8);
    const chunkIndex = notification[2];
    const payload = notification.subarray(OMI_PACKET_HEADER_SIZE);
    const unwrappedIndex = this.unwrap(rawIndex, this.lastUnwrappedIndex);

    if (
      this.lastUnwrappedIndex !== null &&
      unwrappedIndex < this.lastUnwrappedIndex
    ) {
      this.dropBuffered(diagnostics, rawIndex, chunkIndex, "out-of-order");
      this.metrics.outOfOrder += 1;
      diagnostics.push({
        code: "out-of-order",
        packetIndex: rawIndex,
        chunkIndex,
        detail: "Packet id moved backwards in arrival order.",
      });
      this.lastNotification = new Uint8Array(notification);
      return this.result(frames, diagnostics);
    }

    if (chunkIndex === 0) {
      frames.push(
        ...this.handleFrameStart(
          rawIndex,
          unwrappedIndex,
          payload,
          diagnostics,
        ),
      );
      this.acceptNotification(rawIndex, unwrappedIndex, notification);
      this.metrics.emittedFrames += frames.length;
      return this.result(frames, diagnostics);
    }

    this.handleContinuation(
      rawIndex,
      unwrappedIndex,
      chunkIndex,
      payload,
      diagnostics,
    );
    this.acceptNotification(rawIndex, unwrappedIndex, notification);
    return this.result(frames, diagnostics);
  }

  /**
   * End the stream without emitting an unconfirmed tail frame.
   *
   * The wire header has no payload length or end marker. Only the next chunk-0
   * notification proves that the buffered frame was complete, so disconnecting
   * before that boundary is ambiguous and must drop the tail.
   */
  flush(): OmiFrameReassemblerResult {
    const diagnostics: OmiFrameDiagnostic[] = [];
    if (this.buffer) {
      this.dropBuffered(
        diagnostics,
        this.buffer.startRawIndex,
        this.buffer.expectedChunkIndex - 1,
        "ambiguous-tail",
        "Unconfirmed tail frame dropped because the stream ended before its next frame boundary.",
      );
    }
    return this.result([], diagnostics);
  }

  private handleFrameStart(
    rawIndex: number,
    unwrappedIndex: number,
    payload: Uint8Array,
    diagnostics: OmiFrameDiagnostic[],
  ): ReassembledFrame[] {
    const frames: ReassembledFrame[] = [];
    if (!this.buffer) {
      const droppedBefore = this.recordStartGap(
        unwrappedIndex,
        rawIndex,
        diagnostics,
      );
      this.startBuffer(rawIndex, unwrappedIndex, payload, droppedBefore);
      return frames;
    }

    const deltaFromLastChunk = unwrappedIndex - this.buffer.lastUnwrappedIndex;
    const deltaFromFrameStart =
      unwrappedIndex - this.buffer.startUnwrappedIndex;
    const canCloseSequence =
      this.mode !== "frame-id" && deltaFromLastChunk === 1;
    const canCloseFrameId =
      this.mode === "frame-id" && deltaFromFrameStart === 1;

    if (canCloseSequence || canCloseFrameId) {
      frames.push(this.emitBuffered());
      this.startBuffer(rawIndex, unwrappedIndex, payload);
      return frames;
    }

    const gap =
      this.mode === "frame-id"
        ? Math.max(0, deltaFromFrameStart - 1)
        : Math.max(0, deltaFromLastChunk - 1);
    if (gap > 0) {
      this.recordMissingNotifications(gap, rawIndex, 0, diagnostics);
      this.dropBuffered(
        diagnostics,
        rawIndex,
        0,
        "dropped-buffered-frame",
        "Buffered frame dropped because a missing notification may have been its continuation.",
      );
      this.startBuffer(rawIndex, unwrappedIndex, payload, gap);
      return frames;
    }

    this.dropBuffered(diagnostics, rawIndex, 0, "out-of-order");
    this.metrics.outOfOrder += 1;
    diagnostics.push({
      code: "out-of-order",
      packetIndex: rawIndex,
      chunkIndex: 0,
      detail: "Chunk 0 arrived without advancing the packet or frame id.",
    });
    return frames;
  }

  private handleContinuation(
    rawIndex: number,
    unwrappedIndex: number,
    chunkIndex: number,
    payload: Uint8Array,
    diagnostics: OmiFrameDiagnostic[],
  ): void {
    if (!this.buffer) {
      this.metrics.missingChunks += chunkIndex;
      diagnostics.push({
        code: "unexpected-continuation",
        packetIndex: rawIndex,
        chunkIndex,
        detail: "Continuation arrived without an open chunk-0 frame.",
      });
      return;
    }

    if (chunkIndex !== this.buffer.expectedChunkIndex) {
      if (chunkIndex > this.buffer.expectedChunkIndex) {
        const missing = chunkIndex - this.buffer.expectedChunkIndex;
        this.metrics.missingChunks += missing;
        diagnostics.push({
          code: "missing-chunk",
          packetIndex: rawIndex,
          chunkIndex,
          count: missing,
          detail: "Chunk index skipped within the buffered frame.",
        });
      } else {
        this.metrics.outOfOrder += 1;
        diagnostics.push({
          code: "out-of-order",
          packetIndex: rawIndex,
          chunkIndex,
          detail: "Chunk index moved backwards within the buffered frame.",
        });
      }
      this.dropBuffered(
        diagnostics,
        rawIndex,
        chunkIndex,
        "dropped-buffered-frame",
      );
      return;
    }

    const sameFrameId = rawIndex === this.buffer.startRawIndex;
    const nextNotification =
      unwrappedIndex - this.buffer.lastUnwrappedIndex === 1;

    if (sameFrameId && this.mode === "notification-sequence") {
      this.modeConflict(rawIndex, chunkIndex, diagnostics);
      return;
    }

    if (nextNotification && this.mode === "frame-id") {
      this.modeConflict(rawIndex, chunkIndex, diagnostics);
      return;
    }

    if (sameFrameId) {
      if (this.mode === "unknown") this.mode = "frame-id";
      this.appendChunk(rawIndex, unwrappedIndex, payload);
      return;
    }

    if (nextNotification) {
      if (this.mode === "unknown") this.mode = "notification-sequence";
      this.appendChunk(rawIndex, unwrappedIndex, payload);
      return;
    }

    const gap = Math.max(
      0,
      unwrappedIndex - this.buffer.lastUnwrappedIndex - 1,
    );
    if (gap > 0) {
      this.recordMissingNotifications(gap, rawIndex, chunkIndex, diagnostics);
    }
    this.dropBuffered(
      diagnostics,
      rawIndex,
      chunkIndex,
      "dropped-buffered-frame",
    );
  }

  private startBuffer(
    rawIndex: number,
    unwrappedIndex: number,
    payload: Uint8Array,
    droppedBefore = 0,
  ): void {
    this.buffer = {
      startRawIndex: rawIndex,
      startUnwrappedIndex: unwrappedIndex,
      droppedBefore,
      chunks: [payload],
      expectedChunkIndex: 1,
      lastRawIndex: rawIndex,
      lastUnwrappedIndex: unwrappedIndex,
    };
  }

  private appendChunk(
    rawIndex: number,
    unwrappedIndex: number,
    payload: Uint8Array,
  ): void {
    if (!this.buffer) return;
    this.buffer.chunks.push(payload);
    this.buffer.expectedChunkIndex += 1;
    this.buffer.lastRawIndex = rawIndex;
    this.buffer.lastUnwrappedIndex = unwrappedIndex;
  }

  private emitBuffered(): ReassembledFrame {
    if (!this.buffer) {
      throw new Error("Cannot emit without a buffered frame.");
    }
    const total = this.buffer.chunks.reduce((n, c) => n + c.length, 0);
    const data = new Uint8Array(total);
    let off = 0;
    for (const c of this.buffer.chunks) {
      data.set(c, off);
      off += c.length;
    }
    return {
      data,
      packetIndex: this.buffer.startUnwrappedIndex,
      droppedBefore: this.buffer.droppedBefore,
    };
  }

  private recordNotification(
    notification: Uint8Array,
    receivedAtMs: number,
  ): void {
    this.metrics.notificationCount += 1;
    this.metrics.notificationBytes += notification.length;
    if (
      this.lastReceivedAtMs !== null &&
      receivedAtMs >= this.lastReceivedAtMs
    ) {
      this.cadenceIntervalsMs.push(receivedAtMs - this.lastReceivedAtMs);
      if (this.cadenceIntervalsMs.length > MAX_CADENCE_SAMPLES) {
        this.cadenceIntervalsMs.shift();
      }
    }
    this.lastReceivedAtMs = receivedAtMs;
  }

  private acceptNotification(
    rawIndex: number,
    unwrappedIndex: number,
    notification: Uint8Array,
  ): void {
    this.lastRawIndex = rawIndex;
    this.lastUnwrappedIndex = unwrappedIndex;
    this.lastNotification = new Uint8Array(notification);
  }

  private isExactDuplicate(notification: Uint8Array): boolean {
    if (!this.lastNotification) return false;
    if (notification.length !== this.lastNotification.length) return false;
    for (let i = 0; i < notification.length; i += 1) {
      if (notification[i] !== this.lastNotification[i]) return false;
    }
    return true;
  }

  private recordStartGap(
    unwrappedIndex: number,
    rawIndex: number,
    diagnostics: OmiFrameDiagnostic[],
  ): number {
    if (this.lastUnwrappedIndex === null) return 0;
    const gap = unwrappedIndex - this.lastUnwrappedIndex - 1;
    if (gap > 0) {
      this.recordMissingNotifications(gap, rawIndex, 0, diagnostics);
      return gap;
    }
    return 0;
  }

  private recordMissingNotifications(
    count: number,
    rawIndex: number,
    chunkIndex: number,
    diagnostics: OmiFrameDiagnostic[],
  ): void {
    this.metrics.missingNotifications += count;
    diagnostics.push({
      code: "missing-notification",
      packetIndex: rawIndex,
      chunkIndex,
      count,
      detail: "Packet id gap observed in the notification stream.",
    });
  }

  private modeConflict(
    rawIndex: number,
    chunkIndex: number,
    diagnostics: OmiFrameDiagnostic[],
  ): void {
    diagnostics.push({
      code: "mode-conflict",
      packetIndex: rawIndex,
      chunkIndex,
      detail: "Continuation contradicts the detected pendant wire mode.",
    });
    this.dropBuffered(
      diagnostics,
      rawIndex,
      chunkIndex,
      "dropped-buffered-frame",
    );
  }

  private dropBuffered(
    diagnostics: OmiFrameDiagnostic[],
    rawIndex: number | null,
    chunkIndex: number | null,
    code: OmiFrameDiagnosticCode,
    detail = "Buffered frame dropped to avoid emitting ambiguous audio.",
  ): void {
    if (!this.buffer) return;
    this.buffer = null;
    this.metrics.droppedFrames += 1;
    diagnostics.push({
      code,
      packetIndex: rawIndex,
      chunkIndex,
      detail,
    });
  }

  private result(
    frames: ReassembledFrame[],
    diagnostics: OmiFrameDiagnostic[],
  ): OmiFrameReassemblerResult {
    return { frames, diagnostics, metrics: this.snapshot() };
  }

  private snapshot(): OmiFrameMetricsSnapshot {
    return {
      ...this.metrics,
      detectedWireMode: this.mode,
      cadenceMeanMs: this.meanCadence(),
      cadenceP95Ms: this.p95Cadence(),
    };
  }

  private meanCadence(): number | null {
    if (this.cadenceIntervalsMs.length === 0) return null;
    const total = this.cadenceIntervalsMs.reduce(
      (sum, value) => sum + value,
      0,
    );
    return total / this.cadenceIntervalsMs.length;
  }

  private p95Cadence(): number | null {
    if (this.cadenceIntervalsMs.length === 0) return null;
    const sorted = [...this.cadenceIntervalsMs].sort((a, b) => a - b);
    const index = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[Math.max(0, index)];
  }

  private defaultReceivedAtMs(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
  }
}
