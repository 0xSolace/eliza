-- Adds a `tier` cost class + pool and a per-node `agent_memory_limit_mb` to
-- `docker_nodes`, so placement can (a) prefer cheap capacity — hand-registered
-- robot boxes (~€3-4.5/agent-slot) over autoscaled Hetzner Cloud (~€35/slot),
-- instead of the fleet-blind "least-loaded by free slots" it does today — and
-- (b) keep the paid dedicated pool separate from free/shared traffic.
--
-- Tier is one of robot-dedicated | robot-shared | cloud | autoscale:
--   * robot-dedicated — a small reserved robot slice (~2 nodes), low density,
--     paying/$5+ accounts only. Shared traffic never lands here (enforced at
--     provision time in a later PR).
--   * robot-shared    — the rest of the robot fleet, high density at a lower
--     per-agent ceiling. Free-tier + shared placement's default home.
--   * cloud           — hand-registered non-autoscaled cloud boxes (neutral).
--   * autoscale       — autoscaler-owned overflow (the expensive shelf).
--
-- NOT NULL with a `cloud` default. `cloud` is the deliberately neutral class: a
-- brand-new row of unknown provenance gets the middle preference, so a mistake
-- can only mis-rank it, never refuse it and never (mis)label it either the cheap
-- robot shelf or the reserved paid pool. The autoscaler and onboard script set
-- the tier explicitly on rows they create from here on.
--
-- Backfill reads the same provenance the codebase already trusts:
--   * autoscaled (provider=hetzner-cloud AND autoscaled=true) → autoscale,
--     mirroring `isAutoscaledNode` so DB truth and code truth agree.
--   * hand-registered robot/auction boxes (by the node_id naming the fleet uses)
--     → robot-shared. Shared is the SAFE default for the whole robot fleet: it
--     is the high-density, no-billing-gate class, so a mis-backfilled node can
--     only over-serve free traffic, never silently reserve paid-only capacity.
--     Promoting the ~2 dedicated nodes to robot-dedicated is a deliberate
--     operator action (admin PATCH / onboard --tier), NOT guessed here.
--   * everything else stays cloud.
--
-- The node_id prefix match is intentionally the only host-specific line: it
-- reflects the live fleet at write time (eliza-core-prod-1..6 / eliza-*-robot-*);
-- any node onboarded afterwards carries its tier from the onboard script.
ALTER TABLE "docker_nodes"
  ADD COLUMN IF NOT EXISTS "tier" text NOT NULL DEFAULT 'cloud';
--> statement-breakpoint

-- Per-node agent memory ceiling (MiB). NULL = use the global
-- CONTAINERS_AGENT_MEMORY_LIMIT_MB. A dense robot-shared node sets a lower value
-- so ~100 agents fit its RAM; memory admission (#18491) enforces whatever
-- ceiling actually applies, so this profile and the admitted budget never drift.
-- Nullable with no backfill: every existing node keeps the global ceiling until
-- an operator profiles it.
ALTER TABLE "docker_nodes"
  ADD COLUMN IF NOT EXISTS "agent_memory_limit_mb" integer;
--> statement-breakpoint

-- Autoscaled Hetzner Cloud boxes → `autoscale` (the expensive overflow buffer).
UPDATE "docker_nodes"
SET "tier" = 'autoscale'
WHERE "tier" = 'cloud'
  AND "metadata" ->> 'provider' = 'hetzner-cloud'
  AND ("metadata" ->> 'autoscaled')::boolean IS TRUE;
--> statement-breakpoint

-- Hand-registered robot/auction boxes → `robot-shared` (the safe, high-density,
-- no-gate default). Dedicated promotion is an explicit operator action, not here.
UPDATE "docker_nodes"
SET "tier" = 'robot-shared'
WHERE "tier" = 'cloud'
  AND ("metadata" ->> 'provider') IS DISTINCT FROM 'hetzner-cloud'
  AND (
    "node_id" LIKE 'eliza-core-prod-%'
    OR "node_id" LIKE 'eliza-%-robot-%'
    OR "node_id" LIKE 'robot-%'
  );
--> statement-breakpoint

-- Index the tier so the cost-aware / pool-routing ORDER BY + WHERE does not scan;
-- it pairs with the existing enabled/status indexes on the placement path.
CREATE INDEX IF NOT EXISTS "docker_nodes_tier_idx" ON "docker_nodes" ("tier");
