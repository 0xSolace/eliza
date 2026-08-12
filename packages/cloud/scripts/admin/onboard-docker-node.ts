#!/usr/bin/env bun
/**
 * Onboard an EXISTING host (e.g. a Hetzner robot box) as an elizaOS Cloud
 * Docker node — with zero manual SSH/DB steps.
 *
 * A robot/auctioned host can't be cloud-init'd (it's already running), so this
 * script runs the bootstrap-equivalent steps over SSH and then registers the
 * node into `docker_nodes` the same way the autoscaler / bootstrap-callback do.
 * It is the operator-side counterpart to `buildContainerNodeUserData`.
 *
 * Every step is idempotent and safe to re-run:
 *   1. verify/install Docker + ensure the daemon is running,
 *   2. ensure the shared bridge network exists,
 *   3. ensure deterministic ghcr access — THE robot fix: clear any stale
 *      stored credential (an expired ghcr token in /root/.docker/config.json
 *      overrides anonymous access and bricks the public-image pull with
 *      `denied`). Reuses `ensureRegistryAccess`.
 *   4. clean zombie/stale agent containers (exited/created orphans matching the
 *      agent naming scheme — never an active sandbox),
 *   5. ensure the local-embedding sidecar is running (same contract the
 *      cloud-init bootstrap installs; see `embedding-sidecar.ts`),
 *   6. upsert the node into `docker_nodes` (update if it already exists),
 *   7. print a clear summary of what changed vs. was already in place.
 *
 * No secrets are hard-coded: the registry token (if any) comes from the
 * control-plane env via `containersEnv`; the DB target from `DATABASE_URL`.
 *
 * Usage:
 *   DATABASE_URL=... bun run packages/cloud/scripts/admin/onboard-docker-node.ts \
 *     --host 1.2.3.4 --key ~/.ssh/id_ed25519_eliza --node-id robot-fsn1-01
 *
 * Flags (env fallback in parens):
 *   --host        <ip|hostname>  SSH target (ONBOARD_NODE_HOST)              [required]
 *   --node-id     <id>           Logical node id (ONBOARD_NODE_ID)          [required]
 *   --key         <path>         SSH private key path (ONBOARD_NODE_SSH_KEY) [default ~/.ssh/id_ed25519]
 *   --ssh-port    <n>            SSH port (ONBOARD_NODE_SSH_PORT)            [default 22]
 *   --ssh-user    <user>         SSH user (ONBOARD_NODE_SSH_USER)           [default root]
 *   --capacity    <n>            Agent capacity (ONBOARD_NODE_CAPACITY)     [default: derive from RAM]
 *   --tier        <robot-dedicated|robot-shared|cloud|autoscale>
 *                                Fleet cost class + pool (ONBOARD_NODE_TIER)   [default robot-shared]
 *   --agent-memory-limit-mb <n>  Per-node agent RAM ceiling in MiB
 *                                (ONBOARD_NODE_AGENT_MEMORY_LIMIT_MB)          [default: global]
 *   --dry-run                    Print the planned steps, touch nothing.
 */

