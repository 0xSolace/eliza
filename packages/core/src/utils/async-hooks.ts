/**
 * Runtime-agnostic loader for `node:async_hooks`'s `AsyncLocalStorage`.
 *
 * Several core modules (inference-timing, streaming-context,
 * trajectory-context, action-routing-context, plugin-lifecycle) thread
 * per-turn context through async work and each carried a private
 * `require("node:async_hooks")` with a silent single-slot/stack fallback for
 * browser and edge runtimes. Under ESM execution (`node --import tsx`, plain
 * ESM dist on Node) `require` is not defined, so the `try/catch` swallowed a
 * `ReferenceError` and every one of those modules degraded to the fallback
 * that does NOT propagate across `await` — losing inference-timing spans,
 * trajectory LLM-call attribution, streaming context, and per-action model
 * routing on the exact runtimes they were built for (#see linked fix).
 *
 * This helper resolves the builtin the way Node and Bun both support in every
 * module system: `process.getBuiltinModule` (Node >= 20.16 / 22.3, Bun) first,
 * then a guarded CommonJS `require` for older CJS environments. Browser and
 * edge runtimes still return `null`, and callers keep their explicit degraded
 * implementations for that case.
 */

type AsyncLocalStorageCtor =
	typeof import("node:async_hooks").AsyncLocalStorage;

/** True when running on a Node-compatible runtime (Node, Bun, Electron). */
export function isNodeLikeEnvironment(): boolean {
	return (
		typeof process !== "undefined" &&
		typeof process.versions !== "undefined" &&
		typeof process.versions.node !== "undefined"
	);
}

/**
 * Load the `AsyncLocalStorage` constructor, or `null` when the runtime has no
 * `node:async_hooks` builtin (browser / edge). Never throws.
 */
export function loadAsyncLocalStorage(): AsyncLocalStorageCtor | null {
	if (!isNodeLikeEnvironment()) return null;
	// Preferred path: works in both ESM and CJS on Node >= 20.16 and Bun.
	try {
		if (typeof process.getBuiltinModule === "function") {
			const mod = process.getBuiltinModule("node:async_hooks") as
				| typeof import("node:async_hooks")
				| undefined;
			if (mod?.AsyncLocalStorage) return mod.AsyncLocalStorage;
		}
	} catch {
		// error-policy:J4 fall through to the CJS path below.
	}
	// Legacy CJS path for Node runtimes without `process.getBuiltinModule`.
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const mod = require("node:async_hooks") as
			| typeof import("node:async_hooks")
			| undefined;
		if (mod?.AsyncLocalStorage) return mod.AsyncLocalStorage;
	} catch {
		// error-policy:J4 `require` is not defined in ESM scope and the builtin
		// is unavailable in constrained runtimes; the caller's degraded
		// implementation is the explicit fallback.
	}
	return null;
}
