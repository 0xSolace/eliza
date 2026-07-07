/**
 * Facewear service coordinates active smartglasses services for shared device
 * discovery and capability reporting.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { Service } from "@elizaos/core";
import type { SmartglassesService } from "./smartglasses-service.ts";
import { SMARTGLASSES_SERVICE_NAME } from "./smartglasses-service.ts";

export const FACEWEAR_SERVICE_TYPE = "facewear";

export type FacewearActiveDevice = { kind: "smartglasses" } | null;

export class FacewearService extends Service {
	static override serviceType = FACEWEAR_SERVICE_TYPE;

	readonly capabilityDescription =
		"Unified facewear service — coordinates Even Realities G1/G2 smartglasses BLE state.";

	static override async start(runtime: IAgentRuntime): Promise<Service> {
		return new FacewearService(runtime);
	}

	override async stop(): Promise<void> {}

	getSmartglassesService(): SmartglassesService | undefined {
		return (this.runtime.getService<SmartglassesService>(
			SMARTGLASSES_SERVICE_NAME,
		) ?? undefined) as SmartglassesService | undefined;
	}

	getConnectedDevices(): Array<{
		id: string;
		kind: "smartglasses";
		deviceType?: string;
	}> {
		const devices: Array<{
			id: string;
			kind: "smartglasses";
			deviceType?: string;
		}> = [];
		const sgSvc = this.getSmartglassesService();
		if (sgSvc?.getStatus().connected) {
			devices.push({ id: "smartglasses", kind: "smartglasses" });
		}
		return devices;
	}

	hasActiveDevice(): boolean {
		return this.getConnectedDevices().length > 0;
	}
}
