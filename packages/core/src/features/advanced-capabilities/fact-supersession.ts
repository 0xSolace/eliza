/**
 * Slot-based supersession for the two-store fact memory model.
 *
 * A durable fact like "lives in Denver" occupies a SLOT (location) that only
 * one value can hold at a time. When a newer extraction claims a DIFFERENT
 * value for the same slot ("lives in Brooklyn"), the older fact is not a
 * duplicate to strengthen and not merely a candidate for human review — it is
 * superseded, and must stop surfacing in the FACTS provider immediately.
 *
 * Without this, the lexical dedupe in reflection-items treats "lives in
 * Brooklyn" as a near-duplicate of "lives in Denver" (shared terms: lives,
 * identity, location → similarity ≈ 0.7, well over the 0.42 threshold) and
 * STRENGTHENS the stale fact, so telling the agent you moved makes it more
 * confident about your old city. Observed live on an 8-month corpus.
 *
 * Detection is structural, not lexical: the extractor already emits
 * `structured_fields` with a finite key set (location/city/homeCity/…,
 * employer/company/…), so a conflict is "same kind + same category + same
 * canonical slot + different normalized value". Purely local — no model call,
 * no embeddings, no DB round-trip beyond the candidate pool the caller
 * already fetched.
 *
 * Superseded facts carry `supersededAt` (+ `supersededBy` when a replacement
 * row exists) and `verificationStatus: "contradicted"` in metadata. The FACTS
 * provider and the evaluator's known-fact pools exclude them via
 * {@link isSupersededFact}; rows are kept (not deleted) as an audit trail and
 * for the fact-candidates review UI.
 */
import type { FactKind, FactMetadata, Memory } from "../../types/index.ts";

/**
 * Alias groups: structured-field keys that name the same real-world slot.
 * Mirrors the key aliases the extractor schema advertises
 * (reflection-items.ts `structuredFieldProperties`). Keys not listed here are
 * their own slot.
 */
const SLOT_ALIAS_GROUPS: string[][] = [
	["location", "city", "homeCity", "home_location"],
	["company", "organization", "employer"],
	["timezone", "timeZone", "ianaTimezone"],
	["relationshipStatus", "status"],
	["partnerName", "partner", "spouse"],
	["preferredName", "name"],
];

const SLOT_CANONICAL = new Map<string, string>();
for (const group of SLOT_ALIAS_GROUPS) {
	const canonical = group[0];
	for (const key of group) SLOT_CANONICAL.set(key.toLowerCase(), canonical);
}

function canonicalSlot(key: string): string {
	return SLOT_CANONICAL.get(key.toLowerCase()) ?? key.toLowerCase();
}

function normalizeSlotValue(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim().toLowerCase();
	return normalized.length > 0 ? normalized : null;
}

function readFactMetadata(memory: Memory): FactMetadata {
	const meta = memory.metadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
	return meta as FactMetadata;
}

function readFactKind(memory: Memory): FactKind {
	return readFactMetadata(memory).kind === "current" ? "current" : "durable";
}

function readFactCategory(memory: Memory): string {
	const category = readFactMetadata(memory).category;
	return typeof category === "string" && category.length > 0
		? category
		: "uncategorized";
}

/**
 * Canonical slot → normalized value map for a structured-fields record.
 * Non-string and empty values are skipped; when two alias keys are present
 * the first non-empty value wins.
 */
function slotValues(
	structuredFields: Record<string, unknown> | undefined,
): Map<string, string> {
	const slots = new Map<string, string>();
	if (!structuredFields || typeof structuredFields !== "object") return slots;
	for (const [key, raw] of Object.entries(structuredFields)) {
		const value = normalizeSlotValue(raw);
		if (value === null) continue;
		const slot = canonicalSlot(key);
		if (!slots.has(slot)) slots.set(slot, value);
	}
	return slots;
}

export interface FactSlotConflict {
	memory: Memory;
	slot: string;
	existingValue: string;
	incomingValue: string;
}

/**
 * Find candidate facts whose stored structured fields disagree with the
 * incoming fact on at least one shared slot. Scoped to the same kind and
 * category, so a `current.schedule_context` mention of a city never
 * supersedes a `durable.identity` home. Facts already superseded are skipped
 * (they are out of play).
 *
 * Conservative on purpose: no shared slot, or shared slots that agree, is NOT
 * a conflict — the caller falls through to the existing dedupe/strengthen
 * path. Legacy facts without structured fields are handled by the extractor's
 * `contradict` op instead (it sees them with IDs in the known-facts list).
 */
export function findFactSlotConflicts(
	candidates: Memory[],
	kind: FactKind,
	category: string,
	structuredFields: Record<string, unknown>,
): FactSlotConflict[] {
	const incoming = slotValues(structuredFields);
	if (incoming.size === 0) return [];
	const conflicts: FactSlotConflict[] = [];
	for (const memory of candidates) {
		if (isSupersededFact(memory)) continue;
		if (readFactKind(memory) !== kind) continue;
		if (readFactCategory(memory) !== category) continue;
		const existing = slotValues(
			readFactMetadata(memory).structuredFields as
				| Record<string, unknown>
				| undefined,
		);
		for (const [slot, incomingValue] of incoming) {
			const existingValue = existing.get(slot);
			if (existingValue === undefined) continue;
			if (existingValue === incomingValue) continue;
			conflicts.push({ memory, slot, existingValue, incomingValue });
			break;
		}
	}
	return conflicts;
}

/**
 * True when a fact row has been superseded by a newer claim about the same
 * slot (or explicitly contradicted). Superseded rows are excluded from the
 * FACTS provider render pool and from the evaluator's known-facts pools so a
 * re-stated truth re-inserts cleanly instead of strengthening a dead row.
 */
export function isSupersededFact(memory: Memory): boolean {
	const meta = readFactMetadata(memory) as Record<string, unknown>;
	if (typeof meta.supersededAt === "string" && meta.supersededAt.length > 0) {
		return true;
	}
	if (typeof meta.supersededBy === "string" && meta.supersededBy.length > 0) {
		return true;
	}
	return meta.verificationStatus === "contradicted";
}
