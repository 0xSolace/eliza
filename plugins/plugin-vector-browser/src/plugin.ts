import type { Plugin } from "@elizaos/core";

/**
 * Vector browser plugin.
 *
 * Contributes the heavy three.js (WebGL) vector-browser surface as a
 * dynamically loaded view so neither the component nor three ship in the
 * always-loaded @elizaos/ui bundle. The view is served by the agent router at
 * `/api/views/vector-browser/bundle.js` and mounted by the shell's
 * DynamicViewLoader.
 *
 * One adaptive `componentExport` (`VectorBrowserView`) wraps the rich surface in
 * a spatial `Escape` and renders the full DOM/WebGL experience in the app. The
 * lightweight `VectorBrowserSpatialView` remains exported as a future adapter
 * seam, but no concrete alternate renderer is registered or mounted.
 */
export const vectorBrowserPlugin: Plugin = {
  name: "@elizaos/plugin-vector-browser",
  description:
    "Vector/memory browser with list, 2D projection, and 3D (WebGL) views",
  views: [
    {
      id: "vector-browser",
      label: "Vector Browser",
      developerOnly: true,
      description:
        "Browse agent memories and visualise their embeddings as a 2D or 3D projection",
      icon: "ScatterChart",
      path: "/vector-browser",
      modalities: ["gui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "VectorBrowserView",
      tags: ["memory", "embeddings", "vectors", "database"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};
