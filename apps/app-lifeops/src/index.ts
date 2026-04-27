// Server-safe public entry point for @elizaos/app-lifeops.
//
// The browser UI surface lives in ./ui and ./client. Keep this root free of
// React components, hooks, widgets, and app-core UI barrels so Node plugin
// loading can import @elizaos/app-lifeops without evaluating browser modules.

export { calendarAction } from "./actions/calendar.ts";
export { gmailAction } from "./actions/gmail.ts";
export { inboxAction } from "./actions/inbox.ts";
export * from "./contracts/index.ts";
export { detectHealthBackend } from "./lifeops/health-bridge.ts";
export { detectPasswordManagerBackend } from "./lifeops/password-manager-bridge.ts";
export { detectRemoteDesktopBackend } from "./lifeops/remote-desktop.ts";
export { LifeOpsService, LifeOpsServiceError } from "./lifeops/service.ts";
export * from "./platform/index.ts";
export {
  type CloudFeaturesRouteState,
  handleCloudFeaturesRoute,
} from "./routes/cloud-features-routes.ts";
export {
  handleTravelProviderRelayRoute,
  type TravelProviderRelayRouteState,
} from "./routes/travel-provider-relay-routes.ts";
export * from "./plugin.ts";
export { lifeopsPlugin } from "./routes/plugin.ts";
export {
  getAppBlockerPermissionState,
  getAppBlockerStatus,
  getCachedAppBlockerStatus,
  getInstalledApps,
  requestAppBlockerPermission,
  selectAppsForBlocking,
  startAppBlock,
  stopAppBlock,
} from "./app-blocker/engine.ts";
export type {
  AppBlockerSettingsCardProps,
  AppBlockerSettingsMode,
  WebsiteBlockerSettingsCardProps,
  WebsiteBlockerSettingsMode,
} from "./types/index.ts";
export * from "./website-blocker/public.ts";
