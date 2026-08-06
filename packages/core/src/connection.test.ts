/**
 * Exercises connection reconciliation against the production in-memory adapter,
 * including durable shared-world role metadata across sequential callers.
 */
import { describe, expect, it } from "vitest";
import { ensureConnection } from "./connection";
import { InMemoryDatabaseAdapter } from "./database/inMemoryAdapter";
import { recordOwnerGrant, recordRoleGrant } from "./roles";
import { stringToUuid } from "./utils";

describe("ensureConnection", () => {
	it("preserves existing role grants when another caller reconciles", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const agentId = stringToUuid("connection-role-agent");
		const ownerId = stringToUuid("connection-role-owner");
		const firstCallerId = stringToUuid("connection-role-first-caller");
		const secondCallerId = stringToUuid("connection-role-second-caller");
		const worldId = stringToUuid("connection-role-world");
		const messageServerId = stringToUuid("connection-role-server");

		const reconcile = async (callerId: typeof firstCallerId) => {
			await ensureConnection(adapter, {
				agentId,
				entityId: callerId,
				roomId: stringToUuid(`connection-role-room-${callerId}`),
				worldId,
				messageServerId,
				source: "client_chat",
				channelId: `connection-role-channel-${callerId}`,
				metadata: {
					ownership: { ownerId },
					waifuRole: "USER",
				},
			});

			const [world] = await adapter.getWorldsByIds([worldId]);
			if (!world?.metadata) throw new Error("reconciled world is missing");
			recordOwnerGrant(world.metadata, ownerId);
			recordRoleGrant(world.metadata, callerId, "USER", "connector_admin");
			await adapter.updateWorlds([world]);
		};

		await reconcile(firstCallerId);
		await reconcile(secondCallerId);

		const [world] = await adapter.getWorldsByIds([worldId]);
		expect(world?.metadata?.roles).toMatchObject({
			[ownerId]: "OWNER",
			[firstCallerId]: "USER",
			[secondCallerId]: "USER",
		});
		expect(world?.metadata?.roleSources).toMatchObject({
			[ownerId]: "owner",
			[firstCallerId]: "connector_admin",
			[secondCallerId]: "connector_admin",
		});
	});

	it("preserves the persisted room name when a reconnect omits roomName", async () => {
		// Regression: web-chat conversation titles live in room.name (the boot-time
		// conversation restore rebuilds ConversationMeta.title from it). Every
		// message send re-runs ensureConnection WITHOUT roomName, and the old code
		// built the room row with the literal fallback name "default" — stomping
		// the stored title on full-replace adapters, so every thread collapsed to
		// "default" after a relaunch (sol-dev history divergence, 2026-08-06).
		const adapter = new InMemoryDatabaseAdapter();
		const agentId = stringToUuid("room-name-agent");
		const callerId = stringToUuid("room-name-caller");
		const worldId = stringToUuid("room-name-world");
		const messageServerId = stringToUuid("room-name-server");
		const roomId = stringToUuid("room-name-room");

		// A named create (what syncConversationRoomState persists via updateRoom).
		await ensureConnection(adapter, {
			agentId,
			entityId: callerId,
			roomId,
			roomName: "My Renamed Chat",
			worldId,
			messageServerId,
			source: "client_chat",
			channelId: `web-conv-${roomId}`,
		});

		// A later message-send reconnect that does not carry a name.
		await ensureConnection(adapter, {
			agentId,
			entityId: callerId,
			roomId,
			worldId,
			messageServerId,
			source: "client_chat",
			channelId: `web-conv-${roomId}`,
		});

		const [room] = await adapter.getRoomsByIds([roomId]);
		expect(room?.name).toBe("My Renamed Chat");
	});

	it("still names a genuinely new room 'default' when no name is provided", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const agentId = stringToUuid("room-default-agent");
		const callerId = stringToUuid("room-default-caller");
		const worldId = stringToUuid("room-default-world");
		const messageServerId = stringToUuid("room-default-server");
		const roomId = stringToUuid("room-default-room");

		await ensureConnection(adapter, {
			agentId,
			entityId: callerId,
			roomId,
			worldId,
			messageServerId,
			source: "client_chat",
			channelId: `web-conv-${roomId}`,
		});

		const [room] = await adapter.getRoomsByIds([roomId]);
		expect(room?.name).toBe("default");
	});
});
