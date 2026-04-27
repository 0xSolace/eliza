/**
 * Empty stub for Node built-in subpaths that don't exist in browser polyfills.
 * Server-only code imports these but they're never executed in the browser.
 *
 * Each named export is a no-op so esbuild's dep scanner doesn't choke.
 */

// util/types
export const isArrayBuffer = () => false;
export const isTypedArray = () => false;

// stream/promises
export const pipeline = () => {};
export const finished = () => {};

// stream/web — re-export the global Web Streams if available
export const ReadableStream =
  typeof globalThis !== "undefined" ? globalThis.ReadableStream : class {};
export const WritableStream =
  typeof globalThis !== "undefined" ? globalThis.WritableStream : class {};
export const TransformStream =
  typeof globalThis !== "undefined" ? globalThis.TransformStream : class {};

// @elizaos/agent browser fallback
export const createIntegrationTelemetrySpan = () => ({
  success: () => {},
  failure: () => {},
});
export const loadElizaConfig = () => ({
  agents: {},
  meta: {},
  ui: {},
});
export const saveElizaConfig = async () => {};
export const persistConfigEnv = async () => {};
export const resolveStateDir = () => ".";
export const resolveWalletExportRejection = () => null;
export const resolvePluginEvmLoaded = () => false;
export const resolveWalletAutomationMode = () => "off";
export const resolveWalletCapabilityStatus = () => ({
  available: false,
  enabled: false,
  automationMode: "off",
});
export const VERSION = "0.0.0-browser-stub";
export const CONNECTOR_PLUGINS = {};
export const AUTH_PROVIDER_PLUGINS = {};
export const STREAMING_PLUGINS = {};
export const applyPluginAutoEnable = (params) => ({ config: params?.config });
export const applyPluginSelfDeclaredAutoEnable = (params) => ({
  config: params?.config,
});
export const isConnectorConfigured = () => false;
export const isStreamingDestinationConfigured = () => false;
export const hasAdminAccess = async () => false;
export const hasOwnerAccess = async () => false;
export const hasPrivateAccess = async () => false;
export const extractActionParamsViaLlm = async () => ({});
export const checkRateLimit = () => ({ allowed: true, remaining: 1, resetAt: 0 });
export const readJsonBody = async () => ({});
export const sendJson = (res, data, status = 200) => {
  if (res) res.statusCode = status;
  if (typeof res?.end === "function") res.end(JSON.stringify(data ?? {}));
};
export const sendJsonError = (res, message = "error", status = 400) =>
  sendJson(res, { error: message }, status);
export const decodePathComponent = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const DEFAULT_WALLET_RPC_SELECTIONS = {
  evm: "eliza-cloud",
  bsc: "eliza-cloud",
  solana: "eliza-cloud",
};

const WALLET_RPC_PROVIDER_ALIASES = {
  elizacloud: "eliza-cloud",
  helius: "helius-birdeye",
};

const WALLET_RPC_PROVIDER_IDS = {
  evm: new Set(["eliza-cloud", "alchemy", "infura", "ankr"]),
  bsc: new Set(["eliza-cloud", "alchemy", "ankr", "nodereal", "quicknode"]),
  solana: new Set(["eliza-cloud", "helius-birdeye"]),
};

function normalizeWalletRpcProviderId(chain, value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const normalized = WALLET_RPC_PROVIDER_ALIASES[trimmed] ?? trimmed;
  return WALLET_RPC_PROVIDER_IDS[chain]?.has(normalized) ? normalized : null;
}

export function normalizeWalletRpcSelections(input) {
  return {
    evm:
      normalizeWalletRpcProviderId("evm", input?.evm) ??
      DEFAULT_WALLET_RPC_SELECTIONS.evm,
    bsc:
      normalizeWalletRpcProviderId("bsc", input?.bsc) ??
      DEFAULT_WALLET_RPC_SELECTIONS.bsc,
    solana:
      normalizeWalletRpcProviderId("solana", input?.solana) ??
      DEFAULT_WALLET_RPC_SELECTIONS.solana,
  };
}

export class TelegramClient {}
export const Api = {};
export class StringSession {
  constructor(public value = "") {}
}

export default {};
