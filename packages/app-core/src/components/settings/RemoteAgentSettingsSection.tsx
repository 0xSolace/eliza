import { Button, Checkbox, cn, Input, Label, Spinner } from "@elizaos/ui";
import { Wifi, WifiOff } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../api";
import {
  clearDesktopRemoteRuntimeState,
  DESKTOP_REMOTE_CHANGE_EVENT,
  type DesktopRemoteRuntimeSnapshot,
  extractDesktopRemoteLaunchToken,
  getDesktopRemoteRuntimeSnapshot,
  normalizeDesktopRemoteUrl,
  writeDesktopRemoteRuntimeState,
} from "../../platform/desktop-remote-runtime";

function readSnapshot(): DesktopRemoteRuntimeSnapshot {
  return getDesktopRemoteRuntimeSnapshot();
}

function buildLaunchExchangeUrl(
  remoteBase: string,
  launchToken: string,
): string {
  const launchUrl = new URL("/", remoteBase);
  launchUrl.searchParams.set("launch", launchToken);
  return launchUrl.toString();
}

async function exchangeLaunchTokenForCookie(args: {
  remoteBase: string;
  launchToken: string;
}): Promise<void> {
  const response = await fetch(
    buildLaunchExchangeUrl(args.remoteBase, args.launchToken),
    {
      method: "GET",
      credentials: "include",
      redirect: "follow",
      cache: "no-store",
    },
  );

  if (!response.ok) {
    throw new Error(`Launch exchange failed: HTTP ${response.status}`);
  }
}

