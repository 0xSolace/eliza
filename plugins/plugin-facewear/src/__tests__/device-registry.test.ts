/**
 * Device registry tests pin the shipped smartglasses profile and the public
 * lookup helpers used by setup and status views.
 */
import { describe, expect, it } from "vitest";
import {
	DEVICE_REGISTRY,
	type FacewearDeviceType,
	getAllDeviceProfiles,
	getDeviceProfile,
} from "../devices/registry.ts";

describe("FacewearDeviceRegistry", () => {
	const EXPECTED_TYPES: FacewearDeviceType[] = ["even-realities"];

	it("has the shipped device type registered", () => {
		for (const type of EXPECTED_TYPES) {
			expect(DEVICE_REGISTRY[type], `${type} not in registry`).toBeDefined();
		}
	});

	it("every profile has required fields", () => {
		for (const profile of getAllDeviceProfiles()) {
			expect(profile.id).toBeTruthy();
			expect(profile.displayName).toBeTruthy();
			expect(profile.manufacturer).toBeTruthy();
			expect(profile.connectionType).toBe("ble");
			expect(Array.isArray(profile.features)).toBe(true);
		}
	});

	it("getDeviceProfile returns the correct profile", () => {
		const g1 = getDeviceProfile("even-realities");
		expect(g1.connectionType).toBe("ble");
		expect(g1.features).toContain("ble");
	});

	it("getAllDeviceProfiles returns the shipped profile", () => {
		const all = getAllDeviceProfiles();
		expect(all).toHaveLength(1);
		const ids = all.map((p) => p.id);
		for (const type of EXPECTED_TYPES) {
			expect(ids).toContain(type);
		}
	});

	it("native devices have nativeAppPath", () => {
		expect(getDeviceProfile("even-realities").nativeAppPath).toBe(
			"native/android/even-realities",
		);
	});
});
