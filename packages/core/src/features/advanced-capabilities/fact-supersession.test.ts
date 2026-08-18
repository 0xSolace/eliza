/**
 * Unit tests for slot-based fact supersession (fact-supersession.ts) and its
 * integration into the reflection fact processor + FACTS provider:
 *
 *  1. Slot conflict detection is structural (canonical slot aliases, same
 *     kind + category, normalized values) and never fires on agreeing or
 *     disjoint fields.
 *  2. applyAddDurable supersedes-then-inserts on a slot conflict instead of
 *     strengthening the stale near-lexical-duplicate (the live bug: "lives in
 *     Brooklyn" strengthened "lives in Denver").
 *  3. applyContradict marks the row superseded immediately, not just queued
 *     for review.
 *  4. The FACTS provider excludes superseded rows from ranking, so the fresh
 *     claim is the only one rendered.
 *
 * Deterministic vi.fn runtimes — no live model, no DB, no embeddings.
 */
import { describe, expect, it, vi } from "vitest";
import type {
	EvaluatorProcessorContext,
	IAgentRuntime,
	Memory,
	UUID,
} from "../../types/index.ts";
import { factMemoryEvaluator } from "./evaluators/reflection-items.ts";
import {
	findFactSlotConflicts,
	isSupersededFact,
} from "./fact-supersession.ts";
import { factsProvider } from "./providers/facts.ts";

const agentId = "00000000-0000-0000-0000-0000000000aa" as UUID;
const entityId = "00000000-0000-0000-0000-0000000000bb" as UUID;
const roomId = "00000000-0000-0000-0000-0000000000cc" as UUID;

function fact(
	id: string,
	text: string,
	metadata: Record<string, unknown>,
	createdAt = Date.now(),
): Memory {
	return {
		id: id as UUID,
		entityId,
		agentId,
		roomId,
		content: { text },
		metadata,
		createdAt,
	};
}

const denverFact = () =>
	fact(
		"00000000-0000-0000-0000-0000000000f1",
		"lives in Denver at Plant Magic",
		{
			kind: "durable",
			category: "identity",
			confidence: 0.9,
			keywords: ["denver", "lives", "plant", "magic"],
			structuredFields: { city: "Denver" },
		},
		Date.now() - 240 * 24 * 60 * 60 * 1000,
	);

describe("findFactSlotConflicts", () => {
	it("detects a conflict across slot aliases (city vs location)", () => {
		const conflicts = findFactSlotConflicts(
			[denverFact()],
			"durable",
			"identity",
			{ location: "Brooklyn" },
		);
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].slot).toBe("location");
		expect(conflicts[0].existingValue).toBe("denver");
		expect(conflicts[0].incomingValue).toBe("brooklyn");
	});

	it("does not conflict when values agree (case-insensitive)", () => {
		expect(
			findFactSlotConflicts([denverFact()], "durable", "identity", {
				city: "DENVER",
			}),
		).toHaveLength(0);
	});

	it("does not conflict across kind or category boundaries", () => {
		expect(
			findFactSlotConflicts([denverFact()], "current", "schedule_context", {
				city: "Brooklyn",
			}),
		).toHaveLength(0);
		expect(
			findFactSlotConflicts([denverFact()], "durable", "life_event", {
				city: "Brooklyn",
			}),
		).toHaveLength(0);
	});

	it("does not conflict on disjoint slots", () => {
		expect(
			findFactSlotConflicts([denverFact()], "durable", "identity", {
				employer: "Strata",
			}),
		).toHaveLength(0);
	});

	it("skips already-superseded candidates", () => {
		const dead = denverFact();
		(dead.metadata as Record<string, unknown>).supersededAt =
			new Date().toISOString();
		expect(
			findFactSlotConflicts([dead], "durable", "identity", {
				city: "Brooklyn",
			}),
		).toHaveLength(0);
	});
});

describe("isSupersededFact", () => {
	it("is false for live facts and true for superseded/contradicted rows", () => {
		expect(isSupersededFact(denverFact())).toBe(false);
		const superseded = denverFact();
		(superseded.metadata as Record<string, unknown>).supersededAt =
			new Date().toISOString();
		expect(isSupersededFact(superseded)).toBe(true);
		const contradicted = denverFact();
		(contradicted.metadata as Record<string, unknown>).verificationStatus =
			"contradicted";
		expect(isSupersededFact(contradicted)).toBe(true);
	});
});

function makeEvaluatorRuntime() {
	let createdMemory: Memory | null = null;
	const createdId = "00000000-0000-0000-0000-0000000000ee" as UUID;
	const updates: Array<{ id: UUID; metadata: Record<string, unknown> }> = [];
	const runtime = {
		agentId,
		createMemory: vi.fn(async (memoryArg: Memory) => {
			createdMemory = { ...memoryArg, id: createdId };
			return createdId;
		}),
		getMemoryById: vi.fn(async () => createdMemory),
		updateMemory: vi.fn(
			async (patch: { id: UUID; metadata: Record<string, unknown> }) => {
				updates.push(patch);
			},
		),
		deleteMemory: vi.fn(async () => undefined),
		useModel: vi.fn(async () => {
			throw new Error("fact evaluator must not request embeddings");
		}),
		queueEmbeddingGeneration: vi.fn(async () => undefined),
		// recordFactCandidate probes runtime.adapter.db; absent db is a no-op.
		adapter: {},
	};
	return {
		runtime: runtime as unknown as IAgentRuntime,
		spies: runtime,
		updates,
		createdId,
	};
}

