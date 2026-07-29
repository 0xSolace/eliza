/**
 * Durable outbound-DM participation e2e at the REAL adapter seam.
 *
 * Boots a real PGLite-backed `AgentRuntime` via `@elizaos/test-harness` and
 * drives the REAL `DiscordService.handleSendMessage` outbound path. Only the
 * third-party `discord.js` SDK surface (Client, User, DMChannel) is faked — every
 * `ensureConnection`, participant row, room row, and memory write goes through
 * the product's real database adapter. No bot token, no discord.com, no network.
 *
 * What this proves, per the #17167 review:
 *
 *   1. After an entity-targeted DM send, BOTH the canonical recipient entity and
 *      the agent are durable participants of the EXACT runtime DM room derived
 *      from the Discord DM channel id.
 *   2. Participant-based recall (`getRoomsForParticipant`) finds that exact room
 *      for the recipient, and the persisted outbound memory is readable from it.
 *   3. When the Discord send fails AFTER recipient registration, the recipient
 *      participation survives (it is deliberately not rolled back) while no
 *      message memory is persisted.
 *   4. A guild-channel send does not add a DM-style recipient participant.
 */

import { createUniqueUuid, type UUID } from "@elizaos/core";
import { type MockLlmRuntime, withMockLlmRuntime } from "@elizaos/test-harness";
import { Collection, ChannelType as DiscordChannelType } from "discord.js";
import { afterEach, describe, expect, it } from "vitest";
import { DiscordService } from "../service.ts";
import type { DiscordSettings } from "../types.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		const cleanup = cleanups.pop();
		if (cleanup) await cleanup();
	}
});

function track(harness: MockLlmRuntime): MockLlmRuntime {
	cleanups.push(harness.cleanup);
	return harness;
}

const RECIPIENT_DISCORD_ID = "222222222222222222";
const DM_CHANNEL_ID = "888888888888888888";
const GUILD_CHANNEL_ID = "111111111111111111";
const GUILD_ID = "777777777777777777";
const BOT_ID = "999999999999999999";

interface SentPayload {
	channelId: string;
	content?: string;
}

/**
 * Build the REAL DiscordService over a faked discord.js client whose DM and
 * guild channels record what the connector pushes through `channel.send`.
 */
function makeOutboundFixture(
	runtime: MockLlmRuntime["runtime"],
	options: { failDmSendOnce?: boolean } = {},
) {
	const sent: SentPayload[] = [];
	let dmSendCalls = 0;

	const dmChannel = {
		id: DM_CHANNEL_ID,
		name: "recipient",
		type: DiscordChannelType.DM,
		isTextBased: () => true,
		isVoiceBased: () => false,
		isThread: () => false,
		send: async (payload: { content?: string }) => {
			dmSendCalls += 1;
			if (options.failDmSendOnce && dmSendCalls === 1) {
				throw new Error("discord 500 during DM delivery");
			}
			sent.push({ channelId: DM_CHANNEL_ID, content: payload.content });
			return {
				id: `55555555555555555${dmSendCalls}`,
				content: payload.content ?? "",
				url: `https://discord.com/channels/@me/${DM_CHANNEL_ID}/5`,
				createdTimestamp: Date.now(),
				attachments: new Collection(),
				author: { id: BOT_ID, username: "bot" },
			};
		},
	};

	const guild = { id: GUILD_ID, name: "Guild" };
	const guildChannel = {
		id: GUILD_CHANNEL_ID,
		name: "general",
		type: DiscordChannelType.GuildText,
		guild,
		parentId: null,
		isTextBased: () => true,
		isVoiceBased: () => false,
		isThread: () => false,
		send: async (payload: { content?: string }) => {
			sent.push({ channelId: GUILD_CHANNEL_ID, content: payload.content });
			return {
				id: "444444444444444444",
				content: payload.content ?? "",
				url: `https://discord.com/channels/${GUILD_ID}/${GUILD_CHANNEL_ID}/4`,
				createdTimestamp: Date.now(),
				attachments: new Collection(),
				author: { id: BOT_ID, username: "bot" },
			};
		},
	};

	const recipientUser = {
		id: RECIPIENT_DISCORD_ID,
		username: "recipient",
		displayName: "Recipient",
		globalName: "Recipient",
		bot: false,
		dmChannel,
		createDM: async () => dmChannel,
	};

	const client = {
		isReady: () => true,
		user: { id: BOT_ID, username: "bot", displayName: "Eliza" },
		users: {
			cache: new Collection([[recipientUser.id, recipientUser]]),
			fetch: async () => recipientUser,
		},
		channels: {
			cache: new Collection<string, unknown>([
				[DM_CHANNEL_ID, dmChannel],
				[GUILD_CHANNEL_ID, guildChannel],
			]),
			fetch: async (id: string) =>
				id === GUILD_CHANNEL_ID ? guildChannel : dmChannel,
		},
		guilds: { cache: new Collection([[guild.id, guild]]) },
	};

	const discordSettings = {
		shouldIgnoreDirectMessages: false,
		dmPolicy: "open",
	} as unknown as DiscordSettings;

	// `handleSendMessage` resolves its client through the account pool, so the
	// pool must hand back a state carrying the faked SDK client.
	const accountState = {
		accountId: "default",
		client,
		settings: discordSettings,
		allowedChannelIds: undefined,
		dynamicChannelIds: new Set<string>(),
		ownerDiscordUserIds: new Set<string>(),
		clientReadyPromise: Promise.resolve(),
	};

	// REAL DiscordService prototype methods over a faked SDK client.
	const service = Object.assign(Object.create(DiscordService.prototype), {
		runtime,
		client,
		accountId: "default",
		defaultAccountId: "default",
		discordSettings,
		allowedChannelIds: undefined,
		dynamicChannelIds: new Set<string>(),
		ownerDiscordUserIds: new Set<string>(),
		accountPool: {
			get: () => accountState,
			getDefault: () => accountState,
			listAccountIds: () => ["default"],
		},
	}) as DiscordService & { resolveDiscordEntityId(id: string): UUID };

	return { client, dmChannel, guildChannel, recipientUser, sent, service };
}

