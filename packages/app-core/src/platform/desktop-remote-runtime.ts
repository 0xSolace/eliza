export const DESKTOP_REMOTE_ENABLED_KEY = "milady_desktop_remote_enabled";
export const DESKTOP_REMOTE_URL_KEY = "milady_desktop_remote_url";
export const DESKTOP_REMOTE_STATUS_KEY = "milady_desktop_remote_status";
export const DESKTOP_REMOTE_ERROR_KEY = "milady_desktop_remote_error";
export const DESKTOP_REMOTE_CONNECTED_AT_KEY =
  "milady_desktop_remote_connected_at";
export const DESKTOP_REMOTE_CHANGE_EVENT =
  "milady-desktop-remote-runtime-change";

export type DesktopRemoteRuntimeStatus =
  | "embedded"
  | "connecting"
  | "connected"
  | "error";

export interface DesktopRemoteRuntimeSnapshot {
  featureEnabled: boolean;
  remoteEnabled: boolean;
  status: DesktopRemoteRuntimeStatus;
  url: string | null;
  host: string | null;
  lastError: string | null;
  connectedAt: number | null;
}

function getLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function readEnabledFlag(raw: unknown): boolean {
  if (raw === true) return true;
  if (typeof raw !== "string") return false;
  const normalized = raw.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on"
  );
}

function readBuildTimeRemoteFlag(): boolean {
  try {
    const env = (
      import.meta as unknown as {
        env?: Record<string, string | boolean | undefined>;
      }
    ).env;
    if (readEnabledFlag(env?.MILADY_DESKTOP_REMOTE_MODE)) return true;
    if (readEnabledFlag(env?.VITE_MILADY_DESKTOP_REMOTE_MODE)) return true;
  } catch {
    /* import.meta unavailable in some test runners */
  }

  try {
    const globalFlag = (globalThis as Record<string, unknown>)
      .__MILADY_DESKTOP_REMOTE_MODE__;
    if (readEnabledFlag(globalFlag)) return true;
  } catch {
    /* ignore */
  }

  try {
    const processEnv = (globalThis as Record<string, unknown>).process as
      | { env?: Record<string, string | undefined> }
      | undefined;
    if (readEnabledFlag(processEnv?.env?.MILADY_DESKTOP_REMOTE_MODE)) {
      return true;
    }
  } catch {
    /* ignore */
  }

  return false;
}

export function normalizeDesktopRemoteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
    return parsed.origin.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

export function extractDesktopRemoteLaunchToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    const token =
      parsed.searchParams.get("launch") ??
      parsed.searchParams.get("token") ??
      parsed.searchParams.get("launchToken") ??
      parsed.hash.match(/(?:^#|[?&])launch=([^&]+)/)?.[1] ??
      null;
    return token ? decodeURIComponent(token).trim() || null : null;
  } catch {
    return trimmed;
  }
}

export function isDesktopRemoteRuntimeFeatureEnabled(): boolean {
  const storage = getLocalStorage();
  if (storage?.getItem(DESKTOP_REMOTE_ENABLED_KEY) === "1") return true;
  return readBuildTimeRemoteFlag();
}

function getConfiguredDesktopRemoteUrl(storage: Storage | null): string | null {
  if (!storage) return null;
  if (storage.getItem(DESKTOP_REMOTE_ENABLED_KEY) !== "1") return null;
  return normalizeDesktopRemoteUrl(
    storage.getItem(DESKTOP_REMOTE_URL_KEY) ?? "",
  );
}

export function getStoredDesktopRemoteApiBase(): string | null {
  const storage = getLocalStorage();
  const configuredUrl = getConfiguredDesktopRemoteUrl(storage);
  if (!configuredUrl) return null;
  return storage?.getItem(DESKTOP_REMOTE_STATUS_KEY) === "connected"
    ? configuredUrl
    : null;
}

export function getDesktopRemoteRuntimeSnapshot(): DesktopRemoteRuntimeSnapshot {
  const storage = getLocalStorage();
  const url = getConfiguredDesktopRemoteUrl(storage);
  const remoteEnabled = Boolean(url);
  const rawStatus = storage?.getItem(DESKTOP_REMOTE_STATUS_KEY) ?? null;
  const lastError = storage?.getItem(DESKTOP_REMOTE_ERROR_KEY) || null;
  const connectedAtRaw = storage?.getItem(DESKTOP_REMOTE_CONNECTED_AT_KEY);
  const connectedAt = connectedAtRaw
    ? Number.parseInt(connectedAtRaw, 10)
    : NaN;
  let status: DesktopRemoteRuntimeStatus = "embedded";
  if (remoteEnabled) {
    status =
      rawStatus === "connecting" || rawStatus === "error"
        ? rawStatus
        : lastError
          ? "error"
          : "connected";
  }

  let host: string | null = null;
  if (url) {
    try {
      host = new URL(url).host;
    } catch {
      host = null;
    }
  }

  return {
    featureEnabled: isDesktopRemoteRuntimeFeatureEnabled(),
    remoteEnabled,
    status,
    url,
    host,
    lastError,
    connectedAt: Number.isFinite(connectedAt) ? connectedAt : null,
  };
}

export function writeDesktopRemoteRuntimeState(next: {
  enabled?: boolean;
  url?: string | null;
  status?: DesktopRemoteRuntimeStatus;
  error?: string | null;
  connectedAt?: number | null;
}): void {
  const storage = getLocalStorage();
  if (!storage) return;

  if (next.enabled !== undefined) {
    if (next.enabled) storage.setItem(DESKTOP_REMOTE_ENABLED_KEY, "1");
    else storage.removeItem(DESKTOP_REMOTE_ENABLED_KEY);
  }

  if (next.url !== undefined) {
    const normalized = next.url ? normalizeDesktopRemoteUrl(next.url) : null;
    if (normalized) storage.setItem(DESKTOP_REMOTE_URL_KEY, normalized);
    else storage.removeItem(DESKTOP_REMOTE_URL_KEY);
  }

  if (next.status !== undefined) {
    if (next.status === "embedded")
      storage.removeItem(DESKTOP_REMOTE_STATUS_KEY);
    else storage.setItem(DESKTOP_REMOTE_STATUS_KEY, next.status);
  }

  if (next.error !== undefined) {
    if (next.error) storage.setItem(DESKTOP_REMOTE_ERROR_KEY, next.error);
    else storage.removeItem(DESKTOP_REMOTE_ERROR_KEY);
  }

  if (next.connectedAt !== undefined) {
    if (next.connectedAt) {
      storage.setItem(
        DESKTOP_REMOTE_CONNECTED_AT_KEY,
        String(next.connectedAt),
      );
    } else {
      storage.removeItem(DESKTOP_REMOTE_CONNECTED_AT_KEY);
    }
  }

  dispatchDesktopRemoteRuntimeChange();
}

export function clearDesktopRemoteRuntimeState(): void {
  const storage = getLocalStorage();
  if (!storage) return;
  storage.removeItem(DESKTOP_REMOTE_ENABLED_KEY);
  storage.removeItem(DESKTOP_REMOTE_URL_KEY);
  storage.removeItem(DESKTOP_REMOTE_STATUS_KEY);
  storage.removeItem(DESKTOP_REMOTE_ERROR_KEY);
  storage.removeItem(DESKTOP_REMOTE_CONNECTED_AT_KEY);
  dispatchDesktopRemoteRuntimeChange();
}

export function dispatchDesktopRemoteRuntimeChange(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(DESKTOP_REMOTE_CHANGE_EVENT));
}
