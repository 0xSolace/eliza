/**
 * The client mirror of the ambient wire protocol: hello/control serialization
 * and server-frame parsing. Pure, no transport. Asserts the frames the SERVER
 * parser (cloud ambient-protocol.ts) expects, byte-shape-wise.
 */

import { describe, expect, it } from "vitest";

import {
  buildAmbientHello,
  encodeAmbientClientControl,
  isUsableAmbientMintResponse,
  parseAmbientServerFrame,
  type AmbientMintResponse,
} from "./ambient-uplink-protocol";
import {
  VOICE_SESSION_PROTOCOL_VERSION,
  VOICE_SESSION_SAMPLE_RATE,
} from "./voice-session-protocol";

describe("ambient-uplink-protocol", () => {
  it("builds an ambient hello with mode + pendantSessionId + lease (16k pcm16)", () => {
    const hello = buildAmbientHello({
      token: "tk",
      pendantSessionId: "p-1",
      captureLeaseToken: "lease-1",
    });
    expect(hello).toEqual({
      t: "hello",
      mode: "ambient",
      token: "tk",
      protocol: VOICE_SESSION_PROTOCOL_VERSION,
      pendantSessionId: "p-1",
      captureLeaseToken: "lease-1",
      uplinkCodec: "pcm16",
      sampleRate: VOICE_SESSION_SAMPLE_RATE,
    });
    // The hello carries NO downlink codec (ambient has no reply half).
    expect("downlinkCodec" in hello).toBe(false);
  });

  it("serializes control frames as JSON text", () => {
    expect(JSON.parse(encodeAmbientClientControl({ t: "pause" }))).toEqual({ t: "pause" });
    expect(JSON.parse(encodeAmbientClientControl({ t: "resume" }))).toEqual({ t: "resume" });
    expect(JSON.parse(encodeAmbientClientControl({ t: "lease_renew" }))).toEqual({
      t: "lease_renew",
    });
    expect(JSON.parse(encodeAmbientClientControl({ t: "bye" }))).toEqual({ t: "bye" });
  });

  it("parses every known server event and rejects junk", () => {
    expect(parseAmbientServerFrame(JSON.stringify({ t: "ready", sessionId: "s", pendantSessionId: "p", traceId: "t" }))?.t).toBe("ready");
    expect(parseAmbientServerFrame(JSON.stringify({ t: "stt_partial", text: "x", traceId: "t" }))?.t).toBe("stt_partial");
    const final = parseAmbientServerFrame(
      JSON.stringify({ t: "stt_final", text: "x", segmentId: "p:segment:0", ordinal: 0, revision: 1, traceId: "t" }),
    );
    expect(final).toMatchObject({ t: "stt_final", segmentId: "p:segment:0", ordinal: 0 });
    expect(parseAmbientServerFrame(JSON.stringify({ t: "segment_committed", segmentId: "p:segment:0", ordinal: 0, revision: 1 }))?.t).toBe("segment_committed");
    expect(parseAmbientServerFrame(JSON.stringify({ t: "paused" }))?.t).toBe("paused");
    expect(parseAmbientServerFrame(JSON.stringify({ t: "lease_renewed", leaseToken: "l", leaseExpiresAt: "z" }))?.t).toBe("lease_renewed");
    expect(parseAmbientServerFrame(JSON.stringify({ t: "error", code: "x", retryable: true }))?.t).toBe("error");

    // Junk / unknown / non-object → null (ignored, never throws).
    expect(parseAmbientServerFrame("not json {")).toBeNull();
    expect(parseAmbientServerFrame(JSON.stringify({ t: "unknown" }))).toBeNull();
    expect(parseAmbientServerFrame(JSON.stringify(["array"]))).toBeNull();
    expect(parseAmbientServerFrame(JSON.stringify({ noType: 1 }))).toBeNull();
  });

  it("validates an ambient mint response (mode + all bindings present)", () => {
    const ok: AmbientMintResponse = {
      sessionId: "s",
      wsUrl: "wss://x",
      token: "t",
      expiresAt: 1,
      mode: "ambient",
      pendantSessionId: "p",
      captureLeaseToken: "l",
      leaseExpiresAt: "z",
      uplink: { codecs: ["pcm16"] },
      downlink: { codecs: [] },
    };
    expect(isUsableAmbientMintResponse(ok)).toBe(true);
    // Missing pendantSessionId / lease / wrong mode → not usable.
    expect(isUsableAmbientMintResponse({ ...ok, pendantSessionId: "" })).toBe(false);
    expect(isUsableAmbientMintResponse({ ...ok, captureLeaseToken: "" })).toBe(false);
    expect(isUsableAmbientMintResponse({ ...ok, mode: "conversation" })).toBe(false);
    expect(isUsableAmbientMintResponse(null)).toBe(false);
  });
});
