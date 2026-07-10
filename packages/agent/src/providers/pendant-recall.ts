/**
 * Pendant recall provider — surfaces captured ambient/pendant transcript
 * segments and their structured insights into the agent's per-turn context so
 * the agent can answer "what did I commit to today" / "what did Royce say about
 * the trip" from real captured sessions, WITH provenance.
 *
 * This is gap #2 from OMI-PARITY-GAP-ANALYSIS: the thing Omi structurally
 * cannot copy, because our chat IS a persistent agent with one identity and one
 * memory, not a capped chat bolted onto a transcript database.
 *
 * Design (deliberately honest + simple, no new stores, no new vector DB):
 * - READ path only. It reuses the ONE canonical read helper
 *   (`readOwnerPendantSessions`) for segments and the existing pendant-insights
 *   memory namespace for insights. There is no second store, no cache.
 * - Tenancy: owner is resolved via `resolveCanonicalOwnerIdForMessage` (the
 *   same canonical owner resolver the admin providers use) and agent via
 *   `runtime.agentId`. Both are re-checked on every record. A record from
 *   another owner/agent is structurally unreachable.
 * - Deletion: because it reads the LIVE stores, a cascade-deleted session (and
 *   its insights) is simply absent. No cache can outlive a delete.
 * - Pause: paused/ended sessions remain historically readable (their past
 *   utterances are legitimate memory), but no NEW content can have been written
 *   while paused (`assertCanAppend` refuses appends), so recall never invents
 *   content for a paused window.
 * - Relevance: recency window + BM25 keyword ranking (reuses `rankByKeyword`,
 *   the same lexical ranker `relevant-conversations` uses), no embedding
 *   dependency added. If a shared embed facility is later wanted it can layer
 *   on top; BM25 is the honest floor and works with zero embedding model.
 * - Token budget: the injected block is bounded by a hard character budget and
 *   a max-item cap; most-recent-and-most-relevant win.
 * - Provenance: every surfaced line carries a canonical id
 *   (`<sessionId>:segment:<ordinal>` for segments, the insight memory id for
 *   insights) so the agent can cite when/where something was said.
 *
 * OFF BY DEFAULT. Enable per-agent with `PENDANT_RECALL_ENABLED` (setting or
 * env). This keeps ambient recall opt-in, matching the ambient capture posture.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
  UUID,
} from "@elizaos/core";
import { resolveCanonicalOwnerIdForMessage, stringToUuid } from "@elizaos/core";
import {
  pendantSegmentId,
  type PendantSegment,
  type PendantSessionSnapshot,
} from "@elizaos/shared/contracts";
import { rankByKeyword } from "../api/memory-routes.ts";
import { readOwnerPendantSessions } from "../api/pendant-session-routes.ts";

// ---------------------------------------------------------------------------
// Bounds (all overridable via settings/env; defaults chosen to be cheap + safe)
// ---------------------------------------------------------------------------

/** Only consider content captured within this many days of now. */
const DEFAULT_LOOKBACK_DAYS = 7;
/** Hard cap on total characters injected into the prompt. */
const DEFAULT_MAX_CHARS = 2_400;
/** Max transcript segments surfaced. */
const DEFAULT_MAX_SEGMENTS = 8;
/** Max insight rollups surfaced. */
const DEFAULT_MAX_INSIGHTS = 4;
/** Cap on sessions scanned per turn (newest-first). */
const MAX_SESSIONS_SCANNED = 200;
/**
 * Hard cap on transcript segments fed into BM25 per turn. A session can hold up
 * to 20k segments and a tenant can have many sessions, so without this the
 * ranker could see millions of docs per chat turn. We take the most-recent
 * candidates across all in-window sessions before ranking — recall is
 * recency-biased by design and this bounds per-turn CPU.
 */