describe("outbound Discord DM participation (real PGLite adapter)", () => {
	it("makes the canonical recipient and the agent durable participants of the exact DM room and keeps the message recallable", async () => {
		const harness = track(await withMockLlmRuntime({ strict: false }));
		const { runtime } = harness;
		const { dmChannel, sent, service } = makeOutboundFixture(runtime);

		const text = "durable outbound DM participation";
		const persisted = await service.handleSendMessage(
			runtime as never,
			{
				source: "discord",
				entityId: RECIPIENT_DISCORD_ID as UUID,
			},
			{ text },
		);

		// The message really went out through the connector's outbound seam.
		expect(sent).toEqual([{ channelId: DM_CHANNEL_ID, content: text }]);

		// The EXACT runtime DM room is the one derived from the DM channel id.
		const dmRoomId = createUniqueUuid(runtime, dmChannel.id) as UUID;
		const recipientEntityId =
			service.resolveDiscordEntityId(RECIPIENT_DISCORD_ID);

		// Durable participants, read back from the real adapter.
		const participants = await runtime.getParticipantsForRoom(dmRoomId);
		expect(participants).toContain(recipientEntityId);
		expect(participants).toContain(runtime.agentId);

		// Participant-based recall resolves the exact DM room for the recipient.
		const recipientRooms =
			await runtime.getRoomsForParticipant(recipientEntityId);
		expect(recipientRooms).toContain(dmRoomId);

		// The room row itself is durable and bound to the Discord DM channel.
		const room = await runtime.getRoom(dmRoomId);
		expect(room).toMatchObject({
			id: dmRoomId,
			channelId: dmChannel.id,
			source: "discord",
		});

		// The outbound memory persisted into that same room and is readable.
		expect(persisted).toMatchObject({ roomId: dmRoomId });
		const memories = await runtime.getMemories({
			roomId: dmRoomId,
			tableName: "messages",
			count: 10,
		});
		expect(memories.some((memory) => memory.content?.text === text)).toBe(true);
	});

	it("keeps recipient participation durable when the Discord send fails after registration", async () => {
		const harness = track(await withMockLlmRuntime({ strict: false }));
		const { runtime } = harness;
		const { dmChannel, sent, service } = makeOutboundFixture(runtime, {
			failDmSendOnce: true,
		});

		await expect(
			service.handleSendMessage(
				runtime as never,
				{ source: "discord", entityId: RECIPIENT_DISCORD_ID as UUID },
				{ text: "delivery fails after registration" },
			),
		).rejects.toThrow("discord 500 during DM delivery");

		expect(sent).toEqual([]);

		const dmRoomId = createUniqueUuid(runtime, dmChannel.id) as UUID;
		const recipientEntityId =
			service.resolveDiscordEntityId(RECIPIENT_DISCORD_ID);

		// Registration is intentionally NOT rolled back: an empty DM room is
		// preferable to losing recipient identity, and a concurrent send or
		// inbound message may already depend on this participant row.
		const participants = await runtime.getParticipantsForRoom(dmRoomId);
		expect(participants).toContain(recipientEntityId);

		// Nothing was persisted for a message that never reached Discord.
		const memories = await runtime.getMemories({
			roomId: dmRoomId,
			tableName: "messages",
			count: 10,
		});
		expect(memories).toHaveLength(0);
	});

	it("does not add a DM recipient participant for a guild channel send", async () => {
		const harness = track(await withMockLlmRuntime({ strict: false }));
		const { runtime } = harness;
		const { guildChannel, sent, service } = makeOutboundFixture(runtime);

		const text = "guild send non-regression";
		await service.handleSendMessage(
			runtime as never,
			{ source: "discord", channelId: GUILD_CHANNEL_ID },
			{ text },
		);

		expect(sent).toEqual([{ channelId: GUILD_CHANNEL_ID, content: text }]);

		const guildRoomId = createUniqueUuid(runtime, guildChannel.id) as UUID;
		const recipientEntityId =
			service.resolveDiscordEntityId(RECIPIENT_DISCORD_ID);

		// Only the agent participates from an outbound guild send; the DM
		// recipient path must not leak a participant into a guild room.
		const participants = await runtime.getParticipantsForRoom(guildRoomId);
		expect(participants).toContain(runtime.agentId);
		expect(participants).not.toContain(recipientEntityId);
	});
});
