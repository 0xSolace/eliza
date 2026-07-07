/**
 * Facewear device registry lists supported smartglasses native app targets and
 * setup metadata.
 */
export type FacewearDeviceType = "even-realities";

export interface FacewearDeviceProfile {
	id: FacewearDeviceType;
	displayName: string;
	manufacturer: string;
	connectionType: "ble";
	features: string[];
	sdkName?: string;
	sdkVersion?: string;
	sdkUrl?: string;
	nativeAppPlatform?: "android" | "visionos" | "both";
	nativeAppPath?: string;
}

export const DEVICE_REGISTRY: Record<
	FacewearDeviceType,
	FacewearDeviceProfile
> = {
	"even-realities": {
		id: "even-realities",
		displayName: "Even Realities G1 / G2",
		manufacturer: "Even Realities",
		connectionType: "ble",
		features: [
			"ble",
			"oled-display",
			"microphone",
			"side-tap",
			"wifi-provisioning",
		],
		sdkName: "G1 BLE Protocol (built-in)",
		nativeAppPlatform: "android",
		nativeAppPath: "native/android/even-realities",
	},
};

export function getDeviceProfile(
	deviceType: FacewearDeviceType,
): FacewearDeviceProfile {
	return DEVICE_REGISTRY[deviceType];
}

export function isFacewearDeviceType(
	value: string,
): value is FacewearDeviceType {
	return Object.hasOwn(DEVICE_REGISTRY, value);
}

export function getAllDeviceProfiles(): FacewearDeviceProfile[] {
	return Object.values(DEVICE_REGISTRY);
}
