/**
 * Applies the docker_nodes tier backfill (0196) to real PGlite rows and proves
 * its provenance-based classification, its default, and its idempotence.
 *
 * The fixtures mirror the live fleet at write time (CLOUD-VS-ROBOT-TRUTH
 * 2026-08-12): hand-registered robot boxes (eliza-core-prod-*) backfill to the
 * SAFE `robot-shared` default (dedicated promotion is an explicit operator
 * action, never guessed), a stack of autoscaled ccx33 cloud boxes
 * (provider=hetzner-cloud, autoscaled=true) → `autoscale`, and one
 * hand-registered non-autoscaled cloud box that must stay `cloud` — the neutral
 * middle class — rather than be mislabeled either the cheap robot shelf or the
 * reserved paid pool.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION_PATH = join(import.meta.dir, "migrations/0196_docker_nodes_tier.sql");

let client: PGlite;

async function applyMigration(): Promise<void> {
  for (const statement of readFileSync(MIGRATION_PATH, "utf8")
    .split("--> statement-breakpoint")
    .map((candidate) => candidate.trim())
    .filter(Boolean)) {
    await client.exec(statement);
  }
}

/** Pre-migration table shape (no tier column yet), matching the base schema. */
async function seedPreMigrationTable(): Promise<void> {
  await client.exec(`
    DROP TABLE IF EXISTS docker_nodes;
    CREATE TABLE docker_nodes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      node_id text UNIQUE NOT NULL,
      hostname text NOT NULL,
      capacity integer NOT NULL DEFAULT 8,
      enabled boolean NOT NULL DEFAULT true,
      status text NOT NULL DEFAULT 'unknown',
      allocated_count integer NOT NULL DEFAULT 0,
      metadata jsonb NOT NULL DEFAULT '{}'
    );
    INSERT INTO docker_nodes (node_id, hostname, metadata) VALUES
      ('eliza-core-prod-1', '88.99.66.168', '{"provider":"operator-onboarded"}'),
      ('eliza-core-prod-2', '178.63.251.122', '{}'),
      ('eliza-prod-robot-4', '85.10.193.52', '{"provider":"operator-onboarded"}'),
      ('eliza-core-40661ddb', '2.28.17.235', '{"provider":"hetzner-cloud","autoscaled":true}'),
      ('eliza-core-aaaa1111', '10.0.0.9', '{"provider":"hetzner-cloud","autoscaled":true}'),
      ('hand-cloud-legacy', '10.0.0.2', '{"provider":"operator-onboarded"}');
  `);
}

async function tierOf(nodeId: string): Promise<string> {
  const res = await client.query<{ tier: string }>(
    "SELECT tier FROM docker_nodes WHERE node_id = $1",
    [nodeId],
  );
  return res.rows[0]?.tier ?? "<missing>";
}

beforeAll(async () => {
  client = new PGlite();
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await seedPreMigrationTable();
});

describe("0196_docker_nodes_tier", () => {
  test("adds the column with a NOT NULL cloud default", async () => {
    await applyMigration();
    const res = await client.query<{ column_default: string; is_nullable: string }>(
      "SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'docker_nodes' AND column_name = 'tier'",
    );
    expect(res.rows[0]?.is_nullable).toBe("NO");
    expect(res.rows[0]?.column_default).toContain("cloud");
  });

  test("classifies robot boxes as robot-shared (safe default), autoscaled from metadata", async () => {
    await applyMigration();
    // robot-shared, NOT robot-dedicated: the paid pool is never guessed by the
    // backfill, only assigned deliberately by an operator.
    expect(await tierOf("eliza-core-prod-1")).toBe("robot-shared");
    expect(await tierOf("eliza-core-prod-2")).toBe("robot-shared");
    expect(await tierOf("eliza-prod-robot-4")).toBe("robot-shared");
    expect(await tierOf("eliza-core-40661ddb")).toBe("autoscale");
    expect(await tierOf("eliza-core-aaaa1111")).toBe("autoscale");
  });

  test("adds a nullable per-node agent_memory_limit_mb with no backfill", async () => {
    await applyMigration();
    const meta = await client.query<{ is_nullable: string; column_default: string | null }>(
      "SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name = 'docker_nodes' AND column_name = 'agent_memory_limit_mb'",
    );
    expect(meta.rows[0]?.is_nullable).toBe("YES");
    expect(meta.rows[0]?.column_default).toBeNull();
    // Existing rows keep the global ceiling (NULL) until an operator profiles them.
    const val = await client.query<{ agent_memory_limit_mb: number | null }>(
      "SELECT agent_memory_limit_mb FROM docker_nodes WHERE node_id = 'eliza-core-prod-1'",
    );
    expect(val.rows[0]?.agent_memory_limit_mb).toBeNull();
  });

  test("leaves a hand-registered non-autoscaled cloud box as the neutral cloud class", async () => {
    // NOT robot (never mislabel the cheap shelf) and NOT autoscale (it is not
    // autoscaler-owned) — the deliberately neutral middle preference.
    await applyMigration();
    expect(await tierOf("hand-cloud-legacy")).toBe("cloud");
  });

  test("is idempotent — re-applying does not reclassify or throw", async () => {
    await applyMigration();
    await applyMigration();
    expect(await tierOf("eliza-core-prod-1")).toBe("robot-shared");
    expect(await tierOf("eliza-core-40661ddb")).toBe("autoscale");
    expect(await tierOf("hand-cloud-legacy")).toBe("cloud");
  });

  test("a new row inserted after migration takes the cloud default", async () => {
    await applyMigration();
    await client.exec(
      "INSERT INTO docker_nodes (node_id, hostname) VALUES ('fresh-node', '10.0.0.99')",
    );
    expect(await tierOf("fresh-node")).toBe("cloud");
  });
});
