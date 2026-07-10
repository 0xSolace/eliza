/**
 * `usePendantAmbientBridge` — resolves a `createAmbientBridge` factory that wires
 * the EXISTING pendant capture path into the NEW ambient always-listening WS
 * session, so a wearable feeds continuous cloud STT instead of per-utterance
 * batch WAV posts.
 *
 * Relationship to the batch path (the non-regression law): this hook is PURELY
 * ADDITIVE. It yields a factory ONLY when
 *   - the VITE realtime flag is on (`isRealtimeVoiceFlagEnabled`, the SAME flag
 *     the conversation realtime path uses), AND
 *   - a dedicated cloud agent UUID resolves (a local/self-hosted runtime has
 *     none → no factory → the pendant runs the batch ASR path unchanged).
 * When the factory is absent, or its mint 404s (server flag off), or consent is
 * missing, `PendantConnection` uses the batch ASR path COMPLETELY unchanged.
 *
 * The bridge's mint gathers consent (POST /consent) then mints in `mode:"ambient"`
 * (POST /session) using the SAME `fetchWithCsrf` every other /api/v1 call uses.
 * A fresh pendant session is created per connect (no `pendantSessionId` on the
 * mint = create-new); the server allocates the canonical `pendant_sessions_v1`
 * session + first capture lease. Everything third-party is injectable so the hook
 * is unit-tested through the REAL bridge + fake transports.
 */

import { useCallback, useMemo } from "react";

import {
  PendantAmbientBridge,
  AmbientMintUnavailableError,
  type AmbientWebSocketFactory,
} from "../pendant/pendant-ambient-bridge";
import type { PendantAmbientBridgeHooks } from "../pendant/pendant-connection";
import {
  isUsableAmbientMintResponse,
  type AmbientMintResponse,
} from "../voice/ambient-uplink-protocol";
import { useRealtimeVoiceMint } from "./useRealtimeVoiceMint";
import { isRealtimeVoiceFlagEnabled } from "./useRealtimeVoiceSession";

/** The factory the pendant connection calls to build an ambient ingest engine. */
export type CreateAmbientBridge = (
  hooks: PendantAmbientBridgeHooks,
) => PendantAmbientBridge;

export interface UsePendantAmbientBridgeOptions {
  /** Injectable flag read (tests). Default = the VITE realtime flag. */
  isFlagEnabled?: () => boolean;
  /** Injectable /api/v1 fetch (tests). Default = the CSRF/bearer dashboard fetch. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Injectable agent-id resolver (tests). */
  resolveAgentId?: () => string | null;
  /** Injectable WebSocket factory (tests / non-standard hosts). */
  webSocketFactory?: AmbientWebSocketFactory;
  /** Mint route path. Default "/api/v1/voice/session". */
  mintPath?: string;
  /** Consent route path. Default "/api/v1/voice/session/consent". */
  consentPath?: string;
}

export interface UsePendantAmbientBridgeResult {
  /** True when the ambient path is armable (flag on + cloud agent resolvable). */
  available: boolean;
  /**
   * The factory to hand `usePendant`/`PendantConnection`. Null when unavailable
   * (the pendant then uses the batch path). Non-null does NOT guarantee the mint
   * succeeds — a 404 at connect time still falls back to batch cleanly.
   */
  createAmbientBridge: CreateAmbientBridge | null;
}

const DEFAULT_WS_FACTORY: AmbientWebSocketFactory = (url) => {
  const Ctor = WebSocket as unknown as new (
    u: string,
  ) => ReturnType<AmbientWebSocketFactory>;
  return new Ctor(url);
};

async function defaultFetch(url: string, init?: RequestInit): Promise<Response> {
  const { fetchWithCsrf } = await import("../api/csrf-client");
  return fetchWithCsrf(url, init);
}

export function usePendantAmbientBridge(
  options: UsePendantAmbientBridgeOptions = {},
): UsePendantAmbientBridgeResult {
  const isFlagEnabled = options.isFlagEnabled ?? isRealtimeVoiceFlagEnabled;
  const doFetch = options.fetch ?? defaultFetch;
  const mintPath = options.mintPath ?? "/api/v1/voice/session";
  const wsFactory = options.webSocketFactory ?? DEFAULT_WS_FACTORY;

  const { agentId, getConsentNonce } = useRealtimeVoiceMint({
    fetch: options.fetch,
    resolveAgentId: options.resolveAgentId,
    consentPath: options.consentPath,
  });

  const flagOn = useMemo(() => {
    try {
      return isFlagEnabled();
    } catch {
      return false;
    }
  }, [isFlagEnabled]);

  const available = flagOn && agentId !== null;

  /**
   * Mint an ambient session: consent → mint(mode:"ambient"). Throws
   * {@link AmbientMintUnavailableError} on 404 (feature off) so the bridge falls
   * back to batch; any other non-ok/parse failure is a plain throw (also → batch).
   */
  const mintAmbient = useCallback(async (): Promise<AmbientMintResponse> => {
    if (!agentId) throw new AmbientMintUnavailableError(404, "no cloud agent");
    const consentNonce = await getConsentNonce();
    if (!consentNonce) {
      // No consent nonce (404/503/blocked) → treat as feature-unavailable so the
      // pendant uses batch. The server would reject an ambient mint without it.
      throw new AmbientMintUnavailableError(404, "consent unavailable");
    }
    const res = await doFetch(mintPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId,
        // Ambient ignores conversationId server-side but the schema tolerates it;
        // omit to keep the create-new pendant-session path unambiguous.
        transport: "websocket",
        consentNonce,
        mode: "ambient",
      }),
    });
    if (!res.ok) {
      // 404 = server flag off → batch fallback. Others → batch fallback too, but
      // preserve the status for diagnostics.
      throw new AmbientMintUnavailableError(res.status);
    }
    const json = (await res.json()) as unknown;
    if (!isUsableAmbientMintResponse(json)) {
      throw new Error("malformed ambient mint response");
    }
    return json;
  }, [agentId, getConsentNonce, doFetch, mintPath]);

  const createAmbientBridge = useMemo<CreateAmbientBridge | null>(() => {
    if (!available) return null;
    return (hooks: PendantAmbientBridgeHooks) =>
      new PendantAmbientBridge({
        mint: mintAmbient,
        webSocketFactory: wsFactory,
        onSegment: hooks.onSegment,
        onTranscript: hooks.onTranscript,
      });
  }, [available, mintAmbient, wsFactory]);

  return { available, createAmbientBridge };
}