import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// The cloud-shared modules are imported lazily inside main() (see loadDeps) so
// importing this file for its pure helpers — e.g. from the unit test — does not
// drag in the Drizzle / plugin-sql DB stack.
async function loadDeps() {
  const [
    { dockerNodesRepository, stampDockerNodeEnvironmentMetadata },
    { ensureRegistryAccess },
    dockerUtils,
    { DockerSSHClient },
    { buildEnsureEmbeddingSidecarCmd },
  ] = await Promise.all([
    import("@elizaos/cloud-shared/db/repositories/docker-nodes"),
    import(
      "@elizaos/cloud-shared/lib/services/containers/hetzner-client/registry"
    ),
    import("@elizaos/cloud-shared/lib/services/docker-sandbox-utils"),
    import("@elizaos/cloud-shared/lib/services/docker-ssh"),
    import("@elizaos/cloud-shared/lib/services/containers/embedding-sidecar"),
  ]);
  return {
    dockerNodesRepository,
    stampDockerNodeEnvironmentMetadata,
    ensureRegistryAccess,
    buildEnsureNetworkCmd: dockerUtils.buildEnsureNetworkCmd,
    shellQuote: dockerUtils.shellQuote,
    DockerSSHClient,
    buildEnsureEmbeddingSidecarCmd,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in onboard-docker-node.test.ts)
// ---------------------------------------------------------------------------

/** Container-name prefixes the cloud control plane uses for agent workloads. */
export const AGENT_CONTAINER_PREFIXES = ["agent-", "cloud-container-"] as const;

/** Docker states that mean a container is NOT actively serving — safe to reap. */
const REAPABLE_STATES = ["exited", "created", "dead"] as const;

export interface DockerPsRow {
  name: string;
  state: string;
}

/**
 * Parse the output of `docker ps -a --format '{{.Names}}\t{{.State}}'`.
 * Tolerant of blank lines and trailing whitespace.
 */
export function parseDockerPs(output: string): DockerPsRow[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("[stderr]"))
    .map((line) => {
      const [name, state] = line.split("\t");
      return {
        name: (name ?? "").trim(),
        state: (state ?? "").trim().toLowerCase(),
      };
    })
    .filter((row) => row.name.length > 0);
}

/**
 * Conservative zombie filter: an agent-named container in a non-running state.
 * Running / restarting / paused containers are NEVER selected, so an active
 * sandbox is never touched even if its DB row drifted.
 */
export function selectZombieAgentContainers(rows: DockerPsRow[]): string[] {
  return rows
    .filter(
      (row) =>
        AGENT_CONTAINER_PREFIXES.some((prefix) =>
          row.name.startsWith(prefix),
        ) && (REAPABLE_STATES as readonly string[]).includes(row.state),
    )
    .map((row) => row.name);
}

/** Fleet cost class + pool this onboarded host belongs to (see docker-nodes schema). */
export type OnboardTier =
  | "robot-dedicated"
  | "robot-shared"
  | "cloud"
  | "autoscale";

export interface OnboardArgs {
  host: string;
  nodeId: string;
  keyPath: string;
  sshPort: number;
  sshUser: string;
  /**
   * Operator-pinned slot count, or `null` to derive it from the box's measured
   * RAM at onboard time (see `deriveCapacityFromMemory`). `null` is the default
   * so a big robot box is sized to its actual RAM, not the cpx32-era 8-slot
   * fallback this script was born with.
   */
  capacity: number | null;
  /**
   * Cost class for `docker_nodes.tier`, or `null` to let the upsert decide:
   * `robot-shared` for a brand-new row (the safe high-density default; the
   * paid dedicated pool is assigned deliberately, never by default), preserved
   * as-is for a re-onboard. A non-null value re-tags explicitly.
   */
  tier: OnboardTier | null;
  /**
   * Per-node agent memory ceiling (MiB), or `null` for the global default.
   * A dense robot-shared node sets this lower (~1536-2048) so ~100 agents fit
   * its RAM; it also feeds capacity derivation so slots and ceiling agree.
   */
  agentMemoryLimitMb: number | null;
  dryRun: boolean;
}

interface ExistingDockerNodePin {
  host_key_fingerprint: string | null;
  capacity: number;
  tier?: OnboardTier;
}

const ONBOARD_TIERS: readonly OnboardTier[] = [
  "robot-dedicated",
  "robot-shared",
  "cloud",
  "autoscale",
];

/**
 * Validate a `--tier` flag. Returns null when unset so the upsert can default a
 * new row to `robot-shared` (the safe high-density default) while preserving an
 * existing tier across a re-onboard. A provided value must be one of the known
 * classes.
 */
