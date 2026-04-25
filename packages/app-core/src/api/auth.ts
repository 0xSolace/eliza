/**
 * API authentication helpers extracted from server.ts.
 *
 * Centralises token extraction from multiple header formats and
 * timing-safe comparison so route handlers don't reimplement it.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { resolveApiToken } from "@elizaos/shared/runtime-env";
import {
  isLoopbackRemoteAddress,
  readCompatJsonBody,
} from "./compat-route-shared";
import { sendJson, sendJsonError } from "./response";

const LAUNCH_AUTH_COOKIE_NAME = "milady_auth";
const LAUNCH_AUTH_MAX_AGE_SECONDS = 8 * 60 * 60;

/**
 * Normalise a potentially multi-valued HTTP header into a single string.
 * Returns `null` when the header is absent or empty.
 */
export function extractHeaderValue(
  value: string | string[] | undefined,
): string | null {
  if (typeof value === "string") return value;
  return Array.isArray(value) && typeof value[0] === "string" ? value[0] : null;
}

/**
 * Read the configured API token from env (`ELIZA_API_TOKEN` / `ELIZA_API_TOKEN`).
 * Returns `null` when no token is configured (open access).
 */
export function getCompatApiToken(): string | null {
  return resolveApiToken(process.env);
}

/** Timing-safe token comparison (constant-time regardless of input length). */
export function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  // Pad the shorter buffer so timingSafeEqual always runs on equal-length inputs,
  // preventing length leakage through early return.
  const maxLen = Math.max(a.length, b.length);
  const aPadded = Buffer.alloc(maxLen);
  const bPadded = Buffer.alloc(maxLen);
  a.copy(aPadded);
  b.copy(bPadded);
  // Always run timingSafeEqual regardless of length to prevent timing leakage
  const contentMatch = crypto.timingSafeEqual(aPadded, bPadded);
  return a.length === b.length && contentMatch;
}

/**
 * Extract the API token from an incoming request.
 *
 * Checks (in order):
 *   1. `Authorization: Bearer <token>`
 *   2. `x-eliza-token`
 *   3. `x-elizaos-token`
 *   4. `x-api-key` / `x-api-token`
 */
export function getProvidedApiToken(
  req: Pick<http.IncomingMessage, "headers">,
): string | null {
  const authHeader = extractHeaderValue(req.headers.authorization)?.trim();
  if (authHeader) {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (match?.[1]) return match[1].trim();
  }

  const headerToken =
    extractHeaderValue(req.headers["x-eliza-token"]) ??
    extractHeaderValue(req.headers["x-elizaos-token"]) ??
    extractHeaderValue(req.headers["x-api-key"]) ??
    extractHeaderValue(req.headers["x-api-token"]);

  return headerToken?.trim() || null;
}

function isLaunchAuthEnabled(): boolean {
  const raw = process.env.MILADY_ENABLE_LAUNCH_AUTH?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function getLaunchAuthSecret(): string | null {
  return (
    process.env.MILADY_LAUNCH_SECRET?.trim() ||
    process.env.ELIZA_LAUNCH_SECRET?.trim() ||
    null
  );
}

function getExpectedLaunchAgentId(): string | null {
  return (
    process.env.MILADY_AGENT_ID?.trim() ||
    process.env.ELIZA_AGENT_ID?.trim() ||
    process.env.AGENT_ID?.trim() ||
    null
  );
}

function base64UrlDecode(value: string): Buffer | null {
  if (!value || value.length % 4 === 1) return null;
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  try {
    return Buffer.from(padded, "base64");
  } catch {
    return null;
  }
}

function hmacSha256Raw(message: string | Buffer, secret: string): Buffer {
  return crypto.createHmac("sha256", secret).update(message).digest();
}

function timingSafeBufferEqual(a: Buffer, b: Buffer): boolean {
  const maxLen = Math.max(a.length, b.length);
  const aPadded = Buffer.alloc(maxLen);
  const bPadded = Buffer.alloc(maxLen);
  a.copy(aPadded);
  b.copy(bPadded);
  const contentMatch = crypto.timingSafeEqual(aPadded, bPadded);
  return a.length === b.length && contentMatch;
}

type LaunchPayload = Record<string, unknown>;

export interface VerifiedLaunchToken {
  payload: LaunchPayload;
  expiresAt: number;
  agentId: string;
}

function parseLaunchPayload(raw: Buffer): LaunchPayload | null {
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as LaunchPayload)
      : null;
  } catch {
    return null;
  }
}

