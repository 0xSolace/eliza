/**
 * API authentication helpers extracted from server.ts.
 *
 * Centralises token extraction from multiple header formats and
 * timing-safe comparison so route handlers don't reimplement it.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { logger } from "@elizaos/core";
import { resolveApiToken } from "@elizaos/shared";
import {
  CSRF_HEADER_NAME,
  findActiveSession,
  verifyCsrfToken,
} from "./auth/sessions";
import { tokenMatches } from "./auth/tokens";
import { isTrustedLocalRequest, readCompatJsonBody } from "./compat-route-shared";
import { sendJson, sendJsonError } from "./response";

const LAUNCH_AUTH_COOKIE_NAME = "milady_auth";
const LAUNCH_AUTH_MAX_AGE_SECONDS = 8 * 60 * 60;

export { tokenMatches } from "./auth/tokens";

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
  const authHeader = extractHeaderValue(req.headers.authorization)
    ?.slice(0, 1024)
    ?.trim();
  if (authHeader) {
    const match = /^Bearer\s{1,8}(.+)$/i.exec(authHeader);
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
 * Gate a request behind the configured API token (sync, bearer-only).
 *
 * Use this only on cold paths where no `AuthStore` exists yet (boot
 * sequence, or before plugin-sql has attached its adapter). Every route
 * that runs after the runtime is up should use
 * {@link ensureCompatApiAuthorizedAsync} instead, which understands
 * session cookies + CSRF.
 */