const MAX_SEGMENT_CANDIDATES = 1_500;
/** Same bound for insight candidates. */
const MAX_INSIGHT_CANDIDATES = 500;
/** Per-segment snippet cap so one long turn can't eat the whole budget. */
const SEGMENT_SNIPPET_CHARS = 320;
/** Per-insight snippet cap. */
const INSIGHT_SNIPPET_CHARS = 420;
/**
 * BM25 returns a [0,1] max-normalized score. Require a hit to be at least this
 * fraction of the best match; below it, a "match" is stop-word noise. Mirrors
 * relevant-conversations' MIN_HASH_MEMORY_SCORE rationale.
 */
const MIN_RELEVANCE_SCORE = 0.3;
/** Minimum query length before we bother recalling (avoids "hi"-triggered scans). */
const MIN_QUERY_CHARS = 5;

const INSIGHTS_MEMORY_SOURCE = "pendant-insights";
const INSIGHTS_TABLE = "messages";

// ---------------------------------------------------------------------------
// Config resolution (off by default; bounded lookback + token budget)
// ---------------------------------------------------------------------------

function readBooleanSetting(
  runtime: IAgentRuntime,
  key: string,
): boolean | undefined {
  const raw =
    typeof runtime.getSetting === "function" ? runtime.getSetting(key) : null;
  if (raw === true) return true;
  if (raw === false) return false;
  if (typeof raw === "string") {
    const n = raw.trim().toLowerCase();
    if (n === "true" || n === "1" || n === "yes" || n === "on") return true;
    if (n === "false" || n === "0" || n === "no" || n === "off") return false;
  }
  const env = process.env[key];
  if (typeof env === "string" && env.trim().length > 0) {
    const n = env.trim().toLowerCase();
    if (n === "true" || n === "1" || n === "yes" || n === "on") return true;
    if (n === "false" || n === "0" || n === "no" || n === "off") return false;
  }
  return undefined;
}

