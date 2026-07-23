/**
 * Tests for prePullImageOnEligibleNodes, the upgrade pre-pull that warms the
 * digest-pinned target image on eligible blue-candidate nodes BEFORE create.
 *
 * On 2026-07-23 a cold `docker pull` inside the provider's create ran long and
 * was interrupted when the worker was stopped mid-flight, churning the upgrade
 * job. Pre-pulling the target image onto candidate nodes first makes the
 * in-create pull a warm cache hit so create is fast. This locks the eligibility
 * filter (exclude the current node, skip unhealthy / no-slot / arch-mismatch)
 * and the best-effort (never-throw) contract.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realDockerNodesNs from "../../db/repositories/docker-nodes";
import type { DockerNode } from "../../db/schemas/docker-nodes";
import * as realDockerNodeWorkloadsNs from "./docker-node-workloads";
import * as realDockerSshNs from "./docker-ssh";

const realDockerNodes = { ...realDockerNodesNs };
const realDockerNodeWorkloads = { ...realDockerNodeWorkloadsNs };
const realDockerSsh = { ...realDockerSshNs };

const mocks = {
  nodes: [] as DockerNode[],
  countAllocated: mock(),
  connect: mock(),
  exec: mock(),
};

mock.module("../../db/repositories/docker-nodes", () => ({
  dockerNodesRepository: {
    findEnabled: () => Promise.resolve(mocks.nodes),
  },
}));

mock.module("./docker-node-workloads", () => ({
  countAllocatedWorkloadsOnNode: mocks.countAllocated,
}));

mock.module("./docker-ssh", () => ({
  DockerSSHClient: {
    getClient: () => ({
      connect: mocks.connect,
      exec: mocks.exec,
    }),
  },
}));

afterAll(() => {
  mock.module("../../db/repositories/docker-nodes", () => realDockerNodes);
  mock.module("./docker-node-workloads", () => realDockerNodeWorkloads);
  mock.module("./docker-ssh", () => realDockerSsh);
});

import { DockerNodeManager } from "./docker-node-manager";

function node(nodeId: string, overrides: Partial<DockerNode> = {}): DockerNode {
  return {
    id: `${nodeId}-uuid`,
    node_id: nodeId,
    hostname: `${nodeId}.example.test`,
    ssh_port: 22,
    capacity: 4,
    enabled: true,
    status: "healthy",
    allocated_count: 0,
    last_health_check: null,
    ssh_user: "root",
    host_key_fingerprint: "SHA256:test",
    metadata: { architecture: "amd64" },
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    updated_at: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

const IMAGE = "ghcr.io/elizaos/eliza@sha256:deadbeef";

describe("prePullImageOnEligibleNodes (upgrade pre-pull)", () => {
  beforeEach(() => {
    mocks.nodes = [];
    mocks.countAllocated.mockReset();
    mocks.countAllocated.mockResolvedValue(0);
    mocks.connect.mockReset();
    mocks.connect.mockResolvedValue(undefined);
    mocks.exec.mockReset();
    mocks.exec.mockResolvedValue("");
  });

  test("pulls on the healthy candidate, skips the excluded (current) node", async () => {
    mocks.nodes = [node("old-node"), node("blue-node")];
    const manager = DockerNodeManager.getInstance();

    const results = await manager.prePullImageOnEligibleNodes(IMAGE, "linux/amd64", "old-node");

    const byNode = Object.fromEntries(results.map((r) => [r.nodeId, r]));
    expect(byNode["old-node"]?.status).toBe("skipped");
    expect(byNode["old-node"]?.reason).toBe("excluded node");
    expect(byNode["blue-node"]?.status).toBe("pulled");
  });

  test("skips unhealthy, full, and arch-incompatible nodes", async () => {
    mocks.nodes = [
      node("degraded", { status: "degraded" }),
      node("full"),
      node("arm-only", { metadata: { architecture: "arm64" } }),
      node("good"),
    ];
    // 'full' has no spare slots (allocated == capacity).
    mocks.countAllocated.mockImplementation((id: string) => Promise.resolve(id === "full" ? 4 : 0));
    const manager = DockerNodeManager.getInstance();

    const results = await manager.prePullImageOnEligibleNodes(IMAGE, "linux/amd64");
    const byNode = Object.fromEntries(results.map((r) => [r.nodeId, r]));

    expect(byNode["degraded"]?.status).toBe("skipped");
    expect(byNode["full"]?.status).toBe("skipped");
    expect(byNode["full"]?.reason).toBe("no spare slots");
    expect(byNode["arm-only"]?.status).toBe("skipped");
    expect(byNode["good"]?.status).toBe("pulled");
  });

  test("a pull failure is reported as failed, never thrown (best-effort)", async () => {
    mocks.nodes = [node("flaky")];
    mocks.exec.mockImplementation((command: string) => {
      if (command.includes('wait "$pid"')) {
        return Promise.reject(new Error("pull exploded"));
      }
      return Promise.resolve("");
    });
    const manager = DockerNodeManager.getInstance();

    const results = await manager.prePullImageOnEligibleNodes(IMAGE, "linux/amd64");
    expect(results[0]?.status).toBe("failed");
    expect(results[0]?.reason).toContain("pull exploded");
  });
});