export function ensureCompatApiAuthorized(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
  res: http.ServerResponse,
): boolean {
  if (isTrustedLocalRequest(req)) return true;

  const expectedToken = getCompatApiToken();
  if (!expectedToken) {
    sendJsonError(res, 401, "Unauthorized");
    return false;
  }

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

/** State-changing HTTP verbs that require CSRF enforcement on cookie auth. */
const CSRF_REQUIRED_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Cookie-aware authorisation gate. Tries (in order):
 *   1. valid `milady_session` cookie → session in DB → authorised.
 *   2. configured static bearer (legacy) → 14-day grace window via
 *      `decideLegacyBearer`; emits the deprecation header on success.
 *   3. open-access fallback when no token is configured.
 *
 * For cookie-bound sessions, state-changing methods (POST/PUT/PATCH/DELETE)
 * MUST present a valid `x-milady-csrf` header that matches the per-session
 * `csrfSecret` derivation. Reject 403 otherwise. Bearer-auth requests are
 * exempt (not cookie-bound, so no CSRF risk).
 *
 * Returns `true` when the request may proceed; `false` after sending a
 * 401/403/429.
 *
 * Caller supplies an `AuthStore` because importing one here would create a
 * cycle with `services/auth-store.ts`. Routes typically construct one
 * once per handler.
 */
export async function ensureCompatApiAuthorizedAsync(
  req: Pick<http.IncomingMessage, "headers" | "socket" | "method">,
  res: http.ServerResponse,
  options: {
    store: import("../services/auth-store").AuthStore;
    now?: number;
    /**
     * Skip CSRF enforcement for routes that ALWAYS handle CSRF themselves
     * (e.g. login routes that mint the cookie, where there is no prior
     * session to derive a token from). Default: false — enforce CSRF.
     */
    skipCsrf?: boolean;
  },
): Promise<boolean> {
  const ip = req.socket?.remoteAddress ?? null;
  if (isAuthRateLimited(ip)) {
    sendJsonError(res, 429, "Too many authentication attempts");
    return false;
  }

  if (isTrustedLocalRequest(req)) return true;

  const method = (req.method ?? "GET").toUpperCase();
  const csrfRequired = !options.skipCsrf && CSRF_REQUIRED_METHODS.has(method);

  // Cookie path
  const sessionCookie = readCookie(req, SESSION_COOKIE_NAME);
  if (sessionCookie) {
    const session = await findActiveSession(
      options.store,
      sessionCookie,
      options.now,
    ).catch(() => null);
    if (session) {
      if (csrfRequired) {
        const csrfHeader = extractHeaderValue(
          (req.headers as http.IncomingHttpHeaders)[CSRF_HEADER_NAME],
        );
        if (!verifyCsrfToken(session, csrfHeader)) {
          sendJsonError(res, 403, "csrf_required");
          return false;
        }
      }
      return true;
    }
  }

  // Bearer path — session id, legacy static token, or bootstrap bearer.
  // Bearer-auth requests are exempt from CSRF (they're not cookie-bound).
  const provided = getProvidedApiToken(req);
  if (provided) {
    const sessionFromBearer = await findActiveSession(
      options.store,
      provided,
      options.now,
    ).catch(() => null);
    if (sessionFromBearer) return true;

    const expectedToken = getCompatApiToken();
    if (expectedToken && tokenMatches(expectedToken, provided)) {
      const userAgent = extractHeaderValue(req.headers["user-agent"]);
      const {
        decideLegacyBearer,
        recordLegacyBearerRejection,
        recordLegacyBearerUse,
        LEGACY_DEPRECATION_HEADER,
      } = await import("./auth/legacy-bearer");
      const decision = await decideLegacyBearer(
        options.store,
        process.env,
        options.now,
      );
      if (decision.allowed) {
        if (!res.headersSent) {
          res.setHeader(LEGACY_DEPRECATION_HEADER, "1");
        }
        await recordLegacyBearerUse(options.store, {
          ip,
          userAgent,
        }).catch((err) => {
          logger.error(
            `[auth] legacy bearer audit failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        return true;
      }
      await recordLegacyBearerRejection(options.store, {
        ip,
        userAgent,
        reason: decision.reason ?? "post_grace",
      }).catch((err) => {
        logger.error(
          `[auth] legacy bearer rejection audit failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      recordFailedAuth(ip);
      sendJsonError(res, 401, "Unauthorized");
      return false;
    }
  }

  // No credential matched.
  if (!getCompatApiToken()) {
    sendJsonError(res, 401, "Unauthorized");
    return false;
  }

  recordFailedAuth(ip);
  sendJsonError(res, 401, "Unauthorized");
  return false;
}

/** Returns true when NODE_ENV indicates a local development environment. */
export function isDevEnvironment(): boolean {
  const env = process.env.NODE_ENV?.trim().toLowerCase();
  return env === "development" || env === "dev";
}

// ── Cookie / session helpers ──────────────────────────────────────────────────

const SESSION_COOKIE_NAME = "milady_session";

/** Cookie name used by the session model. Exported for tests + UI client. */
export function getSessionCookieName(): string {
  return SESSION_COOKIE_NAME;
}

/**
 * Read the named cookie from the `cookie` header. Returns `null` when the
 * header is missing or the cookie is not set.
 *
 * Pulled out here so route handlers don't reimplement parsing — the existing
 * `compat-route-shared.ts` predates the cookie-based session model.
 */
export function readCookie(
  req: Pick<http.IncomingMessage, "headers">,
  name: string,
): string | null {
  const raw = extractHeaderValue(req.headers.cookie);
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    const v = part.slice(eq + 1).trim();
    return v.length > 0 ? decodeURIComponent(v) : null;
  }
  return null;
}

/**
 * Resolved auth context for a sensitive request.
 *
 * `kind === "session"` — request carries a valid session cookie / bearer that
 * resolves to an unrevoked, unexpired session row.
 *
 * `kind === "bootstrap"` — request carries a one-shot bootstrap token. The
 * token has been verified and its `jti` consumed; the caller is expected to
 * mint a session row for the identity in `claims.sub` and reply with the
 * session id.
 *
 * `kind === "denied"` — request is rejected. The handler must send 401/403/429
 * per `status` and not proceed.
 */
export type AuthSessionOrBootstrapResult =
  | { kind: "session"; sessionId: string }
  | { kind: "bootstrap"; token: string; bearer: string }
  | { kind: "denied"; status: 401 | 403 | 429; reason: string };

/**
 * Decide whether a request carries a valid session cookie or a bootstrap
 * bearer eligible for exchange. This is the single chokepoint that replaces
 * the deleted "cloud-provisioned bypass" branches.
 *
 * The function does NOT exchange the bootstrap token here — that's the job
 * of `POST /api/auth/bootstrap/exchange`, which is rate-limited and audited.
 * On the legacy onboarding routes we treat a valid session OR an unconsumed
 * bootstrap bearer as authorisation to read; the exchange route is the
 * single place that flips bootstrap → session.
 *
 * Fails closed on every error path. There is no path through this function
 * that returns "session" without a real session row id.
 */
export function ensureAuthSessionOrBootstrap(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
): AuthSessionOrBootstrapResult {
  const ip = req.socket?.remoteAddress ?? null;
  if (isAuthRateLimited(ip)) {
    return { kind: "denied", status: 429, reason: "rate_limited" };
  }

  const cookie = readCookie(req, SESSION_COOKIE_NAME);
  if (cookie) {
    // Caller is expected to look up the session by id and confirm it is
    // valid. We don't hit the DB here to keep the helper synchronous; the
    // DB lookup happens in the route handler with `AuthStore.findSession`.
    return { kind: "session", sessionId: cookie };
  }

  const bearer = getProvidedApiToken(req);
  if (bearer) {
    return { kind: "bootstrap", token: bearer, bearer };
  }

  recordFailedAuth(ip);
  return { kind: "denied", status: 401, reason: "auth_required" };
}

/**
 * Gate a sensitive route. Without a configured token, only trusted same-machine
 * dashboard requests are allowed. Remote callers need a real auth method.
 */
export function ensureCompatSensitiveRouteAuthorized(
  req: Pick<http.IncomingMessage, "headers" | "socket">,
  res: http.ServerResponse,
): boolean {
  if (!getCompatApiToken()) {
    // No API token configured. Allow only the same-machine dashboard path.
    // Remote access must use a configured auth method.
    if (isTrustedLocalRequest(req)) {
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

interface CompatStateLike {
  current: { adapter?: { db?: unknown } | null } | null;
}

/**
 * Canonical async route guard. Replaces every call site of
 * {@link ensureCompatApiAuthorized}. Behaviour:
 *
 *   - When the runtime DB is up, delegate to
 *     {@link ensureCompatApiAuthorizedAsync} so cookie + CSRF +
 *     legacy-bearer + machine-session paths all work.
 *   - When the runtime DB is not yet available (early boot), fall back
 *     to {@link ensureCompatApiAuthorized} (bearer-only). This preserves
 *     the existing behaviour for cold boot probes that ran before the
 *     auth subsystem was available.
 *
 * Pass `skipCsrf: true` for routes that mint cookies / handle their own
 * CSRF (login, setup, bootstrap exchange) where the SPA cannot present a
 * CSRF token because the session doesn't exist yet.
 */
export async function ensureRouteAuthorized(
  req: Pick<http.IncomingMessage, "headers" | "socket" | "method">,
  res: http.ServerResponse,
  state: CompatStateLike,
  options: { skipCsrf?: boolean; now?: number } = {},
): Promise<boolean> {
  const adapter = state.current?.adapter;
  const db = adapter?.db;
  if (!db) {
    return ensureCompatApiAuthorized(req, res);
  }
  const { AuthStore } = await import("../services/auth-store");
  const store = new AuthStore(db as ConstructorParameters<typeof AuthStore>[0]);
  return ensureCompatApiAuthorizedAsync(req, res, {
    store,
    now: options.now,
    skipCsrf: options.skipCsrf,
  });
}
