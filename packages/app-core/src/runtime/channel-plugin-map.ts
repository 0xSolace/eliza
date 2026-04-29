const UPSTREAM_CHANNEL_PLUGIN_MAP = {
  bluebubbles: "@elizaos/plugin-bluebubbles",
  discord: "@elizaos/plugin-discord",
  discordLocal: "@elizaos/plugin-discord-local",
  telegram: "@elizaos/plugin-telegram",
  slack: "@elizaos/plugin-slack",
  twitter: "@elizaos/plugin-twitter",
  whatsapp: "@elizaos/plugin-whatsapp",
  signal: "@elizaos/plugin-signal",
  imessage: "@elizaos/plugin-imessage",
  farcaster: "@elizaos/plugin-farcaster",
  lens: "@elizaos/plugin-lens",
  msteams: "@elizaos/plugin-msteams",
  feishu: "@elizaos/plugin-feishu",
  matrix: "@elizaos/plugin-matrix",
  nostr: "@elizaos/plugin-nostr",
  blooio: "@elizaos/plugin-blooio",
  twitch: "@elizaos/plugin-twitch",
  mattermost: "@elizaos/plugin-mattermost",
  googlechat: "@elizaos/plugin-google-chat",
} as const;

const INTERNAL_CHANNEL_PLUGIN_OVERRIDES = {
  signal: "@elizaos/plugin-signal",
  twitter: "@elizaos/plugin-twitter",
  whatsapp: "@elizaos/plugin-whatsapp",
} as const;

export const CHANNEL_PLUGIN_MAP = {
  ...UPSTREAM_CHANNEL_PLUGIN_MAP,
  ...INTERNAL_CHANNEL_PLUGIN_OVERRIDES,
};