function readIntSetting(
  runtime: IAgentRuntime,
  key: string,
  fallback: number,
  { min, max }: { min: number; max: number },
): number {
  const raw =
    typeof runtime.getSetting === "function" ? runtime.getSetting(key) : null;
  let value: number | undefined;
  if (typeof raw === "number" && Number.isFinite(raw)) value = raw;
  else if (typeof raw === "string" && /^\d+$/.test(raw.trim()))
    value = Number(raw.trim());
  else {
    const env = process.env[key];
    if (typeof env === "string" && /^\d+$/.test(env.trim()))
      value = Number(env.trim());
  }
  if (value === undefined) value = fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

export interface PendantRecallConfig {
  enabled: boolean;
  lookbackDays: number;
  maxChars: number;
  maxSegments: number;
  maxInsights: number;
}

export function resolvePendantRecallConfig(
  runtime: IAgentRuntime,
): PendantRecallConfig {
  return {
    // Off unless explicitly enabled.
    enabled: readBooleanSetting(runtime, "PENDANT_RECALL_ENABLED") === true,
    lookbackDays: readIntSetting(
      runtime,
      "PENDANT_RECALL_LOOKBACK_DAYS",
      DEFAULT_LOOKBACK_DAYS,
      { min: 1, max: 365 },
    ),
    maxChars: readIntSetting(
      runtime,
      "PENDANT_RECALL_MAX_CHARS",
      DEFAULT_MAX_CHARS,
      { min: 200, max: 20_000 },
    ),
    maxSegments: readIntSetting(
      runtime,
      "PENDANT_RECALL_MAX_SEGMENTS",
      DEFAULT_MAX_SEGMENTS,
      { min: 1, max: 50 },
    ),
    maxInsights: readIntSetting(
      runtime,
      "PENDANT_RECALL_MAX_INSIGHTS",
      DEFAULT_MAX_INSIGHTS,
      { min: 0, max: 20 },
    ),
  };
}

// ---------------------------------------------------------------------------
// Candidate shaping
// ---------------------------------------------------------------------------

interface SegmentCandidate {
  /** Canonical provenance id: `<sessionId>:segment:<ordinal>`. */
  citation: string;
  sessionId: string;
  sessionState: PendantSessionSnapshot["session"]["state"];
  ordinal: number;
  text: string;
  /** ms epoch, for recency ranking + lookback filter. */
  when: number;
  speaker: string | null;
}

interface InsightCandidate {
  /** Canonical provenance id: the insight memory id. */
  citation: string;
  sessionId: string;
  text: string;
  when: number;
  /** Underlying segment citations, for deeper provenance. */
  segmentIds: string[];
}

function segmentWhen(segment: PendantSegment): number {
  const t = Date.parse(segment.endedAt ?? segment.updatedAt ?? segment.createdAt);
  return Number.isFinite(t) ? t : 0;
}

function collectSegmentCandidates(
  snapshots: PendantSessionSnapshot[],
  cutoff: number,
): SegmentCandidate[] {
  const out: SegmentCandidate[] = [];
  for (const snap of snapshots) {
    for (const seg of snap.segments) {
      const text = seg.text.trim();
      // Only resolved, non-empty utterances are recall-worthy. Pending/asr-error
      // segments are not durable content and must not be quoted as fact.
      if (text.length === 0 || seg.status !== "resolved") continue;
      const when = segmentWhen(seg);
      if (when < cutoff) continue;
      out.push({
        citation: pendantSegmentId(snap.session.id, seg.ordinal),
        sessionId: snap.session.id,
        sessionState: snap.session.state,
        ordinal: seg.ordinal,
        text,
        when,
        speaker: seg.speakerAlias ?? seg.speakerCluster ?? null,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Insight reads (owner+agent scoped, live store, deletion-respecting)
// ---------------------------------------------------------------------------

function insightMemoryText(memory: Memory): string {
  return typeof memory.content?.text === "string" ? memory.content.text : "";
}

function metadataRecord(memory: Memory): Record<string, unknown> {
  return memory.metadata && typeof memory.metadata === "object"
    ? (memory.metadata as Record<string, unknown>)
    : {};
}

async function loadInsightCandidates(params: {
  runtime: IAgentRuntime;
  ownerId: string;
  agentId: string;
  cutoff: number;
}): Promise<InsightCandidate[]> {
  if (typeof params.runtime.getMemories !== "function") return [];
  const roomId = stringToUuid(
    `pendant-insights-room:${params.ownerId}:${params.agentId}`,
  ) as UUID;
  let memories: Memory[];
  try {
    memories = await params.runtime.getMemories({
      roomId,
      tableName: INSIGHTS_TABLE,
      limit: 200,
      includeEmbedding: false,
    });
  } catch {
    return [];
  }
  const out: InsightCandidate[] = [];
  for (const memory of memories) {
    const meta = metadataRecord(memory);
    // Re-check tenancy on every record even though the room is owner-scoped.
    if (meta.source !== INSIGHTS_MEMORY_SOURCE) continue;
    if (meta.ownerId !== undefined && meta.ownerId !== params.ownerId) continue;
    if (memory.agentId && String(memory.agentId) !== params.agentId) continue;
    const text = insightMemoryText(memory).trim();
    if (text.length === 0) continue;
    const when =
      typeof memory.createdAt === "number"
        ? memory.createdAt
        : typeof meta.timestamp === "number"
          ? (meta.timestamp as number)
          : 0;
    if (when < params.cutoff) continue;
    const segmentIds = Array.isArray(meta.sourceSegmentIds)
      ? (meta.sourceSegmentIds as unknown[]).filter(
          (id): id is string => typeof id === "string",
        )
      : [];
    out.push({
      citation: memory.id ? String(memory.id) : "pendant-insight",
      sessionId: typeof meta.sessionId === "string" ? meta.sessionId : "",
      text,
      when,
      segmentIds,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Ranking + budgeting
// ---------------------------------------------------------------------------

/** Terms too generic to count as evidence of a real topical match. */
const OVERLAP_STOPWORDS = new Set([
  "about",
  "what",
  "when",
  "where",
  "which",
  "there",
  "their",
  "that",
  "this",
  "they",
  "them",
  "then",
  "with",
  "from",
  "have",
  "here",
  "were",
  "your",
  "said",
  "tell",
  "please",
  "anything",
  "something",
]);

/** Content terms (>=3 chars, not a generic stopword) for overlap gating. */
function contentTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !OVERLAP_STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

/** True when the item shares at least one meaningful content term with the query. */
function sharesContentTerm(queryTerms: Set<string>, text: string): boolean {
  for (const term of contentTerms(text)) {
    if (queryTerms.has(term)) return true;
  }
  return false;
}

/**
 * Rank candidates by relevance (BM25) with a recency tiebreak, drop weak
 * matches, and cap by count. Pure so it is unit-testable in isolation.
 *
 * BM25 max-normalizes to the best hit, so on a tiny corpus (or a single
 * candidate) even a stop-word-only "match" normalizes to 1.0. To keep recall
 * honest we additionally require a real content-term overlap between the query
 * and the candidate — a candidate that shares no meaningful word with the query
 * is dropped regardless of its normalized BM25 score. This is the absolute-
 * overlap floor BM25's IDF cannot provide when the corpus is too small to
 * down-weight common words.
 */
export function rankAndCap<T extends { text: string; when: number }>(
  query: string,
  items: T[],
  maxCount: number,
  minScore = MIN_RELEVANCE_SCORE,
): Array<{ item: T; score: number }> {
  if (items.length === 0 || maxCount <= 0) return [];
  const queryTerms = contentTerms(query);
  if (queryTerms.size === 0) return [];
  const overlapping = items.filter((item) =>
    sharesContentTerm(queryTerms, item.text),
  );
  if (overlapping.length === 0) return [];
  return rankByKeyword(query, overlapping, (i) => i.text)
    .filter(({ score }) => score >= minScore)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.item.when - a.item.when;
    })
    .slice(0, maxCount);
}

function relativeWhen(when: number, now: number): string {
  const diff = Math.max(0, now - when);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}\u2026`;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const pendantRecallProvider: Provider = {
  name: "pendant-recall",
  description:
    "Relevant transcript segments and insights from the user's own captured pendant/ambient sessions, with citations so answers can quote when and where something was said.",
  descriptionCompressed:
    "captured pendant transcript segments + insights relevant to the current message, with citations",
  dynamic: true,
  position: 7,
  // Route into memory/messaging turns (same surface as relevant-conversations);
  // when disabled the provider self-gates to an empty render, so being present
  // in the catalog is cheap.
  contexts: ["memory", "messaging"],
  contextGate: { anyOf: ["memory", "messaging"] },
  cacheStable: false,
  cacheScope: "turn",
  // Do NOT force always-on: recall is opt-in and turn-scoped by relevance.
  roleGate: { minRole: "USER" },
  // Registered by default but GATED at runtime by `PENDANT_RECALL_ENABLED`
  // (resolved in `get()`): when the flag is off the provider self-gates to an
  // empty render — the FACTS/RECENT_ERRORS "cheap empty happy-path" pattern.
  // This keeps enablement a runtime setting (no rebuild) rather than a
  // plugin-load-time skip, so an operator can turn ambient recall on per-agent.

  async get(
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
  ): Promise<ProviderResult> {
    const empty: ProviderResult = { text: "", values: {}, data: {} };

    const config = resolvePendantRecallConfig(runtime);
    if (!config.enabled) return empty;

    const query = typeof message.content?.text === "string"
      ? message.content.text.trim()
      : "";
    if (query.length < MIN_QUERY_CHARS) return empty;

    try {
      const ownerId = await resolveCanonicalOwnerIdForMessage(runtime, message);
      const agentId = String(runtime.agentId ?? "").trim();
      if (!ownerId || !agentId) return empty;

      const now = Date.now();
      const cutoff = now - config.lookbackDays * 24 * 60 * 60 * 1000;

      const snapshots = await readOwnerPendantSessions({
        runtime,
        ownerId,
        agentId,
        limit: MAX_SESSIONS_SCANNED,
      });

      // Recency-cap both candidate pools BEFORE ranking so a heavy tenant
      // cannot blow up per-turn CPU (a session holds up to 20k segments).
      const segmentCandidates = collectSegmentCandidates(snapshots, cutoff)
        .sort((a, b) => b.when - a.when)
        .slice(0, MAX_SEGMENT_CANDIDATES);
      const insightCandidates = (
        await loadInsightCandidates({
          runtime,
          ownerId,
          agentId,
          cutoff,
        })
      )
        .sort((a, b) => b.when - a.when)
        .slice(0, MAX_INSIGHT_CANDIDATES);

      if (segmentCandidates.length === 0 && insightCandidates.length === 0) {
        return empty;
      }

      const rankedSegments = rankAndCap(
        query,
        segmentCandidates,
        config.maxSegments,
      );
      const rankedInsights = rankAndCap(
        query,
        insightCandidates,
        config.maxInsights,
      );

      if (rankedSegments.length === 0 && rankedInsights.length === 0) {
        return empty;
      }

      // Build the bounded, provenance-carrying block. Insights first (denser,
      // already-summarized), then segment quotes; stop when the budget is spent.
      const lines: string[] = [
        "Captured from the user's pendant/ambient sessions (cite the [id] when you reference these):",
      ];
      let used = lines[0].length;
      const citations: string[] = [];

      const pushLine = (line: string): boolean => {
        if (used + line.length + 1 > config.maxChars) return false;
        lines.push(line);
        used += line.length + 1;
        return true;
      };

      let budgetExhausted = false;

      for (const { item } of rankedInsights) {
        const rel = relativeWhen(item.when, now);
        const line = `- insight (${rel}) [${item.citation}]: ${clip(
          item.text,
          INSIGHT_SNIPPET_CHARS,
        )}`;
        if (!pushLine(line)) {
          budgetExhausted = true;
          break;
        }
        citations.push(item.citation);
      }

      if (!budgetExhausted) {
        for (const { item } of rankedSegments) {
          const rel = relativeWhen(item.when, now);
          const who = item.speaker ? `${item.speaker}: ` : "";
          const pausedTag = item.sessionState === "paused" ? " (paused session)" : "";
          const line = `- said ${rel}${pausedTag} [${item.citation}]: ${who}${clip(
            item.text,
            SEGMENT_SNIPPET_CHARS,
          )}`;
          if (!pushLine(line)) {
            budgetExhausted = true;
            break;
          }
          citations.push(item.citation);
        }
      }

      if (citations.length === 0) return empty;

      return {
        text: lines.join("\n"),
        values: {
          pendantRecallSegmentCount: rankedSegments.length,
          pendantRecallInsightCount: rankedInsights.length,
          pendantRecallCitationCount: citations.length,
          pendantRecallBudgetExhausted: budgetExhausted,
        },
        data: {
          citations,
          segments: rankedSegments.map(({ item, score }) => ({
            citation: item.citation,
            sessionId: item.sessionId,
            ordinal: item.ordinal,
            when: item.when,
            score,
          })),
          insights: rankedInsights.map(({ item, score }) => ({
            citation: item.citation,
            sessionId: item.sessionId,
            when: item.when,
            segmentIds: item.segmentIds,
            score,
          })),
        },
      };
    } catch (error) {
      // error-policy:J4 recall failure degrades to no context, surfaced to the
      // agent's error channel rather than reading as "nothing was captured".
      runtime.reportError?.("PendantRecallProvider", error, {
        entityId: message.entityId,
        roomId: message.roomId,
      });
      return empty;
    }
  },
};
