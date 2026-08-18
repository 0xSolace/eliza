import { describe, expect, it } from "bun:test";

import {
	InferenceTurnTimer,
	recordInferenceSpan,
	runWithInferenceTiming,
} from "../../inference-timing";
import {
	getTrajectoryContext,
	runWithTrajectoryContext,
} from "../../trajectory-context";
import { isNodeLikeEnvironment, loadAsyncLocalStorage } from "../async-hooks";

describe("loadAsyncLocalStorage", () => {
	it("resolves the AsyncLocalStorage constructor on Node-like runtimes", () => {
		// The test runner is a Node-like runtime, so the loader must find the
		// builtin. A null here means every context module in core degrades to
		// its non-await-propagating fallback (the ESM `require` regression).
		expect(isNodeLikeEnvironment()).toBe(true);
		const ctor = loadAsyncLocalStorage();
		expect(ctor).not.toBeNull();
		const storage = new (ctor as NonNullable<typeof ctor>)<number>();
		expect(storage.run(7, () => storage.getStore())).toBe(7);
	});

	it("propagates context across await boundaries", async () => {
		const ctor = loadAsyncLocalStorage();
		expect(ctor).not.toBeNull();
		const storage = new (ctor as NonNullable<typeof ctor>)<string>();
		const seen = await storage.run("turn-a", async () => {
			await new Promise((resolve) => setTimeout(resolve, 1));
			return storage.getStore();
		});
		expect(seen).toBe("turn-a");
	});
});

describe("context managers survive await under the module system in use", () => {
	it("inference-timing records spans after an await", async () => {
		// Regression: under ESM execution the previous bare `require` in
		// initContextManager threw ReferenceError and the single-slot fallback
		// dropped every span recorded after the first await — turn summaries
		// showed only `run-started` and totals were unattributable.
		const timer = new InferenceTurnTimer({
			turnId: "als-regression",
			label: "test-turn",
			roomId: null,
			t0EpochMs: Date.now(),
		});
		await runWithInferenceTiming(timer, async () => {
			recordInferenceSpan("pre-await", 1);
			await new Promise((resolve) => setTimeout(resolve, 1));
			recordInferenceSpan("post-await", 2);
		});
		const names = timer.summary().spans.map((s) => s.name);
		expect(names).toContain("pre-await");
		expect(names).toContain("post-await");
	});

	it("trajectory context is visible after an await", async () => {
		const got = await runWithTrajectoryContext(
			{ trajectoryId: "traj-1", stepId: "step-1" },
			async () => {
				await new Promise((resolve) => setTimeout(resolve, 1));
				return getTrajectoryContext();
			},
		);
		expect(got?.trajectoryId).toBe("traj-1");
		expect(got?.stepId).toBe("step-1");
	});
});
