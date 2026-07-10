/**
 * Client mirror of the ambient always-listening WebSocket wire protocol.
 *
 * The AUTHORITATIVE contract lives on the cloud worker
 * (`packages/cloud/shared/src/lib/voice-session/ambient-protocol.ts`). This
 * module is the browser-side mirror of ONLY the frames the client sends/reads,
 * following the exact same pattern as {@link file://./voice-session-protocol.ts}
 * (the conversation client mirror): it is transport-agnostic, side-effect free,
 * and holds no auth/provider/timer state — just the ambient hello + control
 * frames the client serializes and the ambient server events it parses.
 *
 * Why mirror instead of import the cloud module: the `@elizaos/ui` package
 * cannot pull the cloud worker's runtime graph into the browser bundle, and the
 * conversation protocol already established the mirror pattern. The two are kept
 * byte-compatible by construction (same frame shapes, same field names) and the
 * bridge tests assert the framing the server parser expects.
 *
 * Ambient differs from the conversation contract by:
 *   - a mode-bearing hello (`mode:"ambient"`) that carries the bound
 *     `pendantSessionId` + plaintext `captureLeaseToken`, and NO downlink codec
 *     (ambient has no reply half — no TTS, no `speaking_*`/`interrupted`),
 *   - continuous-capture control frames (`pause`/`resume`/`lease_renew`), and
 *   - segment-commit / lease server events carrying canonical
 *     `segmentId`+`ordinal`+`revision` (the canonical pendant_sessions_v1 ids).
 */

import {
  VOICE_SESSION_PROTOCOL_VERSION,
  VOICE_SESSION_SAMPLE_RATE,
  type VoiceSessionCodec,
} from "./voice-session-protocol";

/** Ambient uplink is pcm16-only in phase 1a (mirrors the server restriction). */
export const AMBIENT_UPLINK_CODEC: VoiceSessionCodec = "pcm16";

// ── Client -> server: ambient control frames ───────────────────────────

/**
 * Ambient hello — the FIRST frame after connect. Distinct from the conversation
 * hello by `mode:"ambient"`, carrying the bound `pendantSessionId` + plaintext
 * `captureLeaseToken` the mint issued. NO `downlinkCodec` (ambient has no
 * downlink). The server verifies the JWT (mode + pendantSessionId claims) AND
 * the lease digest before any audio flows.
 */
export interface AmbientClientHelloFrame {
  t: "hello";
  mode: "ambient";
  token: string;
  protocol: number;
  pendantSessionId: string;
  captureLeaseToken: string;
  uplinkCodec: VoiceSessionCodec;
  sampleRate: number;
}

export interface AmbientClientPauseFrame {
  t: "pause";
}
export interface AmbientClientResumeFrame {
  t: "resume";
}
/** Renew the capture lease over the socket (server holds the current token). */
export interface AmbientClientLeaseRenewFrame {
  t: "lease_renew";
}
export interface AmbientClientByeFrame {
  t: "bye";
}

export type AmbientClientControlFrame =
  | AmbientClientHelloFrame
  | AmbientClientPauseFrame
  | AmbientClientResumeFrame
  | AmbientClientLeaseRenewFrame
  | AmbientClientByeFrame;

// ── Server -> client: ambient events ────────────────────────────────────

export interface AmbientReadyEvent {
  t: "ready";
  sessionId: string;
  pendantSessionId: string;
  traceId: string;
}
export interface AmbientSttPartialEvent {
  t: "stt_partial";
  text: string;
  traceId: string;
}
export interface AmbientSttFinalEvent {
  t: "stt_final";
  text: string;
  segmentId: string;
  ordinal: number;
  revision: number;
  traceId: string;
}
export interface AmbientSegmentCommittedEvent {
  t: "segment_committed";
  segmentId: string;
  ordinal: number;
  revision: number;
}
export interface AmbientPausedEvent {
  t: "paused";
}
export interface AmbientResumedEvent {
  t: "resumed";
}
export interface AmbientLeaseRenewedEvent {
  t: "lease_renewed";
  leaseToken: string;
  leaseExpiresAt: string;
}
export interface AmbientInsightEvent {
  t: "insight";
  insightId: string;
  segmentIds: string[];
  traceId: string;
}
export interface AmbientUsageEvent {
  t: "usage";
  sttMs: number;
  traceId: string;
}
export interface AmbientErrorEvent {
  t: "error";
  code: string;
  retryable: boolean;
}

