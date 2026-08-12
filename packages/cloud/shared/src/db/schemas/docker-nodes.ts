// Defines the docker nodes Drizzle table shape used by cloud repositories and services.
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export type DockerNodeStatus = "healthy" | "degraded" | "offline" | "unknown";

/**
 * Fleet cost class + pool, used by placement to prefer cheap capacity and to
 * keep the paid dedicated pool separate from free/shared traffic.
 *
 * - `robot-dedicated` — a small reserved slice of the robot fleet (~2 nodes),
 *                       low agent density, for PAYING or $5+ topped-up accounts
 *                       only. Shared traffic never lands here (enforced at
 *                       provision time, PR-D). The premium shelf.
 * - `robot-shared`    — the rest of the robot fleet, high density (~100
 *                       agents/node) at a LOWER per-agent memory ceiling. The
 *                       default home for free-tier + shared placement.
 * - `cloud`           — hand-registered / historical Hetzner Cloud boxes that
 *                       are NOT autoscaler-managed. Neutral middle preference.
 * - `autoscale`       — boxes the node-autoscaler spins on demand
 *                       (`metadata.provider=hetzner-cloud`, `autoscaled=true`).
 *                       ~€35/slot; the expensive overflow buffer.
 *
 * Ranking preference (cheapest admissible first): the two robot pools before
 * cloud before autoscale, with dedicated-vs-shared chosen by the request's
 * billing eligibility (PR-B), not by cost. `cloud` is the neutral default for
 * any pre-tier row whose provenance can't be proven from metadata. The column
 * never gates node *health* — only placement preference and pool routing.
 */
export type DockerNodeTier = "robot-dedicated" | "robot-shared" | "cloud" | "autoscale";

/** The robot pools, split out for the dedicated-vs-shared routing decision. */
export const ROBOT_DEDICATED_TIER = "robot-dedicated" as const;
export const ROBOT_SHARED_TIER = "robot-shared" as const;

export function isRobotTier(tier: string | null | undefined): boolean {
  return tier === ROBOT_DEDICATED_TIER || tier === ROBOT_SHARED_TIER;
}

export const dockerNodes = pgTable(
  "docker_nodes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    node_id: text("node_id").unique().notNull(),
    hostname: text("hostname").notNull(),
    ssh_port: integer("ssh_port").notNull().default(22),
    capacity: integer("capacity").notNull().default(8),
    enabled: boolean("enabled").notNull().default(true),
    status: text("status").$type<DockerNodeStatus>().notNull().default("unknown"),
    allocated_count: integer("allocated_count").notNull().default(0),
    // Fleet cost class + pool for cost-aware placement and dedicated/shared
    // routing. Defaults to `cloud` — the safe neutral class for any row created
    // before provenance is known; the migration backfills existing rows from
    // metadata + node_id.
    tier: text("tier").$type<DockerNodeTier>().notNull().default("cloud"),
    // Per-node agent memory ceiling (MiB). NULL means "use the global
    // CONTAINERS_AGENT_MEMORY_LIMIT_MB". A dense robot-shared node sets a LOWER
    // ceiling (~1.5-2 GiB) so ~100 agents fit its RAM honestly; the memory
    // admission gate (#18491) enforces whatever ceiling actually applies, so
    // this per-node profile and the admitted budget can never drift.
    agent_memory_limit_mb: integer("agent_memory_limit_mb"),
    last_health_check: timestamp("last_health_check", { withTimezone: true }),
    ssh_user: text("ssh_user").notNull().default("root"),
    host_key_fingerprint: text("host_key_fingerprint"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    node_id_idx: index("docker_nodes_node_id_idx").on(table.node_id),
    status_idx: index("docker_nodes_status_idx").on(table.status),
    enabled_idx: index("docker_nodes_enabled_idx").on(table.enabled),
    tier_idx: index("docker_nodes_tier_idx").on(table.tier),
  }),
);

export type DockerNode = InferSelectModel<typeof dockerNodes>;
export type NewDockerNode = InferInsertModel<typeof dockerNodes>;
