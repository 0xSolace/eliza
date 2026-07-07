/**
 * Facewear debug action reports smartglasses and coordinator diagnostics for
 * connected wearable devices.
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
import { SMARTGLASSES_SERVICE_NAME } from "../services/smartglasses-service.ts";

export const facewearDebugAction: Action = {
	name: "FACEWEAR_DEBUG",
	description: "Show diagnostics for all connected facewear devices.",
	similes: [
		"DEBUG_GLASSES",
		"DIAGNOSE_HEADSET",
		"FACEWEAR_DIAGNOSTICS",
		"CHECK_SMARTGLASSES",
	],
	examples: [
		[
			{ name: "{{user1}}", content: { text: "Debug my smartglasses" } },
			{
				name: "{{user2}}",
				content: {
					text: "Smartglasses service is running. No active connection.",
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
		const lines: string[] = ["**Facewear Diagnostics**\n"];

		const sgSvc = runtime.getService(SMARTGLASSES_SERVICE_NAME);
		if (sgSvc) {
			lines.push(`**Smartglasses Service:** running`);
		} else {
			lines.push("**Smartglasses Service:** not running");
		}

		const fwSvc = runtime.getService<FacewearService>(FACEWEAR_SERVICE_TYPE);
		if (fwSvc) {
			const devices = fwSvc.getConnectedDevices();
			lines.push(`**Active Devices:** ${devices.length}`);
		}

		await callback?.({ text: lines.join("\n") });
		return { success: true };
	},
};
