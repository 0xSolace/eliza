/**
 * Facewear plugin registration wires Even Realities smartglasses control,
 * device configuration routes, providers, and services into elizaOS.
 */
import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { displayFacewearTextAction } from "./actions/display-text.ts";
import { facewearConnectAction } from "./actions/facewear-connect.ts";
import { facewearControlAction } from "./actions/facewear-control.ts";
import { facewearDebugAction } from "./actions/facewear-debug.ts";
import { facewearStatusAction } from "./actions/facewear-status.ts";
import { facewearMicrophoneAction } from "./actions/microphone.ts";
import { facewearContextProvider } from "./providers/facewear-context.ts";
import { smartglassesStatusProvider } from "./providers/smartglasses-status.ts";
import {
	facewearDeviceRoute,
	facewearDevicesRoute,
	facewearStatusRoute,
} from "./routes/device-config.ts";
import { FacewearService } from "./services/facewear-service.ts";
import { SmartglassesService } from "./services/smartglasses-service.ts";

export const facewearPlugin: Plugin = {
	name: "@elizaos/plugin-facewear",
	description:
		"Unified smartglasses plugin — Even Realities G1/G2 BLE control, device configuration, and status.",

	services: [FacewearService, SmartglassesService],
	actions: [
		facewearConnectAction,
		facewearDebugAction,
		facewearControlAction,
		facewearStatusAction,
		displayFacewearTextAction,
		facewearMicrophoneAction,
	],
	providers: [facewearContextProvider, smartglassesStatusProvider],
	routes: [facewearDevicesRoute, facewearDeviceRoute, facewearStatusRoute],

	async dispose(runtime: IAgentRuntime) {
		await runtime
			.getService<FacewearService>(FacewearService.serviceType)
			?.stop();
	},
};

export default facewearPlugin;
export const smartglassesPlugin = facewearPlugin;

export { displayFacewearTextAction as displaySmartglassesTextAction } from "./actions/display-text.ts";
// Re-exports for backward compatibility
export { facewearControlAction as smartglassesControlAction } from "./actions/facewear-control.ts";
export { facewearStatusAction as smartglassesStatusAction } from "./actions/facewear-status.ts";
export { facewearMicrophoneAction as smartglassesMicrophoneAction } from "./actions/microphone.ts";
export type {
	FacewearDeviceProfile,
	FacewearDeviceType,
} from "./devices/registry.ts";
export {
	DEVICE_REGISTRY,
	getAllDeviceProfiles,
	getDeviceProfile,
} from "./devices/registry.ts";
export * from "./protocol/smartglasses.ts";
export { smartglassesStatusProvider } from "./providers/smartglasses-status.ts";
export {
	FACEWEAR_SERVICE_TYPE,
	FacewearService,
} from "./services/facewear-service.ts";
export type {
	SmartglassesAudioDecoder,
	SmartglassesDisplayMode,
	SmartglassesRsvpOptions,
	SmartglassesStatus,
	SmartglassesWriteTarget,
} from "./services/smartglasses-service.ts";
export {
	FACEWEAR_AUTO_INIT_SETTING,
	FACEWEAR_INIT_MODE_SETTING,
	FACEWEAR_SCAN_TIMEOUT_SETTING,
	FACEWEAR_SMARTGLASSES_TRANSPORT_SETTING,
	getSmartglassesService,
	SMARTGLASSES_AUDIO_EVENT,
	SMARTGLASSES_AUTO_INIT_SETTING,
	SMARTGLASSES_EVENT,
	SMARTGLASSES_INIT_MODE_SETTING,
	SMARTGLASSES_SCAN_TIMEOUT_SETTING,
	SMARTGLASSES_SERVICE_NAME,
	SMARTGLASSES_TRANSCRIPT_EVENT,
	SMARTGLASSES_TRANSPORT_SETTING,
	SmartglassesService,
	setSmartglassesAudioDecoderForRuntime,
	setSmartglassesTransportForRuntime,
} from "./services/smartglasses-service.ts";
export {
	EvenBridgeTransport,
	getGlobalEvenBridgeTransport,
} from "./transport/even-bridge.ts";
export { MockSmartglassesTransport } from "./transport/mock.ts";
export type {
	NobleAdapterLike,
	NobleCharacteristicLike,
	NobleG1TransportOptions,
	NoblePeripheralLike,
} from "./transport/noble.ts";
export { getNobleG1Transport, NobleG1Transport } from "./transport/noble.ts";
export type {
	SmartglassesTransport,
	SmartglassesTransportFactory,
	SmartglassesWifiResult,
} from "./transport/types.ts";
export {
	getWebBluetoothG1Transport,
	WebBluetoothG1Transport,
} from "./transport/web-bluetooth.ts";