function validateLaunchPayload(
  payload: LaunchPayload,
): { agentId: string; expiresAt: number } | null {
  const rawAgentId = payload.a ?? payload.agentId;
  const rawExpiresAt = payload.e ?? payload.exp;
  const agentId = typeof rawAgentId === "string" ? rawAgentId.trim() : "";
  const expiresAt =
    typeof rawExpiresAt === "number"
      ? rawExpiresAt
      : typeof rawExpiresAt === "string"
        ? Number(rawExpiresAt)
        : NaN;
  if (!agentId || !Number.isFinite(expiresAt)) return null;
  if (expiresAt <= Math.floor(Date.now() / 1000)) return null;

  const expectedAgentId = getExpectedLaunchAgentId();
  if (expectedAgentId && agentId !== expectedAgentId) return null;

  return { agentId, expiresAt };
}

/**
 * Verify both launch-token formats in the wild:
 *   - nginx-lua legacy: base64url(payload_json).base64url(hmac(payload_json))
 *   - JWT HS256: base64url(header).base64url(payload).base64url(hmac(header.payload))
 */
export function verifyLaunchAuthToken(token: string): VerifiedLaunchToken | null {
  if (!isLaunchAuthEnabled()) return null;
  const secret = getLaunchAuthSecret();
  if (!secret) return null;

  const trimmed = token.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 2 && parts.length !== 3) return null;

  let payloadRaw: Buffer | null = null;
  let signatureRaw: Buffer | null = null;
  let expectedSignature: Buffer | null = null;

  if (parts.length === 2) {
    payloadRaw = base64UrlDecode(parts[0]);
    signatureRaw = base64UrlDecode(parts[1]);
    if (!payloadRaw || !signatureRaw) return null;
    expectedSignature = hmacSha256Raw(payloadRaw, secret);
  } else {
    const headerRaw = base64UrlDecode(parts[0]);
    payloadRaw = base64UrlDecode(parts[1]);
    signatureRaw = base64UrlDecode(parts[2]);
    if (!headerRaw || !payloadRaw || !signatureRaw) return null;
    const header = parseLaunchPayload(headerRaw);
    if (header?.alg !== "HS256") return null;
    expectedSignature = hmacSha256Raw(`${parts[0]}.${parts[1]}`, secret);
  }

  if (!timingSafeBufferEqual(signatureRaw, expectedSignature)) return null;

  const payload = parseLaunchPayload(payloadRaw);
  if (!payload) return null;
  const valid = validateLaunchPayload(payload);
  if (!valid) return null;

  return { payload, agentId: valid.agentId, expiresAt: valid.expiresAt };
}

function extractCookieValue(
  req: Pick<http.IncomingMessage, "headers">,
  name: string,
): string | null {
  const cookieHeader = extractHeaderValue(req.headers.cookie);
  if (!cookieHeader) return null;
  for (const cookie of cookieHeader.split(";")) {
    const idx = cookie.indexOf("=");
    if (idx <= 0) continue;
    const key = cookie.slice(0, idx).trim();
    if (key !== name) continue;
    const raw = cookie.slice(idx + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

function getProvidedLaunchCookieToken(
  req: Pick<http.IncomingMessage, "headers">,
): string | null {
  return extractCookieValue(req, LAUNCH_AUTH_COOKIE_NAME)?.trim() || null;
}

function isLaunchCookieAuthorized(
  req: Pick<http.IncomingMessage, "headers">,
  expectedApiToken: string,
): boolean {
  const cookieToken = getProvidedLaunchCookieToken(req);
  if (!cookieToken) return false;

  // Preserve current milady cloud router behavior: if nginx passes the existing
  // API-key cookie through without injecting a bearer header, accept it.
  if (tokenMatches(expectedApiToken, cookieToken)) return true;

  return Boolean(verifyLaunchAuthToken(cookieToken));
}

function setLaunchAuthCookie(
  res: http.ServerResponse,
  token: string,
  expiresAt: number,
): void {
  const now = Math.floor(Date.now() / 1000);
  const maxAge = Math.max(
    1,
    Math.min(LAUNCH_AUTH_MAX_AGE_SECONDS, expiresAt - now),
  );
  res.setHeader(
    "Set-Cookie",
    `${LAUNCH_AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`,
  );
  res.setHeader("Cache-Control", "no-store");
}

export async function handleLaunchAuthRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const url = new URL(req.url ?? "/", "http://localhost");
  const isApiLaunchRoute = url.pathname === "/api/auth/launch";
  const isRootLaunchRoute =
    method === "GET" &&
    url.pathname === "/" &&
    Boolean(url.searchParams.get("launch") || url.searchParams.get("token"));
  if (!isApiLaunchRoute && !isRootLaunchRoute) return false;

  if (!isLaunchAuthEnabled() || !getLaunchAuthSecret()) {
    sendJson(res, 401, { error: "invalid_launch_token" });
    return true;
  }

  if (!["GET", "POST"].includes(method)) {
    sendJsonError(res, 405, "method not allowed");
    return true;
  }

  let token: string | null = null;
  if (method === "GET") {
    token = url.searchParams.get("token") ?? url.searchParams.get("launch");
  } else {
    const body = await readCompatJsonBody(req, res);
    if (body === null) return true;
    token = typeof body.token === "string" ? body.token : null;
  }

  const verified = token ? verifyLaunchAuthToken(token) : null;
  if (!token || !verified) {
    sendJson(res, 401, { error: "invalid_launch_token" });
    return true;
  }

  setLaunchAuthCookie(res, token, verified.expiresAt);

  if (method === "GET") {
    res.statusCode = 302;
    res.setHeader("Location", "/");
    res.end();
    return true;
  }

  sendJson(res, 200, { ok: true });
  return true;
}

// ── Auth attempt rate limiter ─────────────────────────────────────────────────
const AUTH_RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const AUTH_RATE_LIMIT_MAX = 20; // max failed attempts per window per IP
const authAttempts = new Map<string, { count: number; resetAt: number }>();

/** Clear all auth rate limit state. Exported for test use only. */
export function _resetAuthRateLimiter(): void {
  authAttempts.clear();
}

const authSweepTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [key, entry] of authAttempts) {
      if (now > entry.resetAt) authAttempts.delete(key);
    }
  },
  5 * 60 * 1000,
);
if (typeof authSweepTimer === "object" && "unref" in authSweepTimer) {
  authSweepTimer.unref();
}

