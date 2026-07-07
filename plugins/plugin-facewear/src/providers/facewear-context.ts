/**
 * Facewear context provider injects connected smartglasses state into the agent
 * prompt.
 */
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	ProviderValue,
	State,
} from "@elizaos/core";
import type { SmartglassesService } from "../services/smartglasses-service.ts";
import { SMARTGLASSES_SERVICE_NAME } from "../services/smartglasses-service.ts";

export const facewearContextProvider: Provider = {
	name: "facewearContext",
	description: "Provides context about connected Even Realities smartglasses.",

	get: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		const sgSvc = runtime.getService<SmartglassesService>(
			SMARTGLASSES_SERVICE_NAME,
		);

		const hasSmartglasses = sgSvc?.getStatus().connected ?? false;

		if (!hasSmartglasses) return { text: "" };

		const lines: string[] = [];
		const values: Record<string, ProviderValue> = {};

		if (hasSmartglasses && sgSvc) {
			const status = sgSvc.getStatus();
			lines.push(
				`[Smartglasses connected: ${status.transport ?? "unknown transport"}]`,
			);
			if (status.microphoneEnabled) {
				lines.push(`[Smartglasses microphone is active.]`);
			}

			values.smartglassesConnected = true;
			values.smartglassesTransport = status.transport;
			values.smartgrassesMicEnabled = status.microphoneEnabled;
		}

		return {
			text: lines.join("\n"),
			values,
		};
	},
};
