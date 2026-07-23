/**
 * Locks the MAX_INFLIGHT_UPGRADES env-parse contract.
 *
 * The fleet-upgrade pause (`MAX_INFLIGHT_UPGRADES=0`) was repeatedly hot-patched
 * onto the live CP and then wiped by every git deploy (`git reset --hard` +
 * `git clean -fdx`), silently RESUMING a destructive upgrade wave 4+ times
 * (2026-07-23 mesh incident). The fix reads the value from the environment via
 * `parseNonNegativeInt`, where `0` is a FIRST-CLASS value (pause), not an
 * invalid input that falls back to the default. This test guards that `0`
 * survives the parse so the pause is durable across redeploys.
 */

import { describe, expect, test } from "bun:test";
import { parseNonNegativeInt } from "./provisioning-worker";

describe("parseNonNegativeInt (MAX_INFLIGHT_UPGRADES durable pause)", () => {
  test("admits 0 as a valid value (the pause), NOT a fallback", () => {
    // The regression that mattered: `0` must not be treated as falsy/invalid.
    expect(parseNonNegativeInt("0", 3)).toBe(0);
  });

  test("parses positive integers", () => {
    expect(parseNonNegativeInt("1", 3)).toBe(1);
    expect(parseNonNegativeInt("5", 3)).toBe(5);
  });

  test("falls back on unset / empty / whitespace", () => {
    expect(parseNonNegativeInt(undefined, 3)).toBe(3);
    expect(parseNonNegativeInt("", 3)).toBe(3);
    expect(parseNonNegativeInt("   ", 3)).toBe(3);
  });

  test("falls back on negative or non-numeric input", () => {
    expect(parseNonNegativeInt("-1", 3)).toBe(3);
    expect(parseNonNegativeInt("abc", 3)).toBe(3);
    expect(parseNonNegativeInt("NaN", 3)).toBe(3);
  });

  test("default is 3 when nothing is configured", () => {
    // Documents the operational default the reconciler runs at.
    const unset: string | undefined = undefined;
    expect(parseNonNegativeInt(unset, 3)).toBe(3);
  });
});