export type AmbientServerFrame =
  | AmbientReadyEvent
  | AmbientSttPartialEvent
  | AmbientSttFinalEvent
  | AmbientSegmentCommittedEvent
  | AmbientPausedEvent
  | AmbientResumedEvent
  | AmbientLeaseRenewedEvent
  | AmbientInsightEvent
  | AmbientUsageEvent
  | AmbientErrorEvent;

export type AmbientServerFrameType = AmbientServerFrame["t"];

// ── Mint (POST /api/v1/voice/session, mode:"ambient") response ──────────

/**
 * The ambient mint response. Extends the conversation mint fields with the
 * ambient-only bindings: `pendantSessionId`, the one-time `captureLeaseToken`,
 * its `leaseExpiresAt`, an EMPTY downlink codec set (no TTS back), and an
 * honest `processingLocation:"cloud"` (ambient audio unambiguously streams to a
 * cloud STT provider — the UI must say cloud, never on-device).
 */
export interface AmbientMintResponse {
  sessionId: string;
  wsUrl: string;
  token: string;
  expiresAt: number | string;
  mode: "ambient";
  pendantSessionId: string;
  captureLeaseToken: string;
  leaseExpiresAt: string;
  uplink: { codecs: VoiceSessionCodec[] };
  /** ALWAYS empty for ambient — no reply audio. */
  downlink: { codecs: VoiceSessionCodec[] };
  processingLocation?: "cloud" | "on-device";
  iceServers?: unknown | null;
}

// ── Serialization / parsing (pure) ──────────────────────────────────────

/** Serialize a client ambient control frame to a JSON text-frame payload. */
export function encodeAmbientClientControl(
  frame: AmbientClientControlFrame,
): string {
  return JSON.stringify(frame);
}

/** Build the ambient hello for a minted session (pcm16 / 16 kHz, no downlink). */
export function buildAmbientHello(
  minted: Pick<
    AmbientMintResponse,
    "token" | "pendantSessionId" | "captureLeaseToken"
  >,
): AmbientClientHelloFrame {
  return {
    t: "hello",
    mode: "ambient",
    token: minted.token,
    protocol: VOICE_SESSION_PROTOCOL_VERSION,
    pendantSessionId: minted.pendantSessionId,
    captureLeaseToken: minted.captureLeaseToken,
    uplinkCodec: AMBIENT_UPLINK_CODEC,
    sampleRate: VOICE_SESSION_SAMPLE_RATE,
  };
}

const AMBIENT_SERVER_TYPES: ReadonlySet<string> = new Set<AmbientServerFrameType>(
  [
    "ready",
    "stt_partial",
    "stt_final",
    "segment_committed",
    "paused",
    "resumed",
    "lease_renewed",
    "insight",
    "usage",
    "error",
  ],
);

function isKnownAmbientServerType(t: string): t is AmbientServerFrameType {
  return AMBIENT_SERVER_TYPES.has(t);
}

/**
 * Parse an ambient server text-frame payload into a typed event. Returns null
 * for anything that is not a recognized ambient event (unknown `t`, malformed
 * JSON, non-object). Callers treat null as "ignore this frame", never throw, so
 * a single bad frame cannot kill a live ambient session.
 */
export function parseAmbientServerFrame(raw: string): AmbientServerFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const t = (parsed as { t?: unknown }).t;
  if (typeof t !== "string") return null;
  if (!isKnownAmbientServerType(t)) return null;
  return parsed as AmbientServerFrame;
}

/** Type guard: is this an ambient mint response (has the ambient bindings). */
export function isUsableAmbientMintResponse(
  value: unknown,
): value is AmbientMintResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.mode === "ambient" &&
    typeof v.sessionId === "string" &&
    v.sessionId.length > 0 &&
    typeof v.wsUrl === "string" &&
    v.wsUrl.length > 0 &&
    typeof v.token === "string" &&
    v.token.length > 0 &&
    typeof v.pendantSessionId === "string" &&
    v.pendantSessionId.length > 0 &&
    typeof v.captureLeaseToken === "string" &&
    v.captureLeaseToken.length > 0
  );
}
