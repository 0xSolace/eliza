/**
 * Facewear connection action returns setup instructions for Even Realities
 * smartglasses.
 */
import type {
	Action,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import {
	FACEWEAR_SERVICE_TYPE,
	type FacewearService,
} from "../services/facewear-service.ts";

export const facewearConnectAction: Action = {
	name: "FACEWEAR_CONNECT",
	description: "Show connection instructions for Even Realities smartglasses.",
	similes: ["CONNECT_GLASSES", "PAIR_DEVICE", "CONNECT_FACEWEAR"],
	examples: [
		[
			{
				name: "{{user1}}",
				content: { text: "How do I connect my G1 glasses?" },
			},
			{
				name: "{{user2}}",
				content: {
					text: "Enable Bluetooth, put on the glasses, and let the elizaOS smartglasses service pair over BLE.",
				},
			},
		],
	],
	validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state: State | undefined,
		_options: Record<string, unknown> | undefined,
		callback?: HandlerCallback,
	) => {
		const svc = runtime.getService<FacewearService>(FACEWEAR_SERVICE_TYPE);
		const connected = svc?.getConnectedDevices() ?? [];

		let instructions = "**Even Realities G1/G2**\n\n";
		instructions += "**Connection method:** Bluetooth BLE\n";
		instructions += "1. Enable Bluetooth on your phone/computer\n";
		instructions += "2. Put on your Even Realities glasses\n";
		instructions +=
			"3. The elizaOS agent will auto-detect via Noble BLE or Web Bluetooth\n";
		instructions +=
			"4. For native Android: install the Even Realities companion app\n";
		if (connected.length > 0) {
			instructions += `\n**Currently connected:** ${connected.map((d) => d.deviceType ?? d.kind).join(", ")}`;
		}

		await callback?.({ text: instructions });
		return { success: true };
	},
};
