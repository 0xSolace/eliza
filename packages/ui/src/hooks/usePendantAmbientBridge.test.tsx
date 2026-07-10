// @vitest-environment jsdom
//
/**
 * Tests for `usePendantAmbientBridge` — resolves the `createAmbientBridge`
 * factory (flag + cloud-agent gate) and drives the REAL bridge through injected
 * transports: the consent→mint(mode:"ambient") shaping, the 404/consent
 * fallbacks, and the availability gate. No stub of the bridge itself.
 */

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Same hermetic mocks as useRealtimeVoiceMint's suite — every test injects
// resolveAgentId so the native persistence chain is never taken.
vi.mock("../state/persistence", () => ({
  loadPersistedActiveServer: () => null,
}));
vi.mock("../state/agent-session-recovery", () => ({
  resolveDedicatedAgentId: () => null,
}));

import { usePendantAmbientBridge } from "./usePendantAmbientBridge";
import { AmbientMintUnavailableError } from "../pendant/pendant-ambient-bridge";

const UUID = "44444444-4444-4444-4444-444444444444";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

function ambientMintBody() {
  return {
    sessionId: "s",
    wsUrl: "wss://x/ws",
    token: "tk",
    expiresAt: 1,
    mode: "ambient",
    pendantSessionId: "p-1",
    captureLeaseToken: "lease-1",
    leaseExpiresAt: "z",
    uplink: { codecs: ["pcm16"] },
    downlink: { codecs: [] },
    processingLocation: "cloud",
  };
}

describe("usePendantAmbientBridge", () => {
  it("is unavailable (null factory) when the flag is off", () => {
    const { result } = renderHook(() =>
      usePendantAmbientBridge({
        isFlagEnabled: () => false,
        resolveAgentId: () => UUID,
        fetch: vi.fn(),
        webSocketFactory: vi.fn(),
      }),
    );
    expect(result.current.available).toBe(false);
    expect(result.current.createAmbientBridge).toBeNull();
  });

  it("is unavailable when no cloud agent resolves (local runtime)", () => {
    const { result } = renderHook(() =>
      usePendantAmbientBridge({
        isFlagEnabled: () => true,
        resolveAgentId: () => null,
        fetch: vi.fn(),
        webSocketFactory: vi.fn(),
      }),
    );
    expect(result.current.available).toBe(false);
    expect(result.current.createAmbientBridge).toBeNull();
  });

  it("is available and yields a factory when flag on + cloud agent resolves", () => {
    const { result } = renderHook(() =>
      usePendantAmbientBridge({
        isFlagEnabled: () => true,
        resolveAgentId: () => UUID,
        fetch: vi.fn(),
        webSocketFactory: vi.fn(),
      }),
    );
    expect(result.current.available).toBe(true);
    expect(typeof result.current.createAmbientBridge).toBe("function");
  });

  it("the factory mints consent→ambient and arms the bridge on a good mint", async () => {
    const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/consent")) return jsonResponse({ consentNonce: "nonce-1" });
      if (url.endsWith("/voice/session")) return jsonResponse(ambientMintBody());
      throw new Error(`unexpected url ${url}`);
    });
    // A controllable fake WS: capture listeners so we can drive open → ready
    // (start() now resolves true ONLY on the server `ready` event).
    const listeners: Record<string, Array<(e?: unknown) => void>> = {};
    const ws = {
      binaryType: "blob",
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: (type: string, fn: (e?: unknown) => void) => {
        (listeners[type] ??= []).push(fn);
      },
    };
    const webSocketFactory = vi.fn(() => ws);
    const { result } = renderHook(() =>
      usePendantAmbientBridge({
        isFlagEnabled: () => true,
        resolveAgentId: () => UUID,
        fetch: fetch as unknown as typeof globalThis.fetch,
        webSocketFactory: webSocketFactory as never,
      }),
    );
    const factory = result.current.createAmbientBridge!;
    const bridge = factory({ onSegment: vi.fn(), onTranscript: vi.fn() });
    let armed: boolean | undefined;
    await act(async () => {
      const armedP = bridge.start();
      // Wait for the mint + WS construction, then drive open → ready.
      for (let i = 0; i < 50 && !listeners.open; i++) await Promise.resolve();
      listeners.open?.forEach((fn) => fn());
      listeners.message?.forEach((fn) =>
        fn({
          data: JSON.stringify({
            t: "ready",
            sessionId: "s",
            pendantSessionId: "p-1",
            traceId: "t",
          }),
        }),
      );
      armed = await armedP;
    });
    expect(armed).toBe(true);
    // Consent was gathered, then the ambient mint sent mode:"ambient".
    const mintCall = fetch.mock.calls.find(([u]) => (u as string).endsWith("/voice/session"));
    expect(mintCall).toBeDefined();
    const body = JSON.parse((mintCall![1] as RequestInit).body as string);
    expect(body).toMatchObject({ agentId: UUID, mode: "ambient", consentNonce: "nonce-1" });
    // The WS was opened against the minted url.
    expect(webSocketFactory).toHaveBeenCalledWith("wss://x/ws");
    bridge.stop();
  });

  it("mint declines to batch when consent is unavailable (no ambient mint sent)", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/consent")) return jsonResponse({}, false, 404);
      throw new Error(`should not mint without consent: ${url}`);
    });
    const webSocketFactory = vi.fn();
    const { result } = renderHook(() =>
      usePendantAmbientBridge({
        isFlagEnabled: () => true,
        resolveAgentId: () => UUID,
        fetch: fetch as unknown as typeof globalThis.fetch,
        webSocketFactory: webSocketFactory as never,
      }),
    );
    const ends: string[] = [];
    const bridge = result.current.createAmbientBridge!({
      onSegment: vi.fn(),
      onTranscript: vi.fn(),
    });
    // Attach an end observer by wrapping start (bridge onEnd is internal here;
    // assert via the returned armed=false + no WS creation).
    let armed: boolean | undefined;
    await act(async () => {
      armed = await bridge.start();
    });
    void ends;
    expect(armed).toBe(false);
    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it("a 404 ambient mint (server flag off) declines to batch (armed=false)", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/consent")) return jsonResponse({ consentNonce: "n" });
      if (url.endsWith("/voice/session")) return jsonResponse({}, false, 404);
      throw new Error(`unexpected ${url}`);
    });
    const webSocketFactory = vi.fn();
    const { result } = renderHook(() =>
      usePendantAmbientBridge({
        isFlagEnabled: () => true,
        resolveAgentId: () => UUID,
        fetch: fetch as unknown as typeof globalThis.fetch,
        webSocketFactory: webSocketFactory as never,
      }),
    );
    const bridge = result.current.createAmbientBridge!({
      onSegment: vi.fn(),
      onTranscript: vi.fn(),
    });
    let armed: boolean | undefined;
    await act(async () => {
      armed = await bridge.start();
    });
    expect(armed).toBe(false);
    expect(webSocketFactory).not.toHaveBeenCalled();
  });

  it("exposes AmbientMintUnavailableError.isFeatureDisabled for 404s", () => {
    expect(new AmbientMintUnavailableError(404).isFeatureDisabled).toBe(true);
    expect(new AmbientMintUnavailableError(503).isFeatureDisabled).toBe(false);
  });
});
