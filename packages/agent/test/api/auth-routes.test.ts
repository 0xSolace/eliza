/** Exercises auth API route behavior with deterministic OAuth and session fixtures. */
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleAuthRoutes } from "../../src/api/auth-routes";

type CapturedResponse = {
  status: number;
  body: unknown;
};

function createAuthRouteHarness(options: {
  headers?: Record<string, string>;
  pathname?: string;
  remoteAddress?: string;
}): {
  captured: CapturedResponse;
  ctx: Parameters<typeof handleAuthRoutes>[0];
} {
  const captured: CapturedResponse = {
    status: 200,
    body: null,
  };
  const req = {
    headers: {
      host: "127.0.0.1:31337",
      ...options.headers,
    },
    socket: {
      remoteAddress: options.remoteAddress ?? "127.0.0.1",
    },
  } as http.IncomingMessage;
  const res = {} as http.ServerResponse;

  return {
    captured,
    ctx: {
      req,
      res,
      method: "GET",
      pathname: options.pathname ?? "/api/auth/me",
      readJsonBody: async () => null,
      json: (_res, data, status = 200) => {
        captured.status = status;
        captured.body = data;
      },
      error: (_res, message, status = 500) => {
        captured.status = status;
        captured.body = { error: message };
      },
      pairingEnabled: () => false,
      ensurePairingCode: () => null,
      normalizePairingCode: (code) => code,
      rateLimitPairing: () => true,
      getPairingExpiresAt: () => Date.now() + 60_000,
      clearPairing: () => {},
    },
  };
}

describe("handleAuthRoutes", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    process.env.ELIZA_API_TOKEN = "native-token";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns a local session for the authorized on-device agent token", async () => {
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "0";
    const { ctx, captured } = createAuthRouteHarness({
      headers: {
        authorization: "Bearer native-token",
      },
    });

    await expect(handleAuthRoutes(ctx)).resolves.toBe(true);

    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({
      identity: {
        id: "local-agent",
        displayName: "Local Agent",
        kind: "machine",
      },
      session: {
        id: "local",
        kind: "local",
        expiresAt: null,
      },
      access: {
        mode: "local",
        passwordConfigured: false,
        ownerConfigured: false,
      },
    });
    expect(captured.body).toHaveProperty("identity");
    expect(captured.body).toHaveProperty("session");
    expect(captured.body).toHaveProperty("access.role", "OWNER");
  });

  it("returns the canonical bearer machine session shape for a per-boot mobile token", async () => {
    const { ctx, captured } = createAuthRouteHarness({
      headers: {
        host: "10.0.0.7:31337",
        authorization: "Bearer native-token",
      },
      remoteAddress: "10.0.0.9",
    });

    await expect(handleAuthRoutes(ctx)).resolves.toBe(true);

    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({
      identity: {
        id: "bearer-agent",
        displayName: "API User",
        kind: "machine",
      },
      session: {
        id: "bearer",
        kind: "machine",
        expiresAt: null,
      },
      access: {
        mode: "bearer",
        passwordConfigured: true,
        ownerConfigured: false,
        role: "OWNER",
      },
    });
  });

  it("serves real auth status separately from the canonical identity route", async () => {
    const { ctx, captured } = createAuthRouteHarness({
      pathname: "/api/auth/status",
    });

    await expect(handleAuthRoutes(ctx)).resolves.toBe(true);

    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({
      required: true,
      pairingEnabled: false,
      expiresAt: null,
    });
    expect(captured.body).not.toHaveProperty("identity");
    expect(captured.body).not.toHaveProperty("session");
  });

  it("requires the bearer token when Android local auth is enforced", async () => {
    const { ctx, captured } = createAuthRouteHarness({});

    await expect(handleAuthRoutes(ctx)).resolves.toBe(true);

    expect(captured.status).toBe(401);
    expect(captured.body).toMatchObject({
      reason: "remote_auth_required",
      access: {
        mode: "local",
        passwordConfigured: true,
        ownerConfigured: false,
      },
    });
  });

  it("rejects an invalid per-boot mobile bearer token on a non-loopback host", async () => {
    const { ctx, captured } = createAuthRouteHarness({
      headers: {
        host: "10.0.0.7:31337",
        authorization: "Bearer wrong-token",
      },
      remoteAddress: "10.0.0.9",
    });

    await expect(handleAuthRoutes(ctx)).resolves.toBe(true);

    expect(captured.status).toBe(401);
    expect(captured.body).toMatchObject({
      reason: "remote_auth_required",
      access: {
        mode: "local",
        passwordConfigured: true,
        ownerConfigured: false,
        role: "GUEST",
      },
    });
  });
});
