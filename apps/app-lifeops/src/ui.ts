// Browser-only LifeOps entry point. React components, hooks, widgets, and
// client augmentations belong here instead of the package root.

export * from "./components/AppBlockerSettingsCard.tsx";
export {
  BrowserBridgeSetupPanel,
  BrowserBridgeSetupPanel as LifeOpsBrowserSetupPanel,
} from "./components/BrowserBridgeSetupPanel.tsx";
export { LifeOpsActivitySignalsEffect } from "./components/LifeOpsActivitySignalsEffect.tsx";
export * from "./components/LifeOpsPageSections.tsx";
export * from "./components/LifeOpsPageView.tsx";
export * from "./components/LifeOpsSettingsSection.tsx";
export * from "./components/LifeOpsWorkspaceView.tsx";
export * from "./components/WebsiteBlockerSettingsCard.tsx";
export * from "./platform/index.ts";
export type {
  AppBlockerSettingsCardProps,
  AppBlockerSettingsMode,
  WebsiteBlockerSettingsCardProps,
  WebsiteBlockerSettingsMode,
} from "./types/index.ts";