function processFactOps(
	runtime: IAgentRuntime,
	knownFacts: Memory[],
	output: unknown,
) {
	const processor = factMemoryEvaluator.processors?.[0];
	if (!processor) throw new Error("missing fact processor");
	return processor.process({
		runtime,
		message: {
			id: "00000000-0000-0000-0000-0000000000dd" as UUID,
			entityId,
			agentId,
			roomId,
			content: { text: "i live in brooklyn now" },
			createdAt: Date.now(),
		},
		state: { values: {}, data: {}, text: "" },
		options: {},
		evaluatorName: "factMemory",
		prepared: {
			recentMessages: [],
			existingRelationships: [],
			entities: [],
			knownFacts,
		},
		output,
	} as EvaluatorProcessorContext);
}

describe("applyAddDurable slot supersession", () => {
	it("supersedes the stale slot-conflicting fact and inserts the new one (pre-fix: strengthened the stale fact)", async () => {
		const { runtime, spies, updates, createdId } = makeEvaluatorRuntime();
		const stale = denverFact();

		const result = await processFactOps(runtime, [stale], {
			ops: [
				{
					op: "add_durable",
					claim: "lives in Brooklyn at the Convent",
					category: "identity",
					structured_fields: { city: "Brooklyn" },
					keywords: ["brooklyn", "convent", "lives"],
				},
			],
		});

		// New fact inserted, NOT deduped into the stale one.
		expect(spies.createMemory).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ data: { added: 1, strengthened: 0 } });

		// Stale fact marked superseded, pointing at the replacement.
		const supersedeUpdate = updates.find((u) => u.id === stale.id);
		expect(supersedeUpdate).toBeDefined();
		expect(supersedeUpdate?.metadata).toMatchObject({
			verificationStatus: "contradicted",
			supersededBy: createdId,
		});
		expect(typeof supersedeUpdate?.metadata.supersededAt).toBe("string");
	});

	it("still strengthens genuine duplicates when no slot conflicts", async () => {
		const { runtime, spies } = makeEvaluatorRuntime();
		const existing = denverFact();

		const result = await processFactOps(runtime, [existing], {
			ops: [
				{
					op: "add_durable",
					claim: "lives in Denver at Plant Magic",
					category: "identity",
					structured_fields: { city: "Denver" },
					keywords: ["denver", "lives", "plant", "magic"],
				},
			],
		});

		expect(spies.createMemory).not.toHaveBeenCalled();
		expect(result).toMatchObject({ data: { added: 0, strengthened: 1 } });
	});
});

describe("applyContradict immediate supersession", () => {
	it("marks the contradicted fact superseded, not just review-queued", async () => {
		const { runtime, updates } = makeEvaluatorRuntime();
		const stale = denverFact();

		await processFactOps(runtime, [stale], {
			ops: [
				{
					op: "contradict",
					factId: stale.id,
					proposedText: "lives in Brooklyn now",
					reason: "user said they moved to Brooklyn",
				},
			],
		});

		const supersedeUpdate = updates.find((u) => u.id === stale.id);
		expect(supersedeUpdate).toBeDefined();
		expect(supersedeUpdate?.metadata).toMatchObject({
			verificationStatus: "contradicted",
		});
		expect(typeof supersedeUpdate?.metadata.supersededAt).toBe("string");
	});
});

describe("FACTS provider superseded exclusion", () => {
	function makeProviderRuntime(facts: Memory[]) {
		return {
			agentId,
			character: { name: "Sol", bio: "", system: "" },
			getService: vi.fn(() => null),
			getMemories: vi.fn(
				async (params: { tableName: string; entityId?: UUID }) => {
					if (params.tableName === "messages") {
						return [
							fact("msg-1", "where do i live rn?", {}),
						];
					}
					if (params.tableName === "facts") return facts;
					return [];
				},
			),
			useModel: vi.fn(async () => {
				throw new Error("FACTS provider must not request embeddings");
			}),
		} as unknown as IAgentRuntime;
	}

	it("renders only the live fact once the stale one is superseded (pre-fix: stale outranked fresh)", async () => {
		const stale = denverFact();
		(stale.metadata as Record<string, unknown>).supersededAt =
			new Date().toISOString();
		(stale.metadata as Record<string, unknown>).verificationStatus =
			"contradicted";
		const fresh = fact(
			"00000000-0000-0000-0000-0000000000f2",
			"lives in Brooklyn at the Convent for the Ronvent residency",
			{
				kind: "durable",
				category: "identity",
				confidence: 0.7,
				keywords: ["brooklyn", "convent", "lives", "ronvent"],
				structuredFields: { city: "Brooklyn" },
			},
		);

		const runtime = makeProviderRuntime([stale, fresh]);
		const result = await factsProvider.get(
			runtime,
			{
				id: "00000000-0000-0000-0000-0000000000d2" as UUID,
				entityId,
				agentId,
				roomId,
				content: { text: "where do i live rn?", senderName: "Shadow" },
				createdAt: Date.now(),
			},
			{ values: {}, data: {}, text: "" },
		);

		expect(result.text).toContain("Brooklyn");
		expect(result.text).not.toContain("Denver");
	});
});
