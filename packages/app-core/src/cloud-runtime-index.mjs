// Server-safe root barrel for @elizaos/app-core in Node/cloud runtime.
// Browser/React exports remain available via the browser/default package export.
export {
  RESTART_EXIT_CODE,
  requestRestart,
  setRestartHandler,
} from '@elizaos/shared';
export * from './api/auth.ts';
export * from './api/compat-route-shared.ts';
export * from './api/response.ts';
export * from './events/index.ts';
export * from './bridge/index.ts';
export * from './security/agent-vault-id.ts';
export * from './security/platform-secure-store.ts';
export * from './security/platform-secure-store-node.ts';
export * from './components/inventory/constants.ts';
export * from './utils/index.ts';
export function mirrorCompatHeaders(req) {
  const aliases = [
    ['x-elizaos-token', 'x-eliza-token'],
    ['x-elizaos-export-token', 'x-eliza-export-token'],
    ['x-elizaos-client-id', 'x-eliza-client-id'],
    ['x-elizaos-terminal-token', 'x-eliza-terminal-token'],
    ['x-elizaos-ui-language', 'x-eliza-ui-language'],
    ['x-elizaos-agent-action', 'x-eliza-agent-action'],
  ];
  for (const [appHeader, elizaHeader] of aliases) {
    const appValue = req?.headers?.[appHeader];
    const elizaValue = req?.headers?.[elizaHeader];
    if (appValue != null && elizaValue == null) req.headers[elizaHeader] = appValue;
    if (elizaValue != null && appValue == null) req.headers[appHeader] = elizaValue;
  }
}
