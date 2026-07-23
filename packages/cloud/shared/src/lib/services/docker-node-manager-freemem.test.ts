/**
 * Free-memory placement gate tests.
 *
 * On 2026-07-23 the scheduler placed a fresh blue container on a node at load
 * ~57 with only ~540MB free (it had free container SLOTS, so slot-count
 * placement picked it), the boot OOM-thrashed, and the fleet upgrade cycle
 * timed out. These tests lock the pure parsing + gate-eligibility contract that
 * lets getAvailableNode prefer nodes with real memory headroom.
 */

import { describe, expect, test } from "bun:test";
import type { DockerNode } from "../../db/schemas/docker-nodes";
import {
  NODE_PRESSURE_SAMPLE_TTL_MS,
  NODE_RESOURCE_PRESSURE_PROBE_CMD,
  parseNodeResourcePressure,
  readNodeResourcePressure,
} from "./docker-node-manager";

function nodeWithPressure(meta: Record<string, unknown> | null): DockerNode {
  return {
    id: "id-1",
    node_id: "eliza-core-x",
    hostname: "10.0.0.1",
    ssh_port: 22,
    capacity: 8,
    enabled: true,
    status: "healthy",
    allocated_count: 0,
    last_health_check: null,
    ssh_user: "root",
    host_key_fingerprint: null,
    metadata: (meta ?? {}) as Record<string, unknown>,
    created_at: new Date(),
    updated_at: new Date(),
  } as DockerNode;
}

describe("parseNodeResourcePressure", () => {
  test("parses MemAvailable(kB) + loadavg into MB + load", () => {
    // 552960 kB = 540 MB, exactly the starved node from the incident.
    const p = parseNodeResourcePressure("552960\n57.31\n", 1000);
    expect(p).not.toBeNull();
    expect(p?.freeMemoryMb).toBe(540);
    expect(p?.load1m).toBe(57.31);
    expect(p?.probedAt).toBe(1000);
  });

  test("tolerates a missing loadavg line (load1m null)", () => {
    const p = parseNodeResourcePressure("2097152\n", 5);
    expect(p?.freeMemoryMb).toBe(2048);
    expect(p?.load1m).toBeNull();
  });

  test("returns null on empty / unreadable MemAvailable", () => {
    expect(parseNodeResourcePressure("")).toBeNull();
    expect(parseNodeResourcePressure("not-a-number\n")).toBeNull();
    expect(parseNodeResourcePressure("\n\n")).toBeNull();
  });

  test("probe command reads MemAvailable + loadavg, one value per line", () => {
    expect(NODE_RESOURCE_PRESSURE_PROBE_CMD).toContain("MemAvailable");
    expect(NODE_RESOURCE_PRESSURE_PROBE_CMD).toContain("/proc/loadavg");
  });
});

describe("readNodeResourcePressure (metadata round-trip)", () => {
  test("reads back a persisted sample", () => {
    const node = nodeWithPressure({
      resourcePressure: { freeMemoryMb: 540, load1m: 57, probedAt: 42 },
    });
    const p = readNodeResourcePressure(node);
    expect(p).toEqual({ freeMemoryMb: 540, load1m: 57, probedAt: 42 });
  });

  test("returns null when metadata has no sample (unknown pressure -> fail-open)", () => {
    expect(readNodeResourcePressure(nodeWithPressure(null))).toBeNull();
    expect(readNodeResourcePressure(nodeWithPressure({ other: 1 }))).toBeNull();
  });

  test("returns null when the sample is malformed", () => {
    const node = nodeWithPressure({ resourcePressure: { freeMemoryMb: "lots" } });
    expect(readNodeResourcePressure(node)).toBeNull();
  });
});

describe("starvation eligibility (gate semantics)", () => {
  // Mirror the getAvailableNode gate predicate so the branch logic is locked
  // without standing up the full DB-backed selection path.
  const minFreeMemoryMb = 768;
  const isStarved = (node: DockerNode, now: number): boolean => {
    const pressure = readNodeResourcePressure(node);
    if (!pressure) return false;
    if (now - pressure.probedAt > NODE_PRESSURE_SAMPLE_TTL_MS) return false;
    return pressure.freeMemoryMb < minFreeMemoryMb;
  };

  test("a recent low-memory reading marks the node starved (the incident node)", () => {
    const node = nodeWithPressure({
      resourcePressure: { freeMemoryMb: 540, load1m: 57, probedAt: 1_000 },
    });
    expect(isStarved(node, 1_000)).toBe(true);
  });

  test("a node with ample memory is not starved", () => {
    const node = nodeWithPressure({
      resourcePressure: { freeMemoryMb: 2048, load1m: 0, probedAt: 1_000 },
    });
    expect(isStarved(node, 1_000)).toBe(false);
  });

  test("a STALE low reading does not block placement (fail-open on stale)", () => {
    const node = nodeWithPressure({
      resourcePressure: { freeMemoryMb: 540, load1m: 57, probedAt: 1_000 },
    });
    expect(isStarved(node, 1_000 + NODE_PRESSURE_SAMPLE_TTL_MS + 1)).toBe(false);
  });

  test("no sample never blocks placement (unknown pressure -> fail-open)", () => {
    expect(isStarved(nodeWithPressure(null), 1_000)).toBe(false);
  });
});
