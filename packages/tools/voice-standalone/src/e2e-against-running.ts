#!/usr/bin/env bun
/**
 * E2E proof driver for the STANDALONE voice backend — drives the RUNNING service
 * (not an in-process boot) over its real HTTP + WSS surface with LIVE providers.
 *
 * This is the DoD "prove the real thing happened" gate for the standalone
 * deployment: it does a REAL consent POST -> REAL mint POST -> connects the REAL
 * WSS -> runs the harness baseline + ambient client scenarios (real Deepgram
 * Flux STT, real streaming LLM tokens, real Cartesia TTS audio) against the
 * live service, captures every artifact outside the repo, and FAILS LOUDLY if a
 * required stage/artifact is missing.
 *
 * Usage:
 *   VOICE_STANDALONE_BASE=http://127.0.0.1:7801 \
 *   VOICE_STANDALONE_AUTH_TOKEN=<token> \
 *   OPENROUTER_API_KEY=<key> \
 *   bun run src/e2e-against-running.ts --scenario=baseline|ambient|all
 *
 * (Deepgram/Cartesia keys are read by the SERVER from its env; this driver only
 *  needs the base URL + auth token to reach the service.)
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Evidence } from "../../voice-evidence-harness/src/evidence.ts";
import { parseWav, writeWav } from "../../voice-evidence-harness/src/wav.ts";
import { runClient } from "../../voice-evidence-harness/src/client.ts";
import { runAmbientClient } from "../../voice-evidence-harness/src/ambient-client.ts";

const BASE = process.env.VOICE_STANDALONE_BASE ?? "http://127.0.0.1:7801";
const AUTH = process.env.VOICE_STANDALONE_AUTH_TOKEN;
if (!AUTH) throw new Error("VOICE_STANDALONE_AUTH_TOKEN required (to reach the service)");

const HARNESS_FIXTURES = join(
  new URL("../../voice-evidence-harness/", import.meta.url).pathname,
  "fixtures",
);
const EVIDENCE_ROOT = join(
  homedir(),
  ".moltbot/projects/eliza-fleet/evidence/voice-standalone-e2e",
);

const authHeaders = {
  Authorization: `Bearer ${AUTH}`,
  "content-type": "application/json",
};

async function consent(): Promise<string> {
  const res = await fetch(`${BASE}/api/v1/voice/session/consent`, {
    method: "POST",
    headers: authHeaders,
    body: "{}",
  });
  if (!res.ok) throw new Error(`consent HTTP ${res.status}`);
  const json = (await res.json()) as { consentNonce?: string };
  if (!json.consentNonce) throw new Error("consent returned no nonce");
  return json.consentNonce;
}

interface ConversationMint {
  sessionId: string;
  wsUrl: string;
  token: string;
  expiresAt: string;
}
interface AmbientMint extends ConversationMint {
  pendantSessionId: string;
  captureLeaseToken: string;
}

async function mint(mode: "conversation" | "ambient"): Promise<ConversationMint | AmbientMint> {
  const nonce = await consent();
  const body = mode === "ambient" ? { consentNonce: nonce, mode } : { consentNonce: nonce };
  const res = await fetch(`${BASE}/api/v1/voice/session`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`mint HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as ConversationMint | AmbientMint;
}

/** Compose the absolute WSS/WS URL the browser would connect to. */
function wsAbsolute(wsPath: string): string {
  const u = new URL(BASE);
  const scheme = u.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${u.host}${wsPath}`;
}

async function runBaseline(runDir: string): Promise<{ pass: boolean; reasons: string[]; dir: string }> {
  const evDir = join(runDir, "baseline");
  const ev = new Evidence(evDir);
  const reasons: string[] = [];
  ev.log("harness", "info", "=== standalone baseline (against RUNNING service) ===", { base: BASE });

  const fixture = new Uint8Array(readFileSync(join(HARNESS_FIXTURES, "turn_weather.wav")));
  const wav = parseWav(fixture);
  ev.writeArtifact("input.wav", fixture, "spoken input fixture");

  const minted = (await mint("conversation")) as ConversationMint;
  ev.mark("mint");
  ev.wsEvent("s2c", "json", { kind: "mint_response", sessionId: minted.sessionId, token: "<REDACTED>" });
  ev.log("harness", "info", "minted (real HTTP mint on running service)", { sessionId: minted.sessionId });

  const connectUrl = wsAbsolute(minted.wsUrl);
  ev.log("harness", "info", "connecting real WSS", { url: connectUrl.replace(/sessionId=[^&]+/, "sessionId=<id>") });

  const result = await runClient({
    wsUrl: connectUrl,
    token: minted.token,
    uplinkPcm: wav.pcm,
    evidence: ev,
    maxRunMs: 45_000,
  });

  if (result.downlinkPcm.byteLength > 0) {
    ev.writeArtifact(
      "output-tts.wav",
      writeWav({ pcm: result.downlinkPcm, sampleRate: 16000, channels: 1, bitsPerSample: 16, audioFormat: 1 }),
      "TTS downlink audio (Cartesia Sonic, LIVE, via running standalone service)",
    );
  } else {
    reasons.push("no downlink TTS audio captured");
  }

  const required = ["mint", "ws_hello", "ready", "stt_final", "llm_first_text", "tts_first_frame", "tts_complete"] as const;
  const timing = ev.timingReport(required as unknown as string[]);
  ev.writeJsonArtifact("timing-report.json", timing, "stage timing (explicit not_reached)");
  if (timing.missing.length > 0) reasons.push(`missing stages: ${timing.missing.join(", ")}`);
  if (!result.sawSttFinal) reasons.push("no stt_final");
  if (!result.sawSpeakingStart) reasons.push("no speaking_start");
  if (result.downlinkFrameCount < 1) reasons.push("no TTS frames");

  ev.flushLogs();
  const pass = reasons.length === 0;
  ev.log("harness", pass ? "info" : "error", `baseline ${pass ? "PASS" : "FAIL"}`, { reasons });
  return { pass, reasons, dir: evDir };
}

async function runAmbient(runDir: string): Promise<{ pass: boolean; reasons: string[]; dir: string }> {
  const evDir = join(runDir, "ambient");
  const ev = new Evidence(evDir);
  const reasons: string[] = [];
  ev.log("harness", "info", "=== standalone ambient (against RUNNING service) ===", { base: BASE });

  const fixture = new Uint8Array(readFileSync(join(HARNESS_FIXTURES, "turn_weather.wav")));
  const wav = parseWav(fixture);
  ev.writeArtifact("input.wav", fixture, "spoken input fixture (both utterances)");

  const minted = (await mint("ambient")) as AmbientMint;
  ev.mark("mint");
  ev.wsEvent("s2c", "json", {
    kind: "mint_response",
    sessionId: minted.sessionId,
    pendantSessionId: minted.pendantSessionId,
    token: "<REDACTED>",
    captureLeaseToken: "<REDACTED>",
  });
  ev.log("harness", "info", "minted ambient (real HTTP mint on running service)", {
    sessionId: minted.sessionId,
    pendantSessionId: minted.pendantSessionId,
  });

  const connectUrl = wsAbsolute(minted.wsUrl);
  const result = await runAmbientClient({
    wsUrl: connectUrl,
    token: minted.token,
    pendantSessionId: minted.pendantSessionId,
    captureLeaseToken: minted.captureLeaseToken,
    utterancePcms: [wav.pcm, wav.pcm],
    evidence: ev,
    maxRunMs: 45_000,
  });

  // Read the committed segments back through the service's own inspect route
  // (proves file-backed persistence + the canonical pendant contract).
  const segRes = await fetch(
    `${BASE}/api/v1/voice/session/segments?pendantSessionId=${encodeURIComponent(minted.pendantSessionId)}`,
    { headers: { Authorization: `Bearer ${AUTH}` } },
  );
  const segJson = (await segRes.json()) as { segments?: { ordinal: number; text: string; id: string }[] };
  const stored = segJson.segments ?? [];
  ev.writeJsonArtifact("pendant-segments.json", stored, "committed segments read back from the running service's file store");

  const required = ["mint", "ws_hello", "ready", "first_segment", "paused", "resumed", "second_segment", "capture_complete"] as const;
  const timing = ev.timingReport(required as unknown as string[]);
  ev.writeJsonArtifact("timing-report.json", timing, "stage timing (explicit not_reached)");

  if (timing.missing.length > 0) reasons.push(`missing stages: ${timing.missing.join(", ")}`);
  if (stored.length < 2) reasons.push(`expected >=2 committed segments, got ${stored.length}`);
  const expectedOrdinals = stored.map((_, i) => i);
  if (JSON.stringify(stored.map((s) => s.ordinal)) !== JSON.stringify(expectedOrdinals)) {
    reasons.push(`non-contiguous ordinals: ${JSON.stringify(stored.map((s) => s.ordinal))}`);
  }
  if (!result.sawPaused) reasons.push("pause never confirmed");
  if (!result.sawResumed) reasons.push("resume never confirmed");
  if (result.downlinkAudioFrames !== 0) reasons.push(`AMBIENT DOWNLINK LEAKED: ${result.downlinkAudioFrames} (must be 0)`);

  ev.writeJsonArtifact(
    "ambient-assertion.json",
    {
      sttFinals: result.sttFinals,
      storedOrdinals: stored.map((s) => s.ordinal),
      storedTexts: stored.map((s) => s.text),
      sawPaused: result.sawPaused,
      sawResumed: result.sawResumed,
      sawLeaseRenewed: result.sawLeaseRenewed,
      downlinkAudioFrames: result.downlinkAudioFrames,
      socketClosedAfterRun: result.closed,
    },
    "ambient capture assertions (running service)",
  );

  ev.flushLogs();
  const pass = reasons.length === 0;
  ev.log("harness", pass ? "info" : "error", `ambient ${pass ? "PASS" : "FAIL"}`, { reasons });
  return { pass, reasons, dir: evDir };
}

async function main(): Promise<void> {
  const scenarioArg = process.argv.find((a) => a.startsWith("--scenario="))?.split("=")[1] ?? "all";
  const runDir = join(EVIDENCE_ROOT, new Date().toISOString().replace(/[:.]/g, "-"));
  const results: { name: string; pass: boolean; reasons: string[]; dir: string }[] = [];

  if (scenarioArg === "baseline" || scenarioArg === "all") {
    const r = await runBaseline(runDir);
    results.push({ name: "baseline", ...r });
  }
  if (scenarioArg === "ambient" || scenarioArg === "all") {
    const r = await runAmbient(runDir);
    results.push({ name: "ambient", ...r });
  }

  console.log(`\n=== STANDALONE E2E SUMMARY (${runDir}) ===`);
  for (const r of results) {
    console.log(`  ${r.name}: ${r.pass ? "PASS" : "FAIL"}${r.reasons.length ? " :: " + r.reasons.join("; ") : ""}`);
    console.log(`    evidence: ${r.dir}`);
  }
  const allPass = results.every((r) => r.pass);
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("e2e driver fatal:", err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