export function RemoteAgentSettingsSection() {
  const [snapshot, setSnapshot] = useState<DesktopRemoteRuntimeSnapshot>(() =>
    readSnapshot(),
  );
  const [enabledDraft, setEnabledDraft] = useState(snapshot.featureEnabled);
  const [remoteUrl, setRemoteUrl] = useState(snapshot.url ?? "");
  const [launchToken, setLaunchToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const refreshSnapshot = useCallback(() => {
    const next = readSnapshot();
    setSnapshot(next);
    setEnabledDraft(next.featureEnabled);
    if (next.url) setRemoteUrl(next.url);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key.startsWith("milady_desktop_remote_")) {
        refreshSnapshot();
      }
    };
    window.addEventListener(DESKTOP_REMOTE_CHANGE_EVENT, refreshSnapshot);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(DESKTOP_REMOTE_CHANGE_EVENT, refreshSnapshot);
      window.removeEventListener("storage", onStorage);
    };
  }, [refreshSnapshot]);

  const statusLabel = useMemo(() => {
    if (snapshot.status === "connected" && snapshot.host) {
      return `Connected to ${snapshot.host}`;
    }
    if (snapshot.status === "connecting") return "Connecting…";
    if (snapshot.status === "error") return "Disconnected with error";
    return "Local embedded runtime";
  }, [snapshot.host, snapshot.status]);

  const handleEnabledChange = useCallback((checked: boolean) => {
    setEnabledDraft(checked);
    if (checked) {
      writeDesktopRemoteRuntimeState({ enabled: true });
      return;
    }
    clearDesktopRemoteRuntimeState();
    client.setBaseUrl(null);
    window.setTimeout(() => window.location.reload(), 50);
  }, []);

  const handleConnect = useCallback(async () => {
    setLocalError(null);
    const normalizedUrl = normalizeDesktopRemoteUrl(remoteUrl);
    if (!normalizedUrl) {
      setLocalError("Enter a valid http(s) remote URL.");
      return;
    }

    const token = extractDesktopRemoteLaunchToken(launchToken);
    if (!token) {
      setLocalError("Paste a launch token or launch URL.");
      return;
    }

    setBusy(true);
    writeDesktopRemoteRuntimeState({
      enabled: true,
      url: normalizedUrl,
      status: "connecting",
      error: null,
    });

    try {
      await exchangeLaunchTokenForCookie({
        remoteBase: normalizedUrl,
        launchToken: token,
      });
      client.setToken(null);
      client.setBaseUrl(normalizedUrl);
      writeDesktopRemoteRuntimeState({
        enabled: true,
        url: normalizedUrl,
        status: "connected",
        error: null,
        connectedAt: Date.now(),
      });
      window.setTimeout(() => window.location.reload(), 75);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLocalError(message);
      writeDesktopRemoteRuntimeState({
        enabled: true,
        url: normalizedUrl,
        status: "error",
        error: message,
      });
    } finally {
      setBusy(false);
      refreshSnapshot();
    }
  }, [launchToken, refreshSnapshot, remoteUrl]);

  const handleDisconnect = useCallback(() => {
    clearDesktopRemoteRuntimeState();
    client.setToken(null);
    client.setBaseUrl(null);
    window.setTimeout(() => window.location.reload(), 50);
  }, []);

  const currentError = localError ?? snapshot.lastError;
  const statusTone = snapshot.status;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-txt">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              "mt-1 h-2.5 w-2.5 shrink-0 rounded-full",
              statusTone === "connected"
                ? "bg-ok"
                : statusTone === "connecting"
                  ? "bg-warning"
                  : statusTone === "error"
                    ? "bg-danger"
                    : "bg-muted",
            )}
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-txt-strong">
              Remote Agent (Experimental)
            </div>
            <div className="mt-1 text-xs leading-relaxed text-muted">
              Toy desktop thin-client mode. Default is still the embedded local
              runtime; connect only when you have a remote launch token.
            </div>
            <div className="mt-2 inline-flex items-center gap-2 rounded-full border border-border/60 bg-bg/60 px-2.5 py-1 text-xs text-muted">
              {snapshot.remoteEnabled ? (
                <Wifi className="h-3.5 w-3.5 text-ok" />
              ) : (
                <WifiOff className="h-3.5 w-3.5" />
              )}
              {statusLabel}
            </div>
          </div>
        </div>
      </div>

      <Label className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/50 p-3 text-sm font-normal text-txt">
        <Checkbox
          checked={enabledDraft}
          onCheckedChange={(checked: boolean | "indeterminate") =>
            handleEnabledChange(checked === true)
          }
        />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-txt-strong">
            Connect to remote agent
          </span>
          <span className="block text-xs text-muted">
            Stores this preference locally and reloads the renderer after
            connect/disconnect.
          </span>
        </span>
      </Label>

      {enabledDraft ? (
        <div className="grid gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="desktop-remote-agent-url" className="text-xs">
              Remote URL
            </Label>
            <Input
              id="desktop-remote-agent-url"
              type="url"
              inputMode="url"
              placeholder="https://nyx.shad0w.xyz"
              value={remoteUrl}
              onChange={(event) => setRemoteUrl(event.target.value)}
              disabled={busy}
              className="rounded-lg bg-bg"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="desktop-remote-agent-launch" className="text-xs">
              Launch token or launch URL
            </Label>
            <Input
              id="desktop-remote-agent-launch"
              type="password"
              placeholder="Paste launch token or https://…/?launch=…"
              value={launchToken}
              onChange={(event) => setLaunchToken(event.target.value)}
              disabled={busy}
              className="rounded-lg bg-bg"
            />
          </div>

          {currentError ? (
            <div
              className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
              role="alert"
            >
              {currentError}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            {snapshot.remoteEnabled ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="min-h-[2.625rem] rounded-[calc(var(--radius-lg)+2px)] px-4"
                onClick={handleDisconnect}
                disabled={busy}
              >
                Disconnect
              </Button>
            ) : null}
            <Button
              type="button"
              variant="default"
              size="sm"
              className="min-h-[2.625rem] rounded-[calc(var(--radius-lg)+2px)] px-4"
              onClick={() => void handleConnect()}
              disabled={busy}
            >
              {busy ? <Spinner size={16} /> : null}
              Connect
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
