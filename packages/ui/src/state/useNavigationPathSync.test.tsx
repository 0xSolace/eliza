// @vitest-environment jsdom

// Regression for the app-shell deep-link boot race. App-shell pages are loaded
// from idle-scheduled side-effect modules (main.tsx
// `scheduleSideEffectAppModuleLoads`). A deep link or page refresh can therefore
// boot before the matching registration exists; `tabFromPath` then falls through
// to the `apps` catalog. Without registry reactivity that misresolution is
// sticky (the sync effect only re-runs on tab/navigation change), so the page
// renders the apps grid instead of the deep-linked view forever.
// `useNavigationPathSync` now re-resolves the active tab when the app-shell
// registry version bumps.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerAppShellPage } from "../app-shell-registry";
import type { Tab } from "../navigation";
import { resetUiRegistryHostForTests } from "../registry-host";
import { useNavigationPathSync } from "./useAppProviderEffects";

afterEach(() => {
  resetUiRegistryHostForTests();
  window.history.replaceState(null, "", "/");
});

describe("useNavigationPathSync — app-shell registry reactivity", () => {
  it("reconciles the active tab when a deep-linked app-shell page registers late", () => {
    window.history.replaceState(null, "", "/apps/custom-panel");

    const setTabRaw = vi.fn();
    // Boot landed on the apps catalog: `/apps/custom-panel` has no
    // registration yet, so `tabFromPath` resolves it to "apps".
    renderHook(() => useNavigationPathSync({ tab: "apps" as Tab, setTabRaw }));
    expect(setTabRaw).not.toHaveBeenCalledWith("custom-panel");

    // The idle-loaded side-effect module finally registers the page.
    act(() => {
      registerAppShellPage({
        id: "custom-panel",
        pluginId: "@elizaos/plugin-custom-panel",
        label: "Custom Panel",
        path: "/apps/custom-panel",
        loader: async () => ({ default: () => null }),
      });
    });

    // The registry-version bump re-runs the sync effect, which now resolves the
    // URL to the real page and reconciles the active tab.
    expect(setTabRaw).toHaveBeenCalledWith("custom-panel");
  });

  it("leaves the tab alone when the URL already matches the active tab", () => {
    // Page already registered (no race) and the active tab already matches the
    // URL: the sync effect must not dispatch a redundant reconciliation.
    registerAppShellPage({
      id: "custom-panel",
      pluginId: "@elizaos/plugin-custom-panel",
      label: "Custom Panel",
      path: "/apps/custom-panel",
      loader: async () => ({ default: () => null }),
    });
    window.history.replaceState(null, "", "/apps/custom-panel");

    const setTabRaw = vi.fn();
    renderHook(() =>
      useNavigationPathSync({ tab: "custom-panel" as Tab, setTabRaw }),
    );

    // routeTab === tab, so no redundant reconciliation is dispatched.
    expect(setTabRaw).not.toHaveBeenCalled();
  });
});