function isAuthRateLimited(ip: string | null): boolean {
  const key = ip ?? "unknown";
  const now = Date.now();
  const entry = authAttempts.get(key);
  if (!entry || now > entry.resetAt) return false;
  return entry.count >= AUTH_RATE_LIMIT_MAX;
}

function recordFailedAuth(ip: string | null): void {
  const key = ip ?? "unknown";
  const now = Date.now();
  const entry = authAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    authAttempts.set(key, {
      count: 1,
      resetAt: now + AUTH_RATE_LIMIT_WINDOW_MS,
    });
  } else {
    entry.count += 1;
  }
}

/**
 * Gate a request behind the configured API token.
 * Returns `true` if the request is authorised (or no token is configured).
 * Sends a 401 and returns `false` otherwise.
 */
export function ensureCompatApiAuthorized(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
  res: http.ServerResponse,
): boolean {
  const expectedToken = getCompatApiToken();
  if (!expectedToken) return true;

  const ip = req.socket?.remoteAddress ?? null;
  if (isAuthRateLimited(ip)) {
    sendJsonError(res, 429, "Too many authentication attempts");
    return false;
  }

  const providedToken = getProvidedApiToken(req);
  if (providedToken && tokenMatches(expectedToken, providedToken)) return true;
  if (isLaunchCookieAuthorized(req, expectedToken)) return true;

  recordFailedAuth(ip);
  sendJsonError(res, 401, "Unauthorized");
  return false;
}

/** Returns true when NODE_ENV indicates a local development environment. */
export function isDevEnvironment(): boolean {
  const env = process.env.NODE_ENV?.trim().toLowerCase();
  return env === "development" || env === "dev";
}

/**
 * Gate a sensitive route. In dev mode the request is allowed through ONLY
 * when `ELIZA_DEV_AUTH_BYPASS=1` is explicitly set and no token is configured.
 * In all other cases an API token is required.
 */
export function ensureCompatSensitiveRouteAuthorized(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
  res: http.ServerResponse,
): boolean {
  if (!getCompatApiToken()) {
    // No API token configured. Allow if the request is from loopback
    // (desktop app / local dev) or if dev bypass is enabled. Block
    // otherwise — an unconfigured token on a non-loopback bind is
    // a security risk.
    if (
      isLoopbackRemoteAddress(req.socket?.remoteAddress) ||
      (isDevEnvironment() && process.env.ELIZA_DEV_AUTH_BYPASS?.trim() === "1")
    ) {
      return true;
    }
    sendJsonError(
      res,
      403,
      "Sensitive endpoint requires API token authentication",
    );
    return false;
  }
  return ensureCompatApiAuthorized(req, res);
}