export function parseTier(raw: string | undefined): OnboardTier | null {
  if (raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  if ((ONBOARD_TIERS as readonly string[]).includes(value)) {
    return value as OnboardTier;
  }
  throw new Error(
    `Invalid tier (must be one of ${ONBOARD_TIERS.join(", ")}): ${raw}`,
  );
}

/**
 * Tier to write on (re-)onboard: an explicit `--tier` wins; otherwise a new row
 * defaults to `robot-shared` (the safe, high-density, no-gate class — the paid
 * dedicated pool is assigned deliberately, never by default) and a re-onboard
 * preserves whatever class the row already carries.
 */
export function tierForOnboardUpsert(
  existing: { tier?: OnboardTier } | null,
  flagTier: OnboardTier | null,
): OnboardTier {
  if (flagTier !== null) return flagTier;
  return existing?.tier ?? "robot-shared";
}

/**
 * Slots a node can hold, derived from measured RAM rather than a hardcoded
 * default: `floor((MemTotal - hostReserveMb) / agentCeilingMb)`, clamped to
 * [1, 64]. This is the same budget arithmetic memory admission (#18491) uses to
 * refuse over-committed nodes — deriving capacity from it means the two agree,
 * so a node is never licensed for more ceilings than its RAM can hold.
 *
 * `hostReserveMb` (default 1024) leaves the kernel + daemon + sidecar headroom;
 * a value >= MemTotal, or a non-positive ceiling, yields the minimum 1 slot
 * rather than 0 (a registered-but-unschedulable node is a silent capacity leak).
 */
export function deriveCapacityFromMemory(
  memTotalMb: number,
  agentCeilingMb: number,
  hostReserveMb = 1024,
): number {
  if (!Number.isFinite(memTotalMb) || memTotalMb <= 0) return 1;
  if (!Number.isFinite(agentCeilingMb) || agentCeilingMb <= 0) return 1;
  const budget = memTotalMb - hostReserveMb;
  const slots = Math.floor(budget / agentCeilingMb);
  return Math.min(64, Math.max(1, slots));
}

/**
 * Parse `MemTotal` (in MiB) out of `/proc/meminfo`. Returns null when the field
 * is absent or unparseable, so the caller can fall back to the `--capacity`
 * default rather than deriving a bogus slot count from a bad probe.
 */
export function parseMemTotalMb(meminfo: string): number | null {
  const match = meminfo.match(/^MemTotal:\s+(\d+)\s*kB/m);
  if (!match || match[1] === undefined) return null;
  const kb = Number.parseInt(match[1], 10);
  if (!Number.isFinite(kb) || kb <= 0) return null;
  return Math.floor(kb / 1024);
}

interface OnboardSshConfig {
  hostname: string;
  port: number;
  username: string;
  privateKeyPath: string;
  hostKeyFingerprint?: string;
  onHostKeyDiscovered: (hostname: string, fingerprint: string) => Promise<void>;
}

export function buildOnboardSshConfig(
  args: OnboardArgs,
  existing: ExistingDockerNodePin | null,
  onHostKeyDiscovered: OnboardSshConfig["onHostKeyDiscovered"],
): OnboardSshConfig {
  return {
    hostname: args.host,
    port: args.sshPort,
    username: args.sshUser,
    privateKeyPath: args.keyPath,
    hostKeyFingerprint: existing?.host_key_fingerprint ?? undefined,
    onHostKeyDiscovered,
  };
}

export function hostKeyFingerprintForOnboardUpsert(
  existing: ExistingDockerNodePin | null,
  capturedFingerprint: string | undefined,
): string | null {
  return existing?.host_key_fingerprint ?? capturedFingerprint ?? null;
}

/**
 * Capacity to write on (re-)onboard. Once a node exists, its slot count is
 * operator-owned (tuned via the admin PATCH route or a direct DB update to
 * match the box's real RAM), so a re-onboard preserves it and never resets it
 * to the `--capacity` default (which is sized for the small cpx32-class node
 * this script was born on). The flag value is only used to seed a brand-new
 * row.
 */
export function capacityForOnboardUpsert(
  existing: ExistingDockerNodePin | null,
  resolvedCapacity: number,
): number {
  return existing?.capacity ?? resolvedCapacity;
}

/** Parse argv + env into a validated config. Throws on missing required fields. */
export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): OnboardArgs {
  const flags = new Map<string, string>();
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Flag --${key} requires a value`);
      }
      flags.set(key, value);
      i++;
    }
  }

  const host = flags.get("host") ?? env.ONBOARD_NODE_HOST;
  const nodeId = flags.get("node-id") ?? env.ONBOARD_NODE_ID;
  if (!host) throw new Error("Missing --host (or ONBOARD_NODE_HOST)");
  if (!nodeId) throw new Error("Missing --node-id (or ONBOARD_NODE_ID)");

  const keyPath =
    flags.get("key") ??
    env.ONBOARD_NODE_SSH_KEY ??
    path.join(os.homedir(), ".ssh", "id_ed25519");
  const sshPort = Number.parseInt(
    flags.get("ssh-port") ?? env.ONBOARD_NODE_SSH_PORT ?? "22",
    10,
  );
  const sshUser = flags.get("ssh-user") ?? env.ONBOARD_NODE_SSH_USER ?? "root";
  // Capacity is optional now: when unset it is derived from the box's measured
  // RAM at onboard time (see deriveCapacityFromMemory), so a big robot box is
  // sized to its real memory rather than the cpx32-era 8-slot default.
  const capacityRaw = flags.get("capacity") ?? env.ONBOARD_NODE_CAPACITY;
  let capacity: number | null = null;
  if (capacityRaw !== undefined) {
    capacity = Number.parseInt(capacityRaw, 10);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 64) {
      throw new Error(`Invalid capacity (must be 1..64): ${capacityRaw}`);
    }
  }

  const tier = parseTier(flags.get("tier") ?? env.ONBOARD_NODE_TIER);

  // Per-node agent memory ceiling (MiB); unset = null = global default. A dense
  // robot-shared node sets this lower so ~100 agents fit its RAM. Bounded to a
  // sane [256, 65536] so a typo can't strand a node with a 0/absurd ceiling.
  const memLimitRaw =
    flags.get("agent-memory-limit-mb") ??
    env.ONBOARD_NODE_AGENT_MEMORY_LIMIT_MB;
  let agentMemoryLimitMb: number | null = null;
  if (memLimitRaw !== undefined) {
    agentMemoryLimitMb = Number.parseInt(memLimitRaw, 10);
    if (
      !Number.isInteger(agentMemoryLimitMb) ||
      agentMemoryLimitMb < 256 ||
      agentMemoryLimitMb > 65536
    ) {
      throw new Error(
        `Invalid agent-memory-limit-mb (must be 256..65536): ${memLimitRaw}`,
      );
    }
  }

  if (!Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535) {
    throw new Error(
      `Invalid ssh-port: ${flags.get("ssh-port") ?? env.ONBOARD_NODE_SSH_PORT}`,
    );
  }

  return {
    host,
    nodeId,
    keyPath,
    sshPort,
    sshUser,
    capacity,
    tier,
    agentMemoryLimitMb,
    dryRun,
  };
}

// ---------------------------------------------------------------------------
// Onboarding flow
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.env);

  // Resolve network/image from config for the preview. `containersEnv` is a
  // light import; the heavier DB/SSH stack is only loaded once we commit to
  // touching the host, so --dry-run stays side-effect-free.
  const { containersEnv } = await import(
    "@elizaos/cloud-shared/lib/config/containers-env"
  );
  const network = containersEnv.dockerNetwork();
  const image = containersEnv.defaultAgentImage();

  console.log(
    `[onboard] target ${args.sshUser}@${args.host}:${args.sshPort} as node "${args.nodeId}"`,
  );
  console.log(
    `[onboard] network=${network} image=${image} tier=${args.tier ?? "robot-shared(new)/preserve"} capacity=${
      args.capacity ?? "derive-from-RAM"
    } agentMemoryLimitMb=${args.agentMemoryLimitMb ?? "global-default"}`,
  );
  if (args.dryRun) {
    console.log("[onboard] --dry-run: no changes will be made.");
    return;
  }

  // Agent memory ceiling this node will apply per container: the per-node
  // --agent-memory-limit-mb when set (a dense robot-shared node runs a lower
  // ceiling), else the global fleet default (#17795). Capacity for a brand-new
  // row is measured RAM / this ceiling, so the node is never licensed for more
  // ceilings than its RAM can hold (the exact budget #18491 admits on) and the
  // derived slot count matches the ceiling that will actually apply.
  const agentCeilingMb =
    args.agentMemoryLimitMb ?? containersEnv.agentContainerMemoryLimitMb();

  const {
    dockerNodesRepository,
    stampDockerNodeEnvironmentMetadata,
    ensureRegistryAccess,
    buildEnsureNetworkCmd,
    shellQuote,
    DockerSSHClient,
    buildEnsureEmbeddingSidecarCmd,
  } = await loadDeps();
  const summary: string[] = [];
  const existing = await dockerNodesRepository.findByNodeId(args.nodeId);

  // Re-onboard must verify against the stored pin before any root SSH command
  // runs. Only a never-pinned node takes the TOFU branch and persists the
  // captured key during the upsert below.
  let capturedFingerprint: string | undefined;
  const ssh = new DockerSSHClient(
    buildOnboardSshConfig(args, existing, async (hostname, fingerprint) => {
      capturedFingerprint = fingerprint;
      console.log(
        `[onboard] TOFU captured host key for ${hostname}: SHA256:${fingerprint}`,
      );
    }),
  );

  try {
    // 0. Measure RAM so a brand-new row's capacity is sized to the box, not the
    //    cpx32-era default. Re-onboards preserve the operator-tuned capacity
    //    (see capacityForOnboardUpsert) regardless of what we measure here.
    let derivedCapacity: number | null = null;
    if (args.capacity === null && !existing) {
      const meminfo = await ssh
        .exec("cat /proc/meminfo", 30_000)
        .catch(() => "");
      const memTotalMb = parseMemTotalMb(meminfo);
      if (memTotalMb !== null && agentCeilingMb > 0) {
        derivedCapacity = deriveCapacityFromMemory(memTotalMb, agentCeilingMb);
        summary.push(
          `capacity ${derivedCapacity} derived from ${memTotalMb} MiB RAM / ${agentCeilingMb} MiB ceiling`,
        );
      } else {
        summary.push("capacity probe failed — falling back to 8-slot default");
      }
    }

    // 1. Docker present + running (install via get.docker.com only if missing).
    const hasDocker = await ssh
      .exec("command -v docker >/dev/null 2>&1 && echo yes || echo no", 30_000)
      .then((out) => out.includes("yes"));
    if (!hasDocker) {
      console.log("[onboard] docker not found — installing via get.docker.com");
      await ssh.exec("curl -fsSL https://get.docker.com | sh", 5 * 60 * 1000);
      summary.push("installed Docker");
    } else {
      summary.push("Docker already present");
    }
    await ssh.exec(
      "systemctl enable --now docker >/dev/null 2>&1 || true",
      60_000,
    );
    await ssh.exec("docker info >/dev/null 2>&1", 30_000);
    summary.push("Docker daemon running");

    // 2. Shared bridge network (idempotent, race-safe).
    await ssh.exec(buildEnsureNetworkCmd(network), 30_000);
    summary.push(`network "${network}" ensured`);

    // 3. THE robot fix: deterministic registry access (clear stale ghcr cred).
    await ensureRegistryAccess(ssh, image);
    summary.push(
      containersEnv.registryToken() || containersEnv.registryTokenFile()
        ? "ghcr login refreshed (token configured)"
        : "ghcr stale creds cleared (anonymous pull)",
    );

    // 4. Reap zombie agent containers (orphaned, non-running). Conservative.
    const psOutput = await ssh.exec(
      "docker ps -a --format '{{.Names}}\t{{.State}}'",
      30_000,
    );
    const zombies = selectZombieAgentContainers(parseDockerPs(psOutput));
    if (zombies.length > 0) {
      await ssh.exec(
        `docker rm -f ${zombies.map(shellQuote).join(" ")}`,
        60_000,
      );
      summary.push(
        `removed ${zombies.length} zombie container(s): ${zombies.join(", ")}`,
      );
    } else {
      summary.push("no zombie containers");
    }

    // 5. Ensure the local-embedding sidecar is running. Non-fatal on failure —
    // the node still registers and the control plane's health loop both
    // surfaces the missing sidecar (docker_nodes metadata) and self-heals it,
    // so a transient pull failure here cannot silently strand the node on the
    // cloud embedding path forever.
    await ssh
      .exec(buildEnsureEmbeddingSidecarCmd(), 10 * 60 * 1000)
      .then(() => summary.push("embedding sidecar ensured"))
      .catch((err) => {
        console.warn(
          `[onboard] embedding sidecar install failed (health loop will surface + self-heal): ${err instanceof Error ? err.message : String(err)}`,
        );
        summary.push(
          "embedding sidecar install FAILED (health loop will self-heal)",
        );
      });

    // 6. Pull the agent image now so the first deploy on this node is warm.
    console.log(
      `[onboard] pre-pulling ${image} (first run can take a few minutes)`,
    );
    await ssh
      .exec(`docker pull ${shellQuote(image)}`, 10 * 60 * 1000)
      .then(() => summary.push("agent image pulled"))
      .catch((err) => {
        console.warn(
          `[onboard] image pre-pull failed (node still registers; will retry on deploy): ${err instanceof Error ? err.message : String(err)}`,
        );
        summary.push("agent image pre-pull FAILED (non-fatal)");
      });

    // Resolve the seed capacity for a NEW row: explicit flag wins, else the
    // RAM-derived value, else the historical 8-slot fallback. Re-onboards ignore
    // this and keep the operator-tuned capacity (capacityForOnboardUpsert).
    const seedCapacity = args.capacity ?? derivedCapacity ?? 8;

    // 7. Register / upsert into docker_nodes — same shape as bootstrap-callback.
    if (existing) {
      await dockerNodesRepository.update(existing.id, {
        hostname: args.host,
        ssh_port: args.sshPort,
        ssh_user: args.sshUser,
        // Preserve an operator-tuned capacity across re-onboards; the seed
        // capacity only sizes a brand-new row (see create branch).
        capacity: capacityForOnboardUpsert(existing, seedCapacity),
        // Tier is operator-owned like capacity: an explicit --tier re-tags it,
        // otherwise the existing class is preserved across re-onboards.
        tier: tierForOnboardUpsert(existing, args.tier),
        // Only re-profile the ceiling when the operator explicitly passed one;
        // an unset flag preserves the node's existing per-node ceiling (omit
        // the key so the partial update leaves it untouched).
        ...(args.agentMemoryLimitMb !== null
          ? { agent_memory_limit_mb: args.agentMemoryLimitMb }
          : {}),
        status: "unknown",
        // Never overwrite an established pin during re-onboard; a differing
        // presented key must fail in DockerSSHClient before this update.
        host_key_fingerprint: hostKeyFingerprintForOnboardUpsert(
          existing,
          capturedFingerprint,
        ),
        metadata: stampDockerNodeEnvironmentMetadata({
          ...((existing.metadata as Record<string, unknown>) ?? {}),
          provider: "operator-onboarded",
          lastOnboardedAt: new Date().toISOString(),
        }),
      });
      summary.push(`docker_nodes row updated (${args.nodeId})`);
    } else {
      await dockerNodesRepository.create({
        node_id: args.nodeId,
        hostname: args.host,
        ssh_port: args.sshPort,
        ssh_user: args.sshUser,
        capacity: seedCapacity,
        tier: tierForOnboardUpsert(null, args.tier),
        // NULL = use the global ceiling; set for a dense robot-shared node.
        agent_memory_limit_mb: args.agentMemoryLimitMb,
        enabled: true,
        status: "unknown",
        allocated_count: 0,
        // Persist the TOFU-captured pin so later control-plane SSH is verified.
        host_key_fingerprint: hostKeyFingerprintForOnboardUpsert(
          null,
          capturedFingerprint,
        ),
        metadata: stampDockerNodeEnvironmentMetadata({
          provider: "operator-onboarded",
          onboardedAt: new Date().toISOString(),
        }),
      });
      summary.push(`docker_nodes row created (${args.nodeId})`);
    }
  } finally {
    // error-policy:J6 best-effort SSH teardown; the onboarding result already stands
    await ssh.disconnect().catch(() => {});
  }

  console.log("\n[onboard] done:");
  for (const line of summary) console.log(`  - ${line}`);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry ? path.resolve(entry) === fileURLToPath(import.meta.url) : false;
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(
      "[onboard] failed:",
      error instanceof Error ? error.message : String(error),
    );
    process.exit(1);
  });
}
