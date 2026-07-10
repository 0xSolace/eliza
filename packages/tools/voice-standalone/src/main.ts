#!/usr/bin/env bun
/**
 * Standalone realtime + ambient voice backend — entrypoint.
 *
 * Boots the REAL Phase-1 voice-session code (mint consent+JWT chain,
 * attachVoiceWsHandler, VoiceSession, AmbientSession, merged Deepgram/Cartesia
 * adapters) as a long-running HTTP + WS service bound to 127.0.0.1 (nginx
 * fronts it). See ../../cloud/api/v1/voice/session/lib/standalone-server.ts for
 * the REAL-vs-SHIMMED boundary and the auth-gate honesty note.
 *
 * Config (env; the runner script sources ~/.moltbot/secrets):
 *   VOICE_STANDALONE_HOST         default 127.0.0.1
 *   VOICE_STANDALONE_PORT         default 7801
 *   VOICE_STANDALONE_AUTH_TOKEN   REQUIRED — shared secret gating consent+mint
 *   VOICE_STANDALONE_DATA_DIR     default /mnt/HC_Volume_106234565/voice-standalone-data
 *   DEEPGRAM_API_KEY / CARTESIA_API_KEY / OPENROUTER_API_KEY   REQUIRED
 *   CARTESIA_VOICE_ID             optional (public default)
 *   VOICE_STANDALONE_ELIZA_ENDPOINT / _AUTHORIZATION / HARNESS_LLM_MODEL  optional
 *       (default: OpenRouter chat/completions with OPENROUTER_API_KEY — the same
 *        LLM leg the harness real target uses; swap for the funded Eliza SSE)
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { startStandaloneVoiceServer } from "../../../cloud/api/v1/voice/session/lib/standalone-server.ts";
import { FilePendantStore } from "./file-pendant-store.ts";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} is required`);
  return v.trim();
}

function loadSecret(path: string, field: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const v = raw[field];
    return typeof v === "string" && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const host = process.env.VOICE_STANDALONE_HOST ?? "127.0.0.1";
  const port = Number(process.env.VOICE_STANDALONE_PORT ?? "7801");
  const authToken = requireEnv("VOICE_STANDALONE_AUTH_TOKEN");
  const dataDir =
    process.env.VOICE_STANDALONE_DATA_DIR ?? "/mnt/HC_Volume_106234565/voice-standalone-data";

  // Provider keys: env first, then ~/.moltbot/secrets fallback.
  const deepgramApiKey =
    process.env.DEEPGRAM_API_KEY ??
    loadSecret(join(homedir(), ".moltbot/secrets/deepgram.json"), "api_key");
  const cartesiaApiKey =
    process.env.CARTESIA_API_KEY ??
    loadSecret(join(homedir(), ".moltbot/secrets/cartesia.json"), "api_key");
  if (!deepgramApiKey) throw new Error("DEEPGRAM_API_KEY (or ~/.moltbot/secrets/deepgram.json) required");
  if (!cartesiaApiKey) throw new Error("CARTESIA_API_KEY (or ~/.moltbot/secrets/cartesia.json) required");

  const cartesiaVoiceId =
    process.env.CARTESIA_VOICE_ID ?? "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4";

  // LLM leg: OpenRouter chat/completions by default (same as harness real
  // target). Swap VOICE_STANDALONE_ELIZA_ENDPOINT/_AUTHORIZATION for the funded
  // Eliza SSE when available.
  const openrouterKey = process.env.OPENROUTER_API_KEY;
  const elizaEndpoint =
    process.env.VOICE_STANDALONE_ELIZA_ENDPOINT ??
    "https://openrouter.ai/api/v1/chat/completions";
  const elizaAuthorization =
    process.env.VOICE_STANDALONE_ELIZA_AUTHORIZATION ??
    (openrouterKey ? `Bearer ${openrouterKey}` : "");
  if (!elizaAuthorization) {
    throw new Error(
      "LLM leg not configured: set OPENROUTER_API_KEY or VOICE_STANDALONE_ELIZA_AUTHORIZATION",
    );
  }
  process.env.VOICE_REALTIME_ELIZA_MODEL =
    process.env.VOICE_REALTIME_ELIZA_MODEL ??
    process.env.HARNESS_LLM_MODEL ??
    "meta-llama/llama-3.1-8b-instruct";

  // Fixed dev identity (this service is not multi-tenant — see auth boundary).
  const organizationId =
    process.env.VOICE_STANDALONE_ORG_ID ?? "00000000-0000-4000-8000-0000000000a1";
  const userId = process.env.VOICE_STANDALONE_USER_ID ?? "00000000-0000-4000-8000-0000000000b2";
  const agentId = process.env.VOICE_STANDALONE_AGENT_ID ?? "00000000-0000-4000-8000-0000000000c3";
  const conversationId =
    process.env.VOICE_STANDALONE_CONVERSATION_ID ?? "00000000-0000-4000-8000-0000000000d4";

  const ambientStore = new FilePendantStore(dataDir);

  const hooks = {
    log: (level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) => {
      const line = { ts: new Date().toISOString(), level, msg, ...(data ?? {}) };
      // Never log secret material; keys are passed by reference, never logged.
      process.stderr.write(`${JSON.stringify(line)}\n`);
    },
  };

  const server = await startStandaloneVoiceServer({
    host,
    port,
    authToken,
    deepgramApiKey,
    cartesiaApiKey,
    cartesiaVoiceId,
    elizaEndpoint,
    elizaAuthorization,
    organizationId,
    userId,
    agentId,
    conversationId,
    ambientStore,
    hooks,
  });

  hooks.log("info", "voice-standalone ready", {
    host: server.host,
    port: server.port,
    dataDir,
    llmModel: process.env.VOICE_REALTIME_ELIZA_MODEL,
  });

  const shutdown = async (sig: string) => {
    hooks.log("info", "shutting down", { sig });
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  process.stderr.write(`voice-standalone fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
